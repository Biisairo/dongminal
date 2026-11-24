//! `otterminal window` — 돌고 있는 서버에 frameless window 를 연다 (FR-WIN-1..7).
//! 서버를 띄우지 않는다.

use std::io::Write;

use otter_shared_apipath as apipath;

use crate::env::Env;
use crate::http::{ALIVE_PROBE_TIMEOUT, ping};
use crate::options::WindowOpts;

/// URL 하나로 frameless window 를 여는 수단이다. 기본은 `open_frameless` 이고 검사가 갈아 끼운다.
pub type Opener<'a> = dyn Fn(&str) -> Result<(), String> + 'a;

pub fn run_window(
    o: &WindowOpts,
    open: &Opener<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    run_window_in(o, &Env::process(), open, stdout, stderr)
}

pub(crate) fn run_window_in(
    o: &WindowOpts,
    env: &Env<'_>,
    open: &Opener<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    // FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다.
    let tgt = match o.common.resolve_target_in(env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    tgt.warn(stderr);
    let url = &tgt.url;

    // FR-WIN-3: 준비 확인은 한 번이다. 기다리지 않는 명령이므로 재시도가 없다 (D-5).
    if !ping(&format!("{url}{}", apipath::PING), ALIVE_PROBE_TIMEOUT) {
        let _ = writeln!(
            stderr,
            "❌ {url} 에서 응답이 없습니다 — 서버가 떠 있지 않습니다"
        );
        let _ = writeln!(stderr, "   먼저 띄웁니다: otterminal start");
        return 1;
    }

    // FR-WIN-4: 창이 이 명령의 본체다. 여는 데 실패하면 명령이 실패한 것이다.
    if let Err(e) = open(url) {
        let _ = writeln!(stderr, "❌ 창을 열지 못했습니다: {e}");
        return 1;
    }
    let _ = writeln!(stdout, "✅ 창을 열었습니다 — {url}");
    0
}
