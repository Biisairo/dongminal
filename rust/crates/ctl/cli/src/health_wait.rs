//! 기동이 데몬 연결까지 기다린다 (VERSION_HEALTH_SRS 묶음 S, FR-VHL-20).

use std::time::Duration;

use otter_shared_apipath as apipath;
use serde::Deserialize;

use crate::http::{ALIVE_PROBE_TIMEOUT, get};
use crate::wait::poll_until;

/// `/api/health` 에서 기동이 쓰는 만큼이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HealthState {
    pub daemon_connected: bool,
    pub daemon_build: String,
    pub server_version: String,
    pub mismatch: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Body {
    version: String,
    daemon: Daemon,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Daemon {
    connected: bool,
    build: String,
    mismatch: bool,
}

/// `/api/health` 한 번이다. 없으면 실패가 아니라 "모른다" 다 (FR-VHL-5).
fn fetch_health(url: &str, timeout: Duration) -> Option<HealthState> {
    let r = get(&format!("{url}{}", apipath::HEALTH), timeout).ok()?;
    if r.status != 200 {
        return None;
    }
    let b: Body = otter_gocompat::json::unmarshal(&r.body).ok()?;
    Some(HealthState {
        daemon_connected: b.daemon.connected,
        daemon_build: b.daemon.build,
        server_version: b.version,
        mismatch: b.daemon.mismatch,
    })
}

/// 데몬이 붙을 때까지의 유한 덤 대기다. 거짓은 실패가 아니라 "기다릴 것이 없었다" 다 (FR-VHL-20a).
pub(crate) fn wait_daemon_connected(
    url: &str,
    tries: u32,
    interval: Duration,
) -> (HealthState, bool) {
    let mut last = HealthState::default();
    let ok = poll_until(interval * tries, interval, || {
        match fetch_health(url, ALIVE_PROBE_TIMEOUT) {
            Some(st) => {
                let c = st.daemon_connected;
                last = st;
                c
            }
            None => false,
        }
    });
    (last, ok)
}
