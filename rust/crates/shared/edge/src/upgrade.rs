//! 노드 포트 위의 HTTP Upgrade (PEER_CHAT_SRS FR-PCH-8). 채팅·간선 연결이 쓴다.

use bytes::Bytes;
use dm_gocompat::strconv::quote;
use http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::Empty;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;

use crate::client::{
    CallError, Client, REQUEST_TIMEOUT, Target, classify, host_port, read_limited, remote_failure,
    unreachable,
};
use crate::config::equal_fold;

/// 바꾼 연결이다. 응답 머리 뒤에 이미 읽힌 바이트를 잃지 않는다.
pub type Upgraded = TokioIo<hyper::upgrade::Upgraded>;

const USER_AGENT: &str = "Go-http-client/1.1";
const DEADLINE_EXCEEDED: &str = "context deadline exceeded";

impl Client {
    /// t 의 path 에 `Upgrade: proto` 로 GET 하고, 101 이면 바뀐 연결을 준다. 그 밖의 응답은
    /// [`Client::call`] 과 같은 오류다.
    pub async fn upgrade(
        &self,
        t: &Target,
        path: &str,
        proto: &str,
    ) -> Result<Upgraded, CallError> {
        match tokio::time::timeout(REQUEST_TIMEOUT, self.upgrade_inner(t, path, proto)).await {
            Ok(r) => r,
            Err(_) => Err(unreachable(None, DEADLINE_EXCEEDED)),
        }
    }

    async fn upgrade_inner(
        &self,
        t: &Target,
        path: &str,
        proto: &str,
    ) -> Result<Upgraded, CallError> {
        let hp = host_port(&t.addr, t.port);
        let tls = self.connect(t, &hp, None).await?;
        let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
            .title_case_headers(true)
            .handshake::<_, Empty<Bytes>>(TokioIo::new(tls))
            .await
            .map_err(|e| classify(None, &e))?;
        tokio::spawn(conn.with_upgrades());
        let req = Request::get(path)
            .header(header::HOST, &hp)
            .header(header::USER_AGENT, USER_AGENT)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, proto)
            .body(Empty::new())
            .map_err(|e| unreachable(None, &e.to_string()))?;
        let mut resp = sender
            .send_request(req)
            .await
            .map_err(|e| classify(None, &e))?;
        if resp.status() != StatusCode::SWITCHING_PROTOCOLS {
            let status = resp.status();
            let body = read_limited(resp.into_body()).await.unwrap_or_default();
            return Err(remote_failure(status, &body));
        }
        let got = header_str(resp.headers(), header::UPGRADE);
        if !equal_fold(&got, proto) {
            return Err(unreachable(None, &format!("upgrade {}", quote(&got))));
        }
        let up = hyper::upgrade::on(&mut resp)
            .await
            .map_err(|e| classify(None, &e))?;
        Ok(TokioIo::new(up))
    }
}

fn header_str(h: &HeaderMap, k: header::HeaderName) -> String {
    h.get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// 101 을 보낸 뒤 바뀐 연결을 기다리는 자리다.
pub struct PendingUpgrade(OnUpgrade);

impl PendingUpgrade {
    /// 응답(101)이 나간 뒤의 연결이다.
    pub async fn conn(self) -> Result<Upgraded, hyper::Error> {
        self.0.await.map(TokioIo::new)
    }
}

/// 요청이 `Upgrade: proto` 의 GET 이면 101 응답과 바뀔 연결을 준다. 핸들러는 그 응답을 돌려주고
/// 연결을 기다린다. 아니면 400 `bad_request` 응답(`Connection: close`)과 `None` 이다.
pub fn accept_upgrade<B>(
    req: &mut Request<B>,
    proto: &str,
) -> (dm_shared_httpresp::Response, Option<PendingUpgrade>) {
    let value = header::HeaderValue::from_str(proto).ok();
    let Some(value) = value.filter(|_| {
        req.method() == Method::GET
            && header_has_token(req.headers(), header::CONNECTION, "upgrade")
            && equal_fold(&header_str(req.headers(), header::UPGRADE), proto)
    }) else {
        let mut resp = dm_shared_httpresp::fail_code(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "upgrade required",
        );
        resp.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
        return (resp, None);
    };
    let on = hyper::upgrade::on(&mut *req);
    let mut resp = http::Response::new(dm_shared_httpresp::empty());
    *resp.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    resp.headers_mut().insert(
        header::CONNECTION,
        header::HeaderValue::from_static("Upgrade"),
    );
    resp.headers_mut().insert(header::UPGRADE, value);
    (resp, Some(PendingUpgrade(on)))
}

fn header_has_token(h: &HeaderMap, key: header::HeaderName, token: &str) -> bool {
    h.get_all(key)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|p| equal_fold(p.trim_matches(char::is_whitespace), token))
}
