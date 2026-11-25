//! 로그 크기 상한 (RECONNECT_STORM_SRS 묶음 L, G2-1·SEC-25).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use otter_gocompat::filepath;
use otter_shared_otterenv as otterenv;

use crate::env::Env;
use crate::homelayout::RESTART_LOG_FILE;
use crate::options::{Common, ENV_LOG, default_log_file};

/// 이 크기를 넘으면 줄인다.
pub const LOG_MAX_BYTES: u64 = 64 << 20;
/// 줄일 때 끝에서 이만큼을 `<로그>.1` 로 남긴다 (FR-LOG-2).
pub const LOG_KEEP_BYTES: u64 = 8 << 20;
pub use otter_shared_cadence::LOG_CHECK_EVERY;

/// 홈 아래에서 무한히 자랄 수 있는 로그들이다.
pub(crate) const HOME_LOGS: [&str; 3] = [
    otterenv::SERVER_LOG_FILE,
    otterenv::DAEMON_LOG_FILE,
    RESTART_LOG_FILE,
];

/// path 가 max 를 넘으면 끝에서 keep 만큼을 `path.1` 로 옮기고 본체를 자른다.
///
/// 이름을 바꾸지 않는다 (FR-LOG-3) — 서버의 stdout·stderr 는 그 파일의 fd 이고, `O_APPEND` 로 열린
/// fd 는 자르기 뒤 0 부터 쓴다. 닿을 수 없는 경로는 조용히 지나간다 (FR-LOG-4).
pub(crate) fn cap_log(path: &str, max: u64, keep: u64) {
    if path.is_empty() {
        return;
    }
    let Ok(st) = fs::metadata(path) else { return };
    if st.is_dir() || st.len() <= max {
        return;
    }
    if keep_tail(path, st.len(), keep.min(st.len())).is_ok() {
        // 여기서 실패하면 다음 주기가 다시 시도한다.
        let _ = OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|f| f.set_len(0));
    }
}

/// 남길 부분을 옆에 완성한 뒤 제자리(`path.1`)로 옮긴다 — `.1` 이 반쯤 쓰인 채 보이지 않게 한다.
fn keep_tail(path: &str, size: u64, keep: u64) -> io::Result<()> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(size - keep))?;
    let tmp = format!("{path}.1.tmp");
    let copied = create_log(&tmp)
        .and_then(|mut out| io::copy(&mut f, &mut out).map(drop))
        .and_then(|()| fs::rename(&tmp, format!("{path}.1")));
    if copied.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    copied
}

fn create_log(path: &str) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o644);
    o.open(path)
}

/// 홈 아래 로그 전부에 상한을 건다. 상한·보존량은 검사가 낮춰 쓴다.
pub(crate) fn cap_home_logs(home: &str, max: u64, keep: u64) {
    if home.is_empty() {
        return;
    }
    for n in HOME_LOGS {
        cap_log(&filepath::join(&[home, n]), max, keep);
    }
}

/// `done` 이 오거나 보내는 쪽이 사라질 때까지 주기적으로 로그를 줄인다. 홈은 프로세스 환경에서 푼다.
pub fn watch_log_size(done: &Receiver<()>) {
    let env = Env::process();
    let home = Common::default().resolve_home_in(&env).unwrap_or_default();
    watch_loop(
        &env,
        &home,
        done,
        LOG_CHECK_EVERY,
        LOG_MAX_BYTES,
        LOG_KEEP_BYTES,
    );
}

/// [`watch_log_size`] 와 같되 홈을 받는다. 서버는 홈을 환경에 심지 않으므로(Go 는 `os.Setenv`
/// 로 심었다) 이것을 부른다.
pub fn watch_log_size_in(home: &str, done: &Receiver<()>) {
    watch_loop(
        &Env::process(),
        home,
        done,
        LOG_CHECK_EVERY,
        LOG_MAX_BYTES,
        LOG_KEEP_BYTES,
    );
}

/// 홈 아래 셋을 함께 본다 (G2-1). `$OTTERMINAL_LOG` 로 옮긴 서버 로그는 홈 밖일 수 있으므로 따로
/// 건다. 홈을 정하지 못하면 홈 아래 로그는 건드리지 않는다 (FR-LOG-4).
pub(crate) fn watch_loop(
    env: &Env<'_>,
    home: &str,
    done: &Receiver<()>,
    every: Duration,
    max: u64,
    keep: u64,
) {
    let mut path = env.get(ENV_LOG);
    if path.is_empty() {
        path = default_log_file(home);
    }
    while let Err(RecvTimeoutError::Timeout) = done.recv_timeout(every) {
        cap_log(&path, max, keep);
        cap_home_logs(home, max, keep);
    }
}
