//! `/api/commands` 왕복 — 액션 하나를 보내고 결과를 종료 코드로 옮긴다.

use dm_gocompat::json;
use dm_shared_apipath as apipath;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ctx::{Ctx, errf};
use crate::http::{
    ExitRule, HttpOut, base_url, below_400, http_exit, http_post_json, raw_refusal, refuse_with,
};

/// `/api/commands` 계열 POST 한 번의 결과를 종료 코드로 옮긴다 (FR-DRC-11). echo 는 성공
/// 본문을 stdout 으로 되실을지다.
pub(crate) fn dmctl_http_result(
    ctx: &mut Ctx<'_>,
    rule: ExitRule<'_>,
    r: HttpOut,
    echo: bool,
) -> i32 {
    match http_exit(ctx, r, rule) {
        Ok(body) => {
            if echo {
                let _ = ctx.out.write_all(&body);
                let _ = ctx.out.write_all(b"\n");
            }
            0
        }
        Err(code) => code,
    }
}

/// 400 미만이 성공이고, 거절은 서버 본문을 그대로 싣는다.
pub(crate) fn command_rule(prefix: &str) -> ExitRule<'_> {
    ExitRule {
        prefix,
        on_err: None,
        ok: Some(below_400),
        refuse: refuse_with(raw_refusal),
    }
}

pub(crate) fn dmctl_post(ctx: &mut Ctx<'_>, action: &str, args: Value) -> i32 {
    dmctl_post_capture(ctx, action, args, true).0
}

/// `/api/commands` 에 action 하나를 보낸다. echo 가 거짓이면 성공 본문을 stdout 에 싣지 않는다
/// (rename 의 재전송). 응답 본문을 함께 돌려준다.
pub(crate) fn dmctl_post_capture(
    ctx: &mut Ctx<'_>,
    action: &str,
    args: Value,
    echo: bool,
) -> (i32, Vec<u8>) {
    let body = json!({"action": action, "args": args});
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::COMMANDS),
        &body,
    );
    let resp = r.body.clone();
    let code = dmctl_http_result(ctx, command_rule("dmctl"), r, echo);
    if code != 0 {
        return (code, resp);
    }
    (dmctl_delivery(ctx, "dmctl", &resp), resp)
}

/// 응답의 배달 사실을 종료 코드로 옮긴다 (M8_UNIFIED_SRS D-A-2). 판정은 필드가 있을 때만이다.
pub(crate) fn dmctl_delivery(ctx: &mut Ctx<'_>, prefix: &str, resp: &[u8]) -> i32 {
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        delivered: Option<i64>,
        #[serde(rename = "timedOut")]
        timed_out: Option<bool>,
    }
    let Ok(got) = json::unmarshal::<Got>(resp) else {
        return 0;
    };
    let Some(delivered) = got.delivered else {
        return 0;
    };
    if delivered == 0 {
        errf!(
            ctx,
            "{prefix}: 구독 중인 브라우저가 없습니다 — 페이지를 새로고침하세요\n"
        );
        return 1;
    }
    if got.timed_out == Some(true) {
        errf!(
            ctx,
            "{prefix}: 브라우저가 결과를 답하지 않았습니다 — 만들어지지 않았을 수 있습니다. list-workspace 로 확인하세요\n"
        );
        return 1;
    }
    0
}

pub(crate) fn dmctl_send(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some(action) = args.first() else {
        errf!(ctx, "usage: dmctl send <action> [json-args]\n");
        return 2;
    };
    let mut payload = json!({});
    if let Some(raw) = args.get(1).filter(|s| !s.is_empty()) {
        match json::unmarshal::<Value>(raw.as_bytes()) {
            Ok(v) => payload = v,
            Err(e) => {
                errf!(ctx, "dmctl: invalid json args: {e}\n");
                return 2;
            }
        }
    }
    dmctl_post(ctx, action, payload)
}
