//! Bot API 호출 (TELEGRAM_BRIDGE_SRS). 오류 문구에 token 을 싣지 않는다 (FR-TGB-3).

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Bot API 의 주소다. 시험은 가짜 서버로 바꾼다 (§5).
pub const DEFAULT_BASE_URL: &str = "https://api.telegram.org";

/// 응답 본문의 상한.
const MAX_RESPONSE: usize = 4 << 20;

/// getUpdates long polling 의 대기. Bot API 는 초 단위 정수를 받는다.
pub(crate) const POLL_TIMEOUT: Duration = Duration::from_secs(50);
/// HTTP 클라이언트의 시한 — 서버가 POLL_TIMEOUT 을 채우고 답하는 시간에 여유를 더한다.
const POLL_CLIENT_TIMEOUT: Duration = Duration::from_secs(50 + 20);
/// Go net/http 기본 클라이언트의 User-Agent.
const USER_AGENT: &str = "Go-http-client/1.1";

/// Bot API 가 ok=false 로 답한 것.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub code: i64,
    pub description: String,
    /// 429 의 기다릴 초.
    pub retry_after: i64,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "telegram {}: {}", self.code, self.description)
    }
}

/// 호출 오류. 문구는 Go 와 같다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Api(ApiError),
    Other(String),
}

impl Error {
    pub fn api(&self) -> Option<&ApiError> {
        match self {
            Error::Api(a) => Some(a),
            Error::Other(_) => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Api(a) => a.fmt(f),
            Error::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for Error {}

/// 모든 Client 가 함께 쓰는 연결 — Go 의 DefaultTransport 처럼 연결을 다시 쓴다.
fn shared_http() -> Result<&'static reqwest::Client, String> {
    static HTTP: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    HTTP.get_or_init(|| {
        // 이미 깔려 있으면 Err 다 — 그것을 쓰면 된다.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .timeout(POLL_CLIENT_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| e.without_url().to_string())
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// reqwest 오류의 사슬. URL(=token)은 싣지 않는다.
fn transport_text(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(c) = src {
        s.push_str(": ");
        s.push_str(&c.to_string());
        src = c.source();
    }
    s
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Params {
    retry_after: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Envelope {
    ok: bool,
    result: Option<RawMessage>,
    error_code: i64,
    description: String,
    parameters: Params,
}

/// Bot API 호출.
#[derive(Clone)]
pub struct Client {
    base: String,
    token: String,
}

impl Client {
    /// base 가 비면 Bot API 주소다.
    pub fn new(base: &str, token: &str) -> Self {
        let base = if base.is_empty() {
            DEFAULT_BASE_URL
        } else {
            base
        };
        Client {
            base: base.to_owned(),
            token: token.to_owned(),
        }
    }

    /// method 를 JSON 본문으로 부르고 result 를 돌려준다. params 가 None 이면 `{}` 다.
    async fn call_raw(
        &self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Option<RawMessage>, Error> {
        let empty = Value::Object(serde_json::Map::new());
        let body = json::marshal(params.unwrap_or(&empty))
            .map_err(|e| Error::Other(format!("telegram {method}: {e}")))?;
        let url = format!("{}/bot{}/{}", self.base, self.token, method);
        let build_err = || Error::Other(format!("telegram {method}: 요청을 만들지 못했다"));
        let url = reqwest::Url::parse(&url).map_err(|_| build_err())?;
        let http = shared_http().map_err(|_| build_err())?;
        let mut res = http
            .post(url)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| Error::Other(format!("telegram {method}: {}", transport_text(e))))?;
        let status = res.status().as_u16();
        let mut raw = Vec::new();
        loop {
            match res.chunk().await {
                Ok(Some(c)) => {
                    let room = MAX_RESPONSE - raw.len();
                    raw.extend_from_slice(&c[..c.len().min(room)]);
                    if raw.len() >= MAX_RESPONSE {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(Error::Other(format!(
                        "telegram {method}: 응답을 읽지 못했다: {}",
                        transport_text(e)
                    )));
                }
            }
        }
        let env: Envelope = json::unmarshal(&raw).map_err(|_| {
            Error::Other(format!(
                "telegram {method}: 응답이 JSON 이 아니다 (HTTP {status})"
            ))
        })?;
        if !env.ok {
            let code = if env.error_code == 0 {
                i64::from(status)
            } else {
                env.error_code
            };
            return Err(Error::Api(ApiError {
                code,
                description: env.description,
                retry_after: env.parameters.retry_after,
            }));
        }
        Ok(env.result)
    }

    /// 결과를 버리는 호출.
    pub async fn call_discard(&self, method: &str, params: Option<&Value>) -> Result<(), Error> {
        self.call_raw(method, params).await.map(|_| ())
    }

    /// 결과를 T 로 읽는 호출.
    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<T, Error> {
        let raw = self.call_raw(method, params).await?;
        let bytes = raw.as_ref().map(|r| r.0.as_slice()).unwrap_or_default();
        json::unmarshal(bytes)
            .map_err(|e| Error::Other(format!("telegram {method}: 결과를 읽지 못했다: {e}")))
    }

    pub async fn get_me(&self) -> Result<User, Error> {
        self.call("getMe", None).await
    }

    /// long polling (NFR-TGB-3). timeout_sec 이 0 이면 바로 돌아온다.
    pub async fn get_updates(&self, offset: i64, timeout_sec: i64) -> Result<Vec<Update>, Error> {
        let p = serde_json::json!({
            "offset": offset,
            "timeout": timeout_sec,
            "allowed_updates": ["message", "callback_query"],
        });
        let ups: Option<Vec<Update>> = self.call("getUpdates", Some(&p)).await?;
        Ok(ups.unwrap_or_default())
    }
}

/// 시한 안에 끝나지 않으면 Go 의 context 시한 초과와 같은 문구다.
pub(crate) async fn with_deadline<T>(
    method: &str,
    d: Duration,
    f: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    match tokio::time::timeout(d, f).await {
        Ok(r) => r,
        Err(_) => Err(Error::Other(format!(
            "telegram {method}: context deadline exceeded"
        ))),
    }
}

/// Bot API 의 User 중 쓰는 것.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename = "telegram.User")]
pub struct User {
    pub id: i64,
    pub is_bot: bool,
    pub username: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename = "telegram.Chat")]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

/// Bot API 의 Message 중 쓰는 것.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename = "telegram.Message")]
pub struct Message {
    pub message_id: i64,
    pub from: Option<User>,
    pub chat: Chat,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename = "telegram.CallbackQuery")]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    pub message: Option<Message>,
    pub data: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename = "telegram.Update")]
pub struct Update {
    pub update_id: i64,
    pub message: Option<Message>,
    pub callback_query: Option<CallbackQuery>,
}
