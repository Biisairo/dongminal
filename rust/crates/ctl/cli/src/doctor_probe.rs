//! doctor 의 프로브 — 의사 터미널 왕복과 콘솔 없는 자식. 진단 표(`doctor.rs`)가 부른다
//! (M8 GO-20, D-A-10).

use std::io;
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use otter_gocompat::filepath;
use otter_gocompat::oserr::go_error_string;
use otter_gocompat::strconv::quote_bytes;
use otter_gocompat::time::format_std_duration;
use otter_shared_otterenv as otterenv;
use otter_shared_platform::{Platform, ProcSpec, ShellSpec, Terminal};

use crate::report::CheckReport;
use crate::shellwait::{QuietError, SHELL_QUIET_FOR, wait_quiet};

/// 왕복 하나를 기다리는 상한이다. 셸이 프롬프트를 그리기까지의 시간이라 넉넉히 준다.
pub(crate) const DOCTOR_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// 검사용 터미널 크기다. 0 을 주면 Windows 의 CreatePseudoConsole 이 E_INVALIDARG 로 실패한다.
pub(crate) const DOCTOR_PROBE_COLS: u16 = 80;
pub(crate) const DOCTOR_PROBE_ROWS: u16 = 24;
/// 콘솔 없는 자식의 결과를 기다리는 상한이다. 자식이 스스로 상한을 걸므로 그보다 넉넉하다.
const DOCTOR_DETACHED_WAIT: Duration = Duration::from_secs(10 + 30);
/// 셸이 프롬프트를 그리기를 기다리는 상한이다 (판정은 `wait_quiet`).
pub(crate) const DOCTOR_READY_WAIT: Duration = Duration::from_secs(15);
/// 콘솔 없는 자식의 결과 파일을 다시 보는 간격이다.
const DOCTOR_RESULT_POLL: Duration = Duration::from_millis(200);

/// 이 프로세스의 환경을 `K=V` 목록으로 낸다 (Go `os.Environ`).
pub(crate) fn environ() -> Vec<String> {
    std::env::vars_os()
        .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
        .collect()
}

/// 끝나면 죽이고 닫는다 — 어느 갈래로 나가든.
struct TermGuard(Arc<dyn Terminal>);

impl Drop for TermGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.close();
    }
}

fn start_term(p: &Platform, spec: ProcSpec) -> io::Result<TermGuard> {
    let term = p.pty.start(spec, DOCTOR_PROBE_COLS, DOCTOR_PROBE_ROWS)?;
    Ok(TermGuard(Arc::from(term)))
}

/// **입력 없이** 한 줄을 출력하고 끝나는 명령을 의사 터미널에 띄운다. 셸·프롬프트·입력 타이밍이
/// 모두 빠지므로, 실패하면 원인은 의사 터미널의 배관 그 자체다.
pub(crate) fn doctor_probe_plain_command(r: &mut CheckReport<'_>, p: &Platform, home: &str) {
    const MARKER: &str = "otterminal-plain-ok";
    let spec = p.shell.echo_command(MARKER);
    if spec.is_empty() {
        return;
    }
    let term = match start_term(
        p,
        ProcSpec {
            path: spec[0].clone(),
            args: spec,
            env: environ(),
            dir: home.to_owned(),
        },
    ) {
        Ok(t) => t,
        Err(e) => {
            r.bad(format!("[단순 명령] 기동 실패: {}", go_error_string(&e)));
            return;
        }
    };
    let (got, rerr) = doctor_round_trip(&term.0, "", MARKER, DOCTOR_PROBE_TIMEOUT);
    if contains(&got, MARKER) {
        r.ok("[단순 명령] 출력이 의사 터미널로 나옵니다");
        return;
    }
    r.bad(format!(
        "[단순 명령] 출력이 의사 터미널로 나오지 않습니다 (받은 {}바이트) — 배관 문제입니다",
        got.len()
    ));
    if let Err(e) = rerr {
        r.info(format!("읽기: {e}"));
    }
    r.info(format!("받은 것: {}", quote_bytes(&doctor_trim(&got))));
}

