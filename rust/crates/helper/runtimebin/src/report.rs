//! AGENT_RECORD_DAEMON_SRS FR-ARD-23 — 훅 보고는 데몬의 보고 소켓에 먼저 보낸다. 데몬은
//! 서버가 꺼져 있어도 기록한다 (FR-ARD-25).

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use dm_gocompat::json::{self, Encoder, RawMessage};
use dm_shared_agentrec as agentrec;
use dm_shared_dmenv as dmenv;
use serde::Serialize;

use crate::ctx::Env;
use crate::http::{HttpOut, base_url, http_do};

/// 소켓으로 보낸 보고의 결과다. HTTP 의 성공 응답과 같게 둔다.
const REPORT_OK: &[u8] = br#"{"ok":true}"#;

/// 보고 하나다. 보고 소켓이 없거나 실패하면 같은 본문을 path 의 HTTP 로 보낸다. 소켓 시도는
/// 예산의 절반까지이고, HTTP 는 남은 예산을 쓴다.
pub(crate) fn post_report<T: Serialize + ?Sized>(
    env: &Env,
    method: &str,
    path: &str,
    body: &T,
    mut budget: Duration,
) -> HttpOut {
    let raw = match json::marshal(body) {
        Ok(raw) => raw,
        Err(e) => {
            return HttpOut {
                status: 0,
                body: Vec::new(),
                err: Some(e.to_string()),
                timeout: false,
                refused: false,
            };
        }
    };
    let home = env.get(dmenv::ENV_HOME);
    if !home.is_empty() && !budget.is_zero() {
        let start = Instant::now();
        if send_report_socket(Path::new(&home), method, &raw, budget / 2) {
            return HttpOut::ok(200, REPORT_OK);
        }
        budget = budget
            .saturating_sub(start.elapsed())
            .max(Duration::from_millis(1));
    }
    http_do(
        "POST",
        &format!("{}{path}", base_url(env)),
        Some(raw),
        true,
        budget,
    )
}

/// home 의 보고 소켓에 보내고 데몬이 받았는가를 돌려준다.
fn send_report_socket(home: &Path, method: &str, raw: &[u8], within: Duration) -> bool {
    let deadline = Instant::now() + within;
    let Ok(mut c) = dm_shared_platform::current()
        .ipc
        .dial(&agentrec::socket_path(home), within)
    else {
        return false;
    };
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero()
        || c.set_read_timeout(Some(left)).is_err()
        || c.set_write_timeout(Some(left)).is_err()
    {
        return false;
    }
    let req = agentrec::Request {
        method: method.to_owned(),
        body: RawMessage(raw.to_vec()),
    };
    let Ok(line) = Encoder::new().encode(&req) else {
        return false;
    };
    if c.write_all(&line).is_err() {
        return false;
    }
    let mut reply_line = Vec::new();
    if BufReader::new(&mut c)
        .read_until(b'\n', &mut reply_line)
        .is_err()
    {
        return false;
    }
    json::unmarshal::<agentrec::Reply>(&reply_line).is_ok_and(|r| r.ok)
}
