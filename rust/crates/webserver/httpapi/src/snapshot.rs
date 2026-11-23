//! `GET /api/snapshot` (Go `handlers_snapshot.go`, OPTIMIZE_REFACTOR_SRS FR-OPT-4-5).
//!
//! SSE 구독이 열릴 때의 복원을 요청 하나로 준다. 조각은 그 종단의 본문 그대로다 — 받는 쪽의 복원
//! 함수가 한 벌로 남는다. 200 이 아닌 조각과 모르는 이름은 싣지 않는다.

use std::collections::BTreeMap;

use dm_gocompat::json::{self, RawMessage};
use dm_shared_httpresp::{self as httpresp, Response};
use http::{HeaderValue, StatusCode, header};
use http_body_util::BodyExt;

use crate::Server;
use crate::req::{Handler, Req};

/// 조각 이름과 그 조각을 만드는 종단이다. `edges` 는 5.5.9 가 Go 표의 자리에 더한다.
fn snapshot_part(name: &str) -> Option<Handler> {
    macro_rules! part {
        ($m:ident) => {{
            fn f<'a>(s: &'a Server, r: &'a mut Req) -> crate::req::BoxFut<'a, Response> {
                Box::pin(s.$m(r))
            }
            Some(f as Handler)
        }};
    }
    match name {
        "attention" => part!(api_tools_attention),
        "activity" => part!(api_tools_activity),
        "background" => part!(api_tools_background),
        "settings" => part!(api_settings_get),
        "update" => part!(api_update_get),
        "focus" => part!(api_focus_get),
        _ => None,
    }
}

fn trim_space(b: &[u8]) -> &[u8] {
    let ws = |c: &u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c);
    let start = b.iter().position(|c| !ws(c)).unwrap_or(b.len());
    let end = b.iter().rposition(|c| !ws(c)).map_or(start, |i| i + 1);
    &b[start..end]
}

impl Server {
    /// GET /api/snapshot?parts=attention,activity,...
    pub(crate) async fn api_snapshot(&self, r: &mut Req) -> Response {
        let mut out: BTreeMap<String, RawMessage> = BTreeMap::new();
        let parts = r.q("parts");
        for name in parts.split(',') {
            let Some(h) = snapshot_part(name) else {
                continue;
            };
            if out.contains_key(name) {
                continue;
            }
            let res = h(self, r).await;
            if res.status() != StatusCode::OK {
                continue;
            }
            let Ok(body) = res.into_body().collect().await else {
                continue;
            };
            let body = body.to_bytes();
            let b = trim_space(&body);
            if !json::valid(b) {
                continue;
            }
            out.insert(name.to_owned(), RawMessage(b.to_vec()));
        }
        // 설정 blob 은 브라우저가 보낸 그대로다 — `<`·`&` 를 바꾸지 않는다.
        let body = json::Encoder::new()
            .set_escape_html(false)
            .encode(&out)
            .unwrap_or_default();
        let mut res = Response::new(httpresp::full(body));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(httpresp::CONTENT_TYPE_JSON),
        );
        res
    }
}
