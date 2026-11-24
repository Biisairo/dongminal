//! 서버 수명 (Go `server.go` 의 `Run`·`boundAddr` 와 `http.Server` 가 하던 요청 검사).

use std::io;
use std::sync::Arc;
use std::time::Duration;

use http::{HeaderValue, Method, StatusCode, Version, header};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::warnf;
use otter_shared_serverconf as serverconf;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::diag_snapshot::DIAG_SNAPSHOT_EVERY;
use crate::netx::split_host_port;
use crate::rebind::Rebinder;

/// 종료 시 진행 중인 요청에 주는 시간이다. 오래 사는 SSE·WS 는 그 뒤 끊는다 (FR-RQG-19).
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// `http.Server` 의 두 시한이다 (REQUEST_GATE_SRS FR-RQG-18). 전역 읽기·쓰기 시한은 두지 않는다 —
/// SSE·WebSocket·대기 종단이 그 시각에 끊긴다.
pub(crate) const READ_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Go `r.Host`: 절대 형식 요청 대상이면 그 authority, 아니면 `Host` 머리다.
pub(crate) fn request_host<B>(req: &http::Request<B>) -> String {
    if let Some(a) = req.uri().authority() {
        return a.as_str().to_owned();
    }
    req.headers()
        .get(header::HOST)
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .unwrap_or_default()
}

/// Go `httpguts.ValidHostHeader`.
pub(crate) fn valid_host_header(h: &[u8]) -> bool {
    h.iter().all(|&c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                b'!' | b'$'
                    | b'%'
                    | b'&'
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b'-'
                    | b'.'
                    | b':'
                    | b';'
                    | b'='
                    | b'['
                    | b'\''
                    | b']'
                    | b'_'
                    | b'~'
            )
    })
}

fn trim_ows(b: &[u8]) -> &[u8] {
    let ws = |c: &u8| matches!(c, b' ' | b'\t');
    let start = b.iter().position(|c| !ws(c)).unwrap_or(b.len());
    let end = b.iter().rposition(|c| !ws(c)).map_or(start, |i| i + 1);
    &b[start..end]
}

/// Go 서버가 요청을 읽다 실패했을 때의 400 이다. `text` 가 있으면 상태 줄과 본문에 사유가 붙는다
/// (Go `statusError`).
fn bad_request(text: &str) -> Response {
    let body = if text.is_empty() {
        "400 Bad Request".to_owned()
    } else {
        format!("400 Bad Request: {text}")
    };
    let mut res = Response::new(httpresp::full(body));
    *res.status_mut() = StatusCode::BAD_REQUEST;
    if !text.is_empty()
        && let Ok(r) = hyper::ext::ReasonPhrase::try_from(format!("Bad Request: {text}"))
    {
        res.extensions_mut().insert(r);
    }
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(httpresp::CONTENT_TYPE_TEXT),
    );
    h.insert(header::CONNECTION, HeaderValue::from_static("close"));
    res
}

/// Go `http.Server` 가 처리기 전에 하는 `Host` 검사다. 통과하면 `None`.
pub(crate) fn host_check<B>(req: &http::Request<B>) -> Option<Response> {
    let hosts: Vec<&HeaderValue> = req.headers().get_all(header::HOST).iter().collect();
    if hosts.len() > 1 {
        // Go `too many Host headers` 는 statusError 가 아니라 사유 없는 400 이다.
        return Some(bad_request(""));
    }
    if req.version() >= Version::HTTP_11 && hosts.is_empty() && req.method() != Method::CONNECT {
        return Some(bad_request("missing required Host header"));
    }
    if let [h] = hosts.as_slice()
        && !valid_host_header(trim_ows(h.as_bytes()))
    {
        return Some(bad_request("malformed Host header"));
    }
    None
}

/// 주소 파일에 쓸 `host:port` 다. 호스트는 요청한 바인드 그대로, 포트는 실제로 잡힌 것이다.
pub(crate) fn bound_addr(addr: &str, ln: &std::net::TcpListener) -> String {
    let host = split_host_port(addr).map_or("", |(h, _)| h);
    match ln.local_addr() {
        Ok(a) => otter_shared_otterenv::join_host_port(host, &a.port().to_string()),
        Err(_) => addr.to_owned(),
    }
}

impl Server {
    /// Go `Run`: `addr` 에 리슨하고 `ctx` 가 끝날 때까지 서빙한다.
    ///
    /// 리슨에 성공한 뒤 주소 파일을 쓰고, 정상 종료 때 자기가 쓴 내용이면 지운다 (FR-HRB-10).
    /// 끝낼 때는 먼저 정중하게(`SHUTDOWN_GRACE`), 그다음 끊는다 (FR-RQG-19).
    pub async fn run(self: &Arc<Self>, ctx: CancellationToken, addr: &str) -> io::Result<()> {
        // FR-CNR-8·12: 진단 회차는 서버 수명과 함께 시작하고 끝난다.
        let diag = ctx.child_token();
        let _stop_diag = diag.clone().drop_guard();
        tokio::spawn(Arc::clone(self).run_diag_snapshots(diag, DIAG_SNAPSHOT_EVERY));

        let ln = (self.rebind.listen)(addr)?;
        let host = split_host_port(addr).map_or("", |(h, _)| h).to_owned();
        let port =
            split_host_port(&bound_addr(addr, &ln)).map_or(String::new(), |(_, p)| p.to_owned());
        let b = Rebinder::new(self, host, port);
        let h = b.serve(ln)?;
        b.set_ln(h);
        *self.rebind.bind.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&b));
        let home = self.cfg.data_dir.clone();
        if let Err(e) = serverconf::write_addr(&home, &b.addr()) {
            warnf!(None, "주소 파일을 쓰지 못했습니다: {e}");
        }

        ctx.cancelled().await;
        b.stop(SHUTDOWN_GRACE).await;
        let st = b.lock();
        serverconf::remove_addr(
            &home,
            &otter_shared_otterenv::join_host_port(&st.host, &st.port),
        );
        Ok(())
    }
}