/// 명세 하나로 터미널을 띄워 왕복시킨다.
pub(crate) fn doctor_probe_terminal(
    r: &mut CheckReport<'_>,
    p: &Platform,
    label: &str,
    spec: &ShellSpec,
    home: &str,
) -> bool {
    let mut env = environ();
    env.push("TERM=xterm-256color".to_owned());
    env.push(format!("{}={home}", otterenv::ENV_HOME));
    env.extend(spec.env.iter().cloned());
    let term = match start_term(
        p,
        ProcSpec {
            path: spec.path.clone(),
            args: std::iter::once(spec.path.clone())
                .chain(spec.args.iter().cloned())
                .collect(),
            env,
            dir: home.to_owned(),
        },
    ) {
        Ok(t) => t,
        Err(e) => {
            r.bad(format!(
                "[{label}] 터미널 기동 실패: {}",
                go_error_string(&e)
            ));
            return false;
        }
    };
    let t = &term.0;
    r.ok(format!("[{label}] 기동 pid={}", t.pid()));

    match t.size() {
        Err(e) => r.bad(format!("[{label}] 크기 조회 실패: {}", go_error_string(&e))),
        Ok((c, rows)) if c == 0 || rows == 0 => {
            r.bad(format!("[{label}] 크기가 0입니다 ({c}x{rows})"));
        }
        Ok(_) => {}
    }
    if let Err(e) = t.resize(100, 30) {
        r.bad(format!("[{label}] 크기 변경 실패: {}", go_error_string(&e)));
    }

    // echo 는 sh·bash·zsh·PowerShell·cmd 가 모두 아는 몇 안 되는 명령이다.
    const MARKER: &str = "otterminal-doctor-ok";
    let (got, res) =
        doctor_round_trip(t, &format!("echo {MARKER}\r"), MARKER, DOCTOR_PROBE_TIMEOUT);
    if let Err(e) = res {
        r.bad(format!("[{label}] 출력을 읽지 못했습니다: {e}"));
        r.info(format!(
            "그때까지 받은 것: {}",
            quote_bytes(&doctor_trim(&got))
        ));
        return false;
    }
    if !contains(&got, MARKER) {
        r.bad(format!("[{label}] 명령이 왕복하지 않았습니다"));
        r.info(format!("받은 것: {}", quote_bytes(&doctor_trim(&got))));
        return false;
    }
    r.ok(format!("[{label}] 입출력 왕복"));
    true
}

struct Seen {
    buf: Vec<u8>,
    last_at: Instant,
    found: bool,
    /// 읽기가 끝난 이유다. 한 번 꺼내 쓰면 비운다 (Go 의 채널 수신과 같다).
    read_err: Option<String>,
}

