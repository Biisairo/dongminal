//! 다른 노드의 노드 포트를 부르는 클라이언트 (FR-PNW-22·40·42·74, D-7).

use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use dm_gocompat::json;
use dm_gocompat::oserr::{go_error_string, syscall_error};
use dm_gocompat::strconv::quote;
use http::{Request, StatusCode, header};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::identity::Identity;
use crate::tls::{client_config, find_tls_error, is_fingerprint_mismatch};

/// TCP 연결과 TLS 핸드셰이크 각각의 시한이다.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
/// 요청 하나 전체의 시한이다.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 상대가 정한 오류 코드·문장의 바이트 상한이다.
pub const REMOTE_MESSAGE_MAX: usize = 512;
const MAX_RESPONSE_BYTES: usize = 1 << 20;
const USER_AGENT: &str = "Go-http-client/1.1";
const CONTENT_TYPE_JSON: &str = "application/json";
const DEADLINE_EXCEEDED: &str =
    "context deadline exceeded (Client.Timeout exceeded while awaiting headers)";
const TLS_HANDSHAKE_TIMEOUT: &str = "net/http: TLS handshake timeout";

/// 노드 포트로 이어지는 바이트 흐름이다.
pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin + 'static {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> Stream for T {}

pub type BoxStream = Box<dyn Stream>;
pub type DialFuture = Pin<Box<dyn Future<Output = io::Result<BoxStream>> + Send>>;
/// `host:port` 에 잇는 함수다. 오류 문구는 그대로 [`CallError::Unreachable`] 에 실린다.
pub type Dial = Arc<dyn Fn(String) -> DialFuture + Send + Sync>;

/// 부를 노드다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Target {
    pub addr: String,
    pub port: i64,
    pub fingerprint: String,
}

/// 상대가 `{code,message}` 로 거절했다 (FR-PNW-42).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "상대 노드가 거절했습니다 ({} {}): {}",
            self.status, self.code, self.message
        )
    }
}

/// 부르기의 실패다. `Display` 는 Go 의 오류 문구와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// 상대 노드의 지문이 기대와 다르다. 아무것도 보내지 않았다.
    FingerprintMismatch,
    /// 상대가 TLS 단계에서 이 노드를 받지 않았다.
    Rejected,
    /// 상대에 닿지 못했다. 값은 Go 오류 문구 꼴의 사유다.
    Unreachable(String),
    Remote(RemoteError),
    /// 요청을 JSON 으로 만들거나 응답을 읽지 못했다.
    Json(String),
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CallError::FingerprintMismatch => f.write_str("상대 노드의 지문이 기대와 다릅니다"),
            CallError::Rejected => f.write_str("상대 노드가 이 노드를 받지 않았습니다"),
            CallError::Unreachable(d) => write!(f, "상대 노드에 닿지 못했습니다: {d}"),
            CallError::Remote(e) => e.fmt(f),
            CallError::Json(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for CallError {}

/// 이 노드의 신원으로 다른 노드를 부른다.
#[derive(Clone)]
pub struct Client {
    id: Identity,
    dial: Dial,
}

impl Client {
    pub fn new(id: Identity) -> Self {
        Self {
            id,
            dial: Arc::new(default_dial),
        }
    }

    /// TCP 대신 dial 로 잇는 클라이언트다 (데몬의 dial.sock 등).
    pub fn via(id: Identity, dial: Dial) -> Self {
        Self { id, dial }
    }

    /// t 의 path 에 input 을 JSON 으로 POST 하고 2xx 응답을 out 으로 읽는다.
    pub async fn call<I: Serialize + ?Sized, O: DeserializeOwned>(
        &self,
        t: &Target,
        path: &str,
        input: &I,
    ) -> Result<O, CallError> {
        let raw = self.call_raw(t, path, input).await?;
        json::unmarshal(&raw).map_err(|e| CallError::Json(e.to_string()))
    }

    /// [`Client::call`] 과 같되 2xx 본문을 읽지 않고 그대로 준다.
    pub async fn call_raw<I: Serialize + ?Sized>(
        &self,
        t: &Target,
        path: &str,
        input: &I,
    ) -> Result<Bytes, CallError> {
        let body = json::marshal(input).map_err(|e| CallError::Json(e.to_string()))?;
        let hp = host_port(&t.addr, t.port);
        let url = format!("https://{hp}{path}");
        match tokio::time::timeout(REQUEST_TIMEOUT, self.post(t, &hp, &url, path, body)).await {
            Ok(r) => r,
            Err(_) => Err(unreachable(Some(&url), DEADLINE_EXCEEDED)),
        }
    }

    async fn post(
        &self,
        t: &Target,
        hp: &str,
        url: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<Bytes, CallError> {
        let tls = self.connect(t, hp, Some(url)).await?;
        let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
            .title_case_headers(true)
            .handshake::<_, Full<Bytes>>(TokioIo::new(tls))
            .await
            .map_err(|e| classify(Some(url), &e))?;
        tokio::spawn(conn);
        let req = Request::post(path)
            .header(header::HOST, hp)
            .header(header::USER_AGENT, USER_AGENT)
            .header(header::CONTENT_TYPE, CONTENT_TYPE_JSON)
            .header(header::CONNECTION, "close")
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| unreachable(Some(url), &e.to_string()))?;
        let resp = sender
            .send_request(req)
            .await
            .map_err(|e| classify(Some(url), &e))?;
        let status = resp.status();
        let raw = read_limited(resp.into_body())
            .await
            .map_err(|e| CallError::Unreachable(e.to_string()))?;
        if !status.is_success() {
            return Err(remote_failure(status, &raw));
        }
        Ok(raw)
    }

    /// TCP 와 TLS 를 잇는다. url 이 있으면 오류 사유를 Go `*url.Error` 꼴로 감싼다.
    pub(crate) async fn connect(
        &self,
        t: &Target,
        hp: &str,
        url: Option<&str>,
    ) -> Result<TlsStream<BoxStream>, CallError> {
        let raw = (self.dial)(hp.to_string())
            .await
            .map_err(|e| unreachable(url, &e.to_string()))?;
        let cfg = client_config(&self.id, &t.fingerprint)
            .map_err(|e| unreachable(url, &e.to_string()))?;
        let name =
            ServerName::try_from(t.addr.clone()).map_err(|e| unreachable(url, &e.to_string()))?;
        match tokio::time::timeout(DIAL_TIMEOUT, TlsConnector::from(cfg).connect(name, raw)).await {
            Err(_) => Err(unreachable(url, TLS_HANDSHAKE_TIMEOUT)),
            Ok(Err(e)) => Err(classify(url, &e)),
            Ok(Ok(s)) => Ok(s),
        }
    }
}

fn default_dial(addr: String) -> DialFuture {
    Box::pin(async move {
        match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(addr.as_str())).await {
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("dial tcp {addr}: i/o timeout"),
            )),
            Ok(Err(e)) => {
                let kind = e.kind();
                Err(io::Error::new(
                    kind,
                    format!(
                        "dial tcp {addr}: {}",
                        go_error_string(&syscall_error("connect", e))
                    ),
                ))
            }
            Ok(Ok(s)) => Ok(Box::new(s) as BoxStream),
        }
    })
}

