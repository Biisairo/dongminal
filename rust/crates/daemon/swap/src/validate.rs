use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use otter_gocompat::oserr::{go_error_string, path_error};
use otter_gocompat::{filepath, strconv};
use otter_shared_handover::{self as handover, ReloadRequest};

/// 사전 확인이 끝난 자식을 살피는 간격이다.
const WAIT_POLL: Duration = Duration::from_millis(10);
/// Go `exec.ErrWaitDelay` 의 문구다.
const ERR_WAIT_DELAY: &str = "exec: WaitDelay expired before I/O complete";

/// 검사가 기대는 프로세스 사실이다. 시험이 갈아 끼운다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Env {
    pub euid: u32,
    pub goos: String,
    /// 데몬 자신의 실행 파일(심볼릭 링크를 푼 경로)이다. 기동 때 한 번 정한다 —
    /// 빌드가 같은 자리를 덮어쓰면 Linux 의 /proc/self/exe 는 지워진 파일을 가리키기 때문이다.
    pub self_exe: String,
}

/// "<사유 코드>: <설명>" 꼴의 거절이다. 보고 소켓이 그대로 답한다.
pub(crate) fn refuse(reason: &str, msg: impl AsRef<str>) -> String {
    format!("{reason}: {}", msg.as_ref())
}

/// 교체 요청을 받아들일지 본다 (FR-DSK-11). Ok 이면 받아들인다.
pub fn validate(req: &ReloadRequest, env: &Env) -> Result<(), String> {
    if env.goos == "windows" {
        return Err(refuse(
            handover::REASON_UNSUPPORTED,
            "이 OS 는 세션 유지 교체를 지원하지 않습니다",
        ));
    }
    if req.handover != handover::VERSION {
        return Err(refuse(
            handover::REASON_VERSION,
            format!(
                "인계 판이 다릅니다 (요청 {}, 데몬 {})",
                req.handover,
                handover::VERSION
            ),
        ));
    }
    let exe = req.exe.as_str();
    if !filepath::is_abs(exe) {
        return Err(refuse(
            handover::REASON_EXE,
            format!("절대경로가 아닙니다: {}", strconv::quote(exe)),
        ));
    }
    let fi = match std::fs::metadata(exe) {
        Ok(fi) => fi,
        Err(e) => {
            return Err(refuse(
                handover::REASON_EXE,
                go_error_string(&path_error("stat", exe, e)),
            ));
        }
    };
    if !fi.is_file() {
        return Err(refuse(
            handover::REASON_EXE,
            format!("일반 파일이 아닙니다: {exe}"),
        ));
    }
    if perm(&fi) & 0o111 == 0 {
        return Err(refuse(
            handover::REASON_EXE,
            format!("실행할 수 없습니다: {exe}"),
        ));
    }
    if file_owner(&fi) != Some(env.euid) {
        return Err(refuse(
            handover::REASON_EXE,
            format!("파일 소유자가 데몬 사용자가 아닙니다: {exe}"),
        ));
    }
    // 보안: 교체 대상은 데몬 자신의 실행 파일 자리뿐이다. 같은 사용자 소유라도 다른 자리의
    // 바이너리는 exec 하지 않는다.
    let resolved = filepath::eval_symlinks(exe);
    if env.self_exe.is_empty() || resolved.ok().as_deref() != Some(env.self_exe.as_str()) {
        return Err(refuse(
            handover::REASON_EXE,
            format!(
                "데몬 자신의 실행 파일이 아닙니다: {exe} (데몬 {}) — otterminal start --refresh-daemon 을 쓰세요",
                env.self_exe
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn perm(fi: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fi.permissions().mode() & 0o777
}

/// Windows 의 Go 파일 모드에는 실행 비트가 없다.
#[cfg(not(unix))]
fn perm(_: &std::fs::Metadata) -> u32 {
    0
}

/// 파일 소유자의 uid 다.
#[cfg(unix)]
fn file_owner(fi: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(fi.uid())
}

/// Windows 에서 묻지 않는다 — 교체 자체를 지원하지 않는다 (D-DSK-7).
#[cfg(not(unix))]
fn file_owner(_: &std::fs::Metadata) -> Option<u32> {
    None
}

/// exe 를 `d --handover-version` 으로 실행해 같은 인계 판을 말하는지 본다 (FR-DSK-12).
pub fn preflight(exe: &str, within: Duration) -> Result<(), String> {
    let out = run(exe, within)?;
    let text = String::from_utf8_lossy(&out);
    let Ok(v) = text.trim().parse::<i64>() else {
        return Err(refuse(
            handover::REASON_PREFLIGHT,
            format!(
                "새 바이너리가 인계 판을 말하지 않았습니다: {}",
                strconv::quote_bytes(&out)
            ),
        ));
    };
    if v != handover::VERSION {
        return Err(refuse(
            handover::REASON_PREFLIGHT,
            format!(
                "새 바이너리의 인계 판이 다릅니다 ({v}, 데몬 {})",
                handover::VERSION
            ),
        ));
    }
    Ok(())
}

/// Go `exec.CommandContext` + `WaitDelay = within` 의 Run 이다. 표준 출력을 돌려준다.
fn run(exe: &str, within: Duration) -> Result<Vec<u8>, String> {
    let failed = |msg: String| {
        refuse(
            handover::REASON_PREFLIGHT,
            format!("새 바이너리 실행 실패: {msg}"),
        )
    };
    let deadline = Instant::now() + within;
    let mut child = Command::new(exe)
        .args(["d", handover::ARG_VERSION])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| failed(go_error_string(&path_error("fork/exec", exe, e))))?;
    let (tx, rx) = mpsc::channel();
    if let Some(mut so) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b);
            let _ = tx.send(b);
        });
    }
    let timed_out = || {
        refuse(
            handover::REASON_PREFLIGHT,
            format!(
                "새 바이너리가 {} 안에 답하지 않았습니다",
                otter_gocompat::time::format_std_duration(within)
            ),
        )
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timed_out());
            }
            Ok(None) => std::thread::sleep(WAIT_POLL),
            Err(e) => return Err(failed(go_error_string(&e))),
        }
    };
    // 시한에 죽인 셸의 손자가 출력 파이프를 쥐고 있어도 끝나게 한다.
    let out = rx
        .recv_timeout(within)
        .map_err(|_| failed(ERR_WAIT_DELAY.to_owned()));
    if !status.success() {
        return Err(failed(exit_string(&status)));
    }
    out
}

/// Go `*exec.ExitError` 의 문구(`exit status N`·`signal: …`).
fn exit_string(st: &ExitStatus) -> String {
    otter_shared_platform::exit_status_text(st)
}

/// 교체가 한 번에 하나만 진행되게 한다 (FR-DSK-11 reload_busy).
#[derive(Debug, Default)]
pub struct Gate {
    busy: AtomicBool,
}

impl Gate {
    /// 진행 중인 교체가 없을 때만 참이다.
    pub fn enter(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 교체가 끝났거나 되돌렸음을 적는다.
    pub fn leave(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}