struct Shared {
    st: Mutex<Seen>,
    cv: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Seen> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 읽기 오류의 Go 문구다. 끝(0 바이트)은 `io.EOF` 다.
fn read_error(res: io::Result<usize>) -> Option<String> {
    match res {
        Ok(0) => Some("EOF".to_owned()),
        Ok(_) => None,
        Err(e) => Some(go_error_string(&e)),
    }
}

/// 셸이 준비되기를 기다린 뒤 input 을 쓰고, want 가 보일 때까지 읽는다.
///
/// **기다림이 핵심이다.** 셸이 프롬프트를 그리기 전에 넣은 입력은 버려진다. 그래서 출력이 오고
/// **조용해지는 것**을 준비 신호로 삼는다. 읽기는 전용 스레드에 맡긴다 — 자식이 끝나도 의사 콘솔이
/// 파이프를 열어 두는 플랫폼(Windows)에서는 읽기가 돌아오지 않는다.
pub(crate) fn doctor_round_trip(
    term: &Arc<dyn Terminal>,
    input: &str,
    want: &str,
    limit: Duration,
) -> (Vec<u8>, Result<(), String>) {
    let sh = Arc::new(Shared {
        st: Mutex::new(Seen {
            buf: Vec::new(),
            last_at: Instant::now(),
            found: false,
            read_err: None,
        }),
        cv: Condvar::new(),
    });
    {
        let sh = Arc::clone(&sh);
        let term = Arc::clone(term);
        let want = want.as_bytes().to_vec();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let res = term.read(&mut buf);
                let mut st = sh.lock();
                if let Ok(n) = res
                    && n > 0
                {
                    st.buf.extend_from_slice(&buf[..n]);
                    st.last_at = Instant::now();
                    if contains_bytes(&st.buf, &want) {
                        st.found = true;
                        sh.cv.notify_all();
                        return;
                    }
                }
                if let Some(e) = read_error(res) {
                    st.read_err = Some(e);
                    sh.cv.notify_all();
                    return;
                }
            }
        });
    }
    let got = || sh.lock().buf.clone();

    if !input.is_empty() {
        // 출력이 한 번이라도 오고 그 뒤 조용해지면 프롬프트가 선 것이다.
        let ready = wait_quiet(
            || {
                let mut st = sh.lock();
                if let Some(e) = st.read_err.take() {
                    return Err(e);
                }
                Ok((st.buf.len(), Some(st.last_at)))
            },
            DOCTOR_READY_WAIT,
            SHELL_QUIET_FOR,
        );
        // 상한을 넘긴 것은 끊긴 것이 아니다 — 입력은 넣어 본다.
        if let Err(QuietError::Snapshot(e)) = ready {
            return (got(), Err(format!("셸이 준비되기 전에 끊겼다: {e}")));
        }
        if let Err(e) = term.write(input.as_bytes()) {
            return (got(), Err(format!("입력 쓰기: {}", go_error_string(&e))));
        }
    }

    let deadline = Instant::now() + limit;
    let mut st = sh.lock();
    loop {
        if st.found {
            return (st.buf.clone(), Ok(()));
        }
        if let Some(e) = st.read_err.take() {
            return (st.buf.clone(), Err(e));
        }
        let now = Instant::now();
        if now >= deadline {
            return (
                st.buf.clone(),
                Err(format!(
                    "{} 안에 응답이 없습니다",
                    format_std_duration(limit)
                )),
            );
        }
        st = sh
            .cv
            .wait_timeout(st, deadline - now)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

pub(crate) fn contains(hay: &[u8], needle: &str) -> bool {
    contains_bytes(hay, needle.as_bytes())
}

/// Go `strings.TrimSpace` — 앞뒤의 유니코드 공백을 걷는다. 깨진 바이트는 공백이 아니다.
fn trim_space(s: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < s.len() {
        match first_char(&s[start..]) {
            Some(c) if c.is_whitespace() => start += c.len_utf8(),
            _ => break,
        }
    }
    let mut end = s.len();
    while end > start {
        match last_char(&s[start..end]) {
            Some(c) if c.is_whitespace() => end -= c.len_utf8(),
            _ => break,
        }
    }
    &s[start..end]
}

fn first_char(s: &[u8]) -> Option<char> {
    let n = s.len().min(4);
    (1..=n).find_map(|k| std::str::from_utf8(&s[..k]).ok()?.chars().next())
}

fn last_char(s: &[u8]) -> Option<char> {
    let n = s.len().min(4);
    (1..=n).find_map(|k| std::str::from_utf8(&s[s.len() - k..]).ok()?.chars().next())
}

/// 화면에 실을 만큼만 남긴다 (바이트 300). `%q` 로 감싸는 것은 호출자의 몫이다.
pub(crate) fn doctor_trim(s: &[u8]) -> Vec<u8> {
    const MAX: usize = 300;
    let s = trim_space(s);
    if s.len() > MAX {
        let mut v = s[..MAX].to_vec();
        v.extend_from_slice("…".as_bytes());
        return v;
    }
    s.to_vec()
}

/// 자기 자신을 **서버와 같은 방식으로**(콘솔 없이) 띄워 의사 터미널을 확인한다. doctor 가 통과하는데
/// 실제 터미널이 비는 상황의 유일하게 남는 변수다.
pub(crate) fn doctor_detached(r: &mut CheckReport<'_>, p: &Platform, home: &str) {
    r.section("콘솔 없는 프로세스에서의 의사 터미널");

    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            r.bad(format!("실행 파일 경로 확인 실패: {}", go_error_string(&e)));
            return;
        }
    };
    let out = filepath::join(&[home, "doctor-probe.txt"]);
    let _ = std::fs::remove_file(&out);

    r.info(format!(
        "서버와 같은 방식으로 자식을 띄우고 최대 {} 기다립니다...",
        format_std_duration(DOCTOR_DETACHED_WAIT)
    ));
    let mut cmd = Command::new(&exe);
    cmd.args(["doctor", "--home", home, "--probe-pty", out.as_str()]);
    // 서버·데몬과 똑같이 부모와 끊어 띄운다.
    p.process.detach(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            r.bad(format!("프로브 기동 실패: {}", go_error_string(&e)));
            return;
        }
    };

    let deadline = Instant::now() + DOCTOR_DETACHED_WAIT;
    while Instant::now() < deadline {
        if let Ok(blob) = std::fs::read(&out)
            && !blob.is_empty()
        {
            let _ = std::fs::remove_file(&out);
            let _ = child.try_wait();
            let text = String::from_utf8_lossy(trim_space(&blob)).into_owned();
            if text.starts_with("OK") {
                r.ok("콘솔 없이도 동작합니다");
            } else {
                r.bad("콘솔 없는 프로세스에서 실패합니다 — 서버의 조건입니다");
                for line in text.split('\n').filter(|l| !l.is_empty()) {
                    r.info(line);
                }
            }
            return;
        }
        std::thread::sleep(DOCTOR_RESULT_POLL);
    }
    // 결과 파일조차 없으면 자식이 결과를 쓰기 전에 막힌 것이다.
    let _ = child.kill();
    let _ = child.wait();
    r.bad(format!(
        "콘솔 없는 프로세스에서 {} 안에 결과가 나오지 않았습니다 — 서버의 조건입니다",
        format_std_duration(DOCTOR_DETACHED_WAIT)
    ));
    r.info(format!("프로브 출력 자리: {out}"));
}