/// Go `net.JoinHostPort`.
pub(crate) fn host_port(addr: &str, port: i64) -> String {
    if addr.contains(':') {
        format!("[{addr}]:{port}")
    } else {
        format!("{addr}:{port}")
    }
}

/// 닿지 못한 사유다. url 이 있으면 Go `*url.Error` 꼴(`Post "<url>": <사유>`)이다.
/// 사유 문구의 Go 형식은 이슈 1.6(Go 형식 HTTP 클라이언트 오류)이 끝나면 그 도구로 바꾼다.
pub(crate) fn unreachable(url: Option<&str>, cause: &str) -> CallError {
    match url {
        Some(u) => CallError::Unreachable(format!("Post {}: {cause}", quote(u))),
        None => CallError::Unreachable(cause.to_string()),
    }
}

/// TLS 오류를 가른다: 지문 불일치, 상대의 거절(경보 수신), 그 밖은 닿지 못함이다.
pub(crate) fn classify(url: Option<&str>, e: &(dyn std::error::Error + 'static)) -> CallError {
    if let Some(t) = find_tls_error(e) {
        if is_fingerprint_mismatch(t) {
            return CallError::FingerprintMismatch;
        }
        if matches!(t, rustls::Error::AlertReceived(_)) {
            return CallError::Rejected;
        }
    }
    unreachable(url, &e.to_string())
}

/// 응답 본문을 상한까지 읽는다. 넘는 부분은 버린다.
pub(crate) async fn read_limited(mut body: Incoming) -> Result<Bytes, hyper::Error> {
    let mut out = Vec::new();
    while out.len() < MAX_RESPONSE_BYTES {
        let Some(frame) = body.frame().await else {
            break;
        };
        if let Ok(data) = frame?.into_data() {
            let room = MAX_RESPONSE_BYTES - out.len();
            out.extend_from_slice(&data[..data.len().min(room)]);
        }
    }
    Ok(Bytes::from(out))
}

fn clean_message(s: &str) -> String {
    dm_shared_termtext::cut(&dm_shared_termtext::strip(s), REMOTE_MESSAGE_MAX).to_string()
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct CodeBody {
    code: String,
    message: String,
}

/// 2xx 가 아닌 응답이다. `{code,message}` 가 아니면 403 은 거절, 그 밖은 본문을 문장으로 쓴다.
pub(crate) fn remote_failure(status: StatusCode, raw: &[u8]) -> CallError {
    let status = status.as_u16();
    match json::unmarshal::<CodeBody>(raw) {
        Ok(b) if !b.code.is_empty() => CallError::Remote(RemoteError {
            status,
            code: clean_message(&b.code),
            message: clean_message(&b.message),
        }),
        _ if status == StatusCode::FORBIDDEN.as_u16() => CallError::Rejected,
        _ => CallError::Remote(RemoteError {
            status,
            code: String::new(),
            message: dm_shared_termtext::cut(
                &dm_shared_termtext::strip_bytes(raw),
                REMOTE_MESSAGE_MAX,
            )
            .to_string(),
        }),
    }
}
