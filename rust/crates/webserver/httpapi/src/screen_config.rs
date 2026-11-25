//! 데몬 화면 상태의 설정 — 기록 줄 수 `termHistoryLines` (PERF D-25, FR-TRM-2).
//!
//! 서버가 설정 blob 에서 읽어 데몬에 보낸다. 데몬에 붙을 때·다시 붙을 때·설정을 저장할 때 보낸다.

use std::sync::{Arc, LazyLock};

use otter_shared_otterlog::warnf;
use otter_shared_settingsschema::{self as settingsschema, Spec};
use serde_json::Value;

use crate::agent_render_env::int_setting;
use crate::{DaemonCallError, Server};

pub(crate) const HISTORY_LINES_KEY: &str = "termHistoryLines";

static HISTORY_LINES_SPEC: LazyLock<Spec> = LazyLock::new(|| match settingsschema::load() {
    Ok(specs) => settingsschema::by_key(&specs)
        .remove(HISTORY_LINES_KEY)
        .unwrap_or_default(),
    Err(_) => Spec::default(),
});

/// 데몬의 화면 상태 설정이다.
pub trait ScreenDaemon: Send + Sync {
    fn set_history_lines(&self, lines: usize) -> Result<(), DaemonCallError>;
}

/// blob 의 기록 줄 수다. 없거나 범위 밖이면 표의 기본값이고, 표가 없으면 `None` 이다.
pub(crate) fn parse_history_lines(blob: &[u8]) -> Option<usize> {
    let v: Option<Value> = otter_gocompat::json::unmarshal::<Value>(blob).ok();
    let n = int_setting(
        &HISTORY_LINES_SPEC,
        v.as_ref().and_then(|v| v.get(HISTORY_LINES_KEY)),
    )?;
    usize::try_from(n).ok()
}

impl Server {
    fn screen_config_job(&self) -> Option<(Arc<dyn ScreenDaemon>, usize)> {
        let d = self.deps.screen_daemon.clone()?;
        let blob = self
            .deps
            .settings
            .as_ref()
            .map(|s| s.get())
            .unwrap_or_default();
        Some((d, parse_history_lines(&blob)?))
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