/// `--probe-pty` 모드다. 의사 터미널을 띄워 왕복시키고 결과를 path 에 적는다. 콘솔이 없으므로
/// 화면에 적을 자리가 없다 — 그래서 파일이다.
pub(crate) fn run_pty_probe(path: &str, p: &Platform, home: &str) -> i32 {
    let bin = filepath::join(&[home, otterenv::BIN_DIR]);
    let spec = p.shell.shell(std::path::Path::new(&bin));
    let mut env = environ();
    env.extend(spec.env.iter().cloned());
    let started = start_term(
        p,
        ProcSpec {
            path: spec.path.clone(),
            args: std::iter::once(spec.path.clone())
                .chain(spec.args.iter().cloned())
                .collect(),
            env,
            dir: home.to_owned(),
        },
    );
    let mut b: Vec<u8> = Vec::new();
    match started {
        Err(e) => {
            b.extend(format!("FAIL 터미널 기동: {}\n", go_error_string(&e)).bytes());
        }
        Ok(term) => {
            const MARKER: &str = "otterminal-detached-ok";
            let (got, rerr) = doctor_round_trip(
                &term.0,
                &format!("echo {MARKER}\r"),
                MARKER,
                DOCTOR_PROBE_TIMEOUT,
            );
            let got_q = quote_bytes(&doctor_trim(&got));
            match rerr {
                Err(e) => {
                    b.extend(format!("FAIL 출력 읽기: {e} (받은 바이트 {})\n", got.len()).bytes());
                    b.extend(format!("받은 것: {got_q}\n").bytes());
                }
                Ok(()) if !contains(&got, MARKER) => {
                    b.extend(format!("FAIL 왕복 실패 (받은 바이트 {})\n", got.len()).bytes());
                    b.extend(format!("받은 것: {got_q}\n").bytes());
                }
                Ok(()) => {
                    b.extend(
                        format!("OK pid={} 받은 바이트 {}\n", term.0.pid(), got.len()).bytes(),
                    );
                }
            }
        }
    }
    let _ = write_0644(path, &b);
    if b.starts_with(b"OK") { 0 } else { 1 }
}

/// Go `os.WriteFile(path, b, 0o644)`.
fn write_0644(path: &str, b: &[u8]) -> io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o644);
    io::Write::write_all(&mut o.open(path)?, b)
}
