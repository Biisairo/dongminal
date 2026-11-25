//! 데몬 화면 상태의 설정 — 기록 줄 수 `termHistoryLines` (PERF D-25, FR-TRM-2)와 깨움 스냅숏의 기록 행 수
//! `termScrollback` (PERF 2.5.1).
//!
//! 서버가 설정 blob 에서 읽는다. 기록 줄 수는 데몬에 붙을 때·다시 붙을 때·설정을 저장할 때 데몬에 보내고,
//! 스냅숏 행 수는 스냅숏을 물을 때마다 읽는다 — 브라우저 xterm 의 스크롤백과 같은 값이다.

use std::sync::{Arc, LazyLock};

use otter_shared_otterlog::warnf;
use otter_shared_settingsschema::{self as settingsschema, Spec};
use serde_json::Value;

use crate::agent_render_env::int_setting;
use crate::{DaemonCallError, Server};

pub(crate) const HISTORY_LINES_KEY: &str = "termHistoryLines";
pub(crate) const SCROLLBACK_KEY: &str = "termScrollback";

static HISTORY_LINES_SPEC: LazyLock<Spec> = LazyLock::new(|| spec(HISTORY_LINES_KEY));
static SCROLLBACK_SPEC: LazyLock<Spec> = LazyLock::new(|| spec(SCROLLBACK_KEY));

fn spec(key: &str) -> Spec {
    match settingsschema::load() {
        Ok(specs) => settingsschema::by_key(&specs)
            .remove(key)
            .unwrap_or_default(),
        Err(_) => Spec::default(),
    }
}

/// 데몬의 화면 상태 설정이다.
pub trait ScreenDaemon: Send + Sync {
    fn set_history_lines(&self, lines: usize) -> Result<(), DaemonCallError>;
}

/// blob 의 기록 줄 수다. 없거나 범위 밖이면 표의 기본값이고, 표가 없으면 `None` 이다.
pub(crate) fn parse_history_lines(blob: &[u8]) -> Option<usize> {
    parse(&HISTORY_LINES_SPEC, blob)
}

/// blob 의 스냅숏 기록 행 수다. 규칙은 [`parse_history_lines`] 와 같다.
pub(crate) fn parse_scrollback(blob: &[u8]) -> Option<usize> {
    parse(&SCROLLBACK_SPEC, blob)
}

fn parse(spec: &Spec, blob: &[u8]) -> Option<usize> {
    let v: Option<Value> = otter_gocompat::json::unmarshal::<Value>(blob).ok();
    let n = int_setting(spec, v.as_ref().and_then(|v| v.get(&spec.key)))?;
    usize::try_from(n).ok()
}

impl Server {
    fn settings_blob(&self) -> Vec<u8> {
        self.deps
            .settings
            .as_ref()
            .map(|s| s.get())
            .unwrap_or_default()
    }

    fn screen_config_job(&self) -> Option<(Arc<dyn ScreenDaemon>, usize)> {
        let d = self.deps.screen_daemon.clone()?;
        Some((d, parse_history_lines(&self.settings_blob())?))
    }

    /// 깨움·흐름 제어 스냅숏에 싣는 기록 행 수 — 설정 `termScrollback` (FR-TRM-4, D-25). 표를 읽지
    /// 못하면 0 이다(화면만).
    pub(crate) fn wake_history(&self) -> usize {
        parse_scrollback(&self.settings_blob()).unwrap_or_default()
    }

    /// 지금 설정의 기록 줄 수를 데몬에 보낸다. 데몬에 붙을 때와 다시 붙을 때 부른다.
    pub fn sync_screen_config(&self) {
        if let Some((d, n)) = self.screen_config_job() {
            send(&*d, n);
        }
    }

    /// 설정을 저장한 뒤 부른다. 데몬 호출은 런타임 밖에서 한다.
    pub(crate) async fn apply_screen_config(&self) {
        if let Some((d, n)) = self.screen_config_job() {
            crate::tools_api::off_thread(move || send(&*d, n)).await;
        }
    }
}

fn send(d: &dyn ScreenDaemon, n: usize) {
    if let Err(e) = d.set_history_lines(n) {
        warnf!(None, "screen: 기록 줄 수를 데몬에 보내지 못했다: {e}");
    }
}
