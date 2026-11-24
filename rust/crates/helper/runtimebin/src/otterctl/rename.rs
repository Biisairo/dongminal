//! TAB_NAME_DELIVERY_SRS 묶음 C: rename 은 반영을 확인하고, 반영되지 않으면 다시 보낸다.
//! `renameTab` 은 결과를 기다리지 않는 방송이고, 409 를 받은 저장은 다시 시도하지 않는다.

use std::time::{Duration, Instant};

use otter_gocompat::strconv;
use otter_shared_workspace::{self as workspace, WsLayout};
use serde_json::{Map, Value};

use super::post::otterctl_post_capture;
use super::rows::{WorkspaceOnly, fetch_state, rename_matches};
use crate::budgets::{RENAME_CONFIRM_INTERVAL, RENAME_CONFIRM_WINDOW};
use crate::ctx::{Ctx, errf};

/// FR-TND-12: 전송 상한.
const RENAME_MAX_SENDS: usize = 3;

/// 반영의 조건이다 (FR-TND-11).
#[derive(Default, Debug)]
pub(crate) struct RenameWant {
    pub tab_id: String,
    pub name: String,
    pub window: bool,
    pub auto: bool,
}

pub(crate) fn otterctl_rename_confirmed(
    ctx: &mut Ctx<'_>,
    action: &str,
    args: Map<String, Value>,
    want: RenameWant,
) -> i32 {
    for i in 0..RENAME_MAX_SENDS {
        // FR-TND-16: 호출자는 stdout 을 응답 하나로 읽는다 — 다시 보낼 때는 싣지 않는다.
        let (code, _) = otterctl_post_capture(ctx, action, Value::Object(args.clone()), i == 0);
        if code != 0 {
            return code;
        }
        let (applied, known) = wait_rename_applied(ctx, &want);
        if applied || !known {
            return 0;
        }
    }
    let target = if want.auto {
        "자동 이름".to_owned()
    } else {
        format!("이름 {}", strconv::quote(&want.name))
    };
    errf!(
        ctx,
        "otterctl: {target} 이 반영되지 않았습니다 (탭 {}, {}번 보냄) — 다른 화면의 저장과 겹쳤을 수 있습니다\n",
        want.tab_id,
        RENAME_MAX_SENDS
    );
    1
}

/// 확인 창 안에서 반영을 기다린다. known 이 거짓이면 판정할 수 없는 서버다 (FR-TND-14).
/// 간격은 첫 간격에서 두 배씩 늘고, 마지막 확인은 창 끝에 맞춘다 (FR-RGS-44).
fn wait_rename_applied(ctx: &mut Ctx<'_>, want: &RenameWant) -> (bool, bool) {
    let window = ctx.env.rename_window.unwrap_or(RENAME_CONFIRM_WINDOW);
    let mut gap = ctx.env.rename_interval.unwrap_or(RENAME_CONFIRM_INTERVAL);
    let deadline = Instant::now() + window;
    loop {
        let (applied, known) = rename_applied(ctx, want);
        let left = deadline.saturating_duration_since(Instant::now());
        if applied || !known || left.is_zero() {
            return (applied, known);
        }
        std::thread::sleep(gap.min(left));
        gap = gap.saturating_mul(2).min(Duration::from_secs(3600));
    }
}

/// `/api/state` 한 번으로 판정한다. 조회 실패는 미반영이다 (FR-TND-15).
fn rename_applied(ctx: &mut Ctx<'_>, want: &RenameWant) -> (bool, bool) {
    let Ok(state) = fetch_state::<WorkspaceOnly>(ctx, true) else {
        return (false, true);
    };
    let Some(ws) = state.workspace else {
        return (false, false);
    };
    for w in &ws.windows {
        let mut panes: Vec<&WsLayout> = Vec::new();
        workspace::collect_panes(w.layout.as_ref(), &mut panes);
        for p in panes {
            for t in &p.tabs {
                if t.id == want.tab_id {
                    return (
                        rename_matches(want.window, want.auto, &want.name, w, t),
                        true,
                    );
                }
            }
        }
    }
    (false, true)
}
