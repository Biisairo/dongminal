//! 의사 터미널 (FR-XPT-1). POSIX 는 openpty + 읽기 게이트, Windows 는 ConPTY 다.
//! 환경 정리·크기 하한·Windows 명령줄 조립은 cfg 없이 컴파일되어 어느 호스트에서도 검증된다.

#[cfg(unix)]
pub(crate) mod posix;
#[cfg(windows)]
pub(crate) mod windows;

use std::io;
use std::process::ExitStatus;

use crate::handover::Handover;

/// 의사 터미널에 붙일 프로세스의 명세. `std::process::Command` 가 아닌 이유는 Windows 다 —
/// ConPTY 에 프로세스를 붙이려면 프로세스를 스스로 띄워야 한다 (CROSS_PLATFORM_SRS §2.4).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcSpec {
    /// 실행 파일. 구분자가 없으면 이 프로세스의 PATH 로 찾는다(POSIX, Go `exec.Command`).
    pub path: String,
    /// args[0] 을 포함한 전체 argv.
    pub args: Vec<String>,
    /// "K=V" 목록. 완전한 환경이며 상속하지 않는다. 중복 키는 뒤엣것이 이긴다.
    /// Windows 에서 비어 있으면 이 프로세스의 환경을 물려받는다(Go 와 같다).
    pub env: Vec<String>,
    /// 작업 디렉터리. 비면 이 프로세스의 것이다.
    pub dir: String,
}

/// 의사 터미널을 만드는 능력.
pub trait Pty: Send + Sync {
    /// 새 의사 터미널을 만들고 그 안에 spec 을 띄운다. 크기 0 은 80×24 로 올린다.
    fn start(&self, spec: ProcSpec, cols: u16, rows: u16) -> io::Result<Box<dyn Terminal>>;
}

/// 의사 터미널의 마스터측과 거기 붙은 프로세스를 함께 소유한다.
/// 읽기·쓰기·크기 조절이 서로 다른 스레드에서 함께 일어나므로 모든 메서드가 `&self` 다.
pub trait Terminal: Send + Sync {
    /// 한 번 읽는다. `Ok(0)` 이 끝(Go `io.EOF`)이다. freeze 중이면 [`crate::Frozen`] 을 감싼 오류,
    /// 닫혔으면 [`closed_error`] 다.
    fn read(&self, buf: &mut [u8]) -> io::Result<usize>;
    /// 전부 쓴다. 성공하면 `buf.len()` 이다.
    fn write(&self, buf: &[u8]) -> io::Result<usize>;
    /// 터미널을 닫는다. 프로세스를 끝내지는 않는다. 기다리던 read 는 깨어난다.
    fn close(&self) -> io::Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;
    /// `(cols, rows)`.
    fn size(&self) -> io::Result<(u16, u16)>;
    /// 셸이 아닌 전경 프로그램의 프로세스 그룹 id. 없거나 모르거나 개념이 없으면 None (FR-TAN-6/24).
    fn foreground_pgid(&self) -> Option<i32>;
    /// 붙은 프로세스. 0 이면 없다.
    fn pid(&self) -> i32;
    /// 프로세스 종료를 기다리고 자원을 수확한다.
    fn wait(&self) -> io::Result<ExitStatus>;
    fn terminate(&self) -> io::Result<()>;
    fn kill(&self) -> io::Result<()>;
    /// 데몬 교체 능력. POSIX 터미널만 갖는다 (D-DSK-7).
    fn handover(&self) -> Option<&dyn Handover>;
}

/// Go `os.ErrClosed` — 닫힌 터미널에 대한 연산.
pub fn closed_error() -> io::Error {
    io::Error::other("file already closed")
}

pub(crate) fn current() -> &'static dyn Pty {
    #[cfg(unix)]
    {
        &posix::PosixPty
    }
    #[cfg(windows)]
    {
        &windows::WindowsPty
    }
}

pub(crate) const DEFAULT_COLS: u16 = 80;
pub(crate) const DEFAULT_ROWS: u16 = 24;

/// 크기의 하한. ConPTY 는 0 을 받으면 E_INVALIDARG 로 실패한다 — 두 어댑터가 같은 자리에서 막는다.
pub(crate) fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        if cols == 0 { DEFAULT_COLS } else { cols },
        if rows == 0 { DEFAULT_ROWS } else { rows },
    )
}

/// 중복 키를 뒤엣것으로 정리한다. `=` 로 시작하는 항목(Windows 드라이브별 cwd)과 `=` 가 없는
/// 항목은 그대로 둔다. fold 는 키 비교 규칙이다(Windows 는 대소문자를 접는다).
pub(crate) fn dedup_env(env: &[String], fold: fn(&str) -> String) -> Vec<String> {
    let mut seen = std::collections::HashMap::with_capacity(env.len());
    let mut out: Vec<String> = Vec::with_capacity(env.len());
    for kv in env {
        if kv.is_empty() {
            continue;
        }
        if kv.starts_with('=') {
            out.push(kv.clone());
            continue;
        }
        let Some((k, _)) = kv.split_once('=') else {
            out.push(kv.clone());
            continue;
        };
        let key = fold(k);
        if let Some(&i) = seen.get(&key) {
            out[i] = kv.clone();
            continue;
        }
        seen.insert(key, out.len());
        out.push(kv.clone());
    }
    out
}

#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn env_key_as_is(k: &str) -> String {
    k.to_owned()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn env_key_folded(k: &str) -> String {
    k.to_uppercase()
}

/// golang.org/x/sys/windows `EscapeArg` (v0.36.0).
#[cfg_attr(not(windows), allow(dead_code))]
fn escape_arg(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_owned();
    }
    let has_space = s.bytes().any(|b| b == b' ' || b == b'\t');
    let needs = has_space || s.bytes().any(|b| b == b'"' || b == b'\\');
    if !needs {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 2);
    if has_space {
        out.push('"');
    }
    let mut slashes = 0;
    for c in s.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes + 1));
                slashes = 0;
            }
            _ => slashes = 0,
        }
        out.push(c);
    }
    if has_space {
        out.extend(std::iter::repeat_n('\\', slashes));
        out.push('"');
    }
    out
}

/// golang.org/x/sys/windows `ComposeCommandLine` (v0.36.0). 프로그램 이름은 인용만 하고
/// 안쪽 따옴표는 걷는다 — CommandLineToArgvW 가 그 이름 안의 따옴표를 이스케이프할 길을 주지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn compose_command_line(args: &[String]) -> String {
    let Some((prog, rest)) = args.split_first() else {
        return String::new();
    };
    let must_quote = prog.is_empty()
        || prog
            .bytes()
            .enumerate()
            .any(|(i, c)| c <= b' ' || (c == b'"' && i == 0));
    let mut line = if must_quote {
        format!("\"{}\"", prog.replace('"', ""))
    } else {
        prog.clone()
    };
    for a in rest {
        line.push(' ');
        line.push_str(&escape_arg(a));
    }
    line
}

/// Go `envBlock` — 항목마다 NUL 로 끝내고 끝에 NUL 하나를 더한 UTF-16 블록. 빈 목록이면 None
/// (물려받는다). 항목에 NUL 이 있으면 Err(Go `UTF16FromString` 의 EINVAL).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn env_block(env: &[String]) -> Result<Option<Vec<u16>>, ()> {
    let mut block = Vec::new();
    for e in env.iter().filter(|e| !e.is_empty()) {
        if e.contains('\0') {
            return Err(());
        }
        block.extend(e.encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        return Ok(None);
    }
    block.push(0);
    Ok(Some(block))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn dedup_env_last_wins() {
        assert_eq!(
            dedup_env(
                &v(&["PATH=/usr/bin", "HOME=/h", "PATH=/usr/bin:/extra"]),
                env_key_as_is
            ),
            v(&["PATH=/usr/bin:/extra", "HOME=/h"])
        );
    }

    #[test]
    fn dedup_env_folds_case_for_windows() {
        let input = v(&["Path=C:\\Windows", "PATH=C:\\Windows;C:\\bin"]);
        assert_eq!(
            dedup_env(&input, env_key_folded),
            v(&["PATH=C:\\Windows;C:\\bin"])
        );
        assert_eq!(dedup_env(&input, env_key_as_is).len(), 2);
    }

    #[test]
    fn dedup_env_keeps_drive_entries() {
        let got = dedup_env(&v(&["=C:=C:\\work", "=D:=D:\\x", "PATH=a"]), env_key_folded);
        assert_eq!(got, v(&["=C:=C:\\work", "=D:=D:\\x", "PATH=a"]));
    }

    #[test]
    fn dedup_env_drops_empty_keeps_keyless() {
        assert_eq!(
            dedup_env(&v(&["", "A=1", "noeq"]), env_key_as_is),
            v(&["A=1", "noeq"])
        );
    }

    #[test]
    fn clamp_size_rejects_zero() {
        for (c, r, wc, wr) in [
            (0, 0, DEFAULT_COLS, DEFAULT_ROWS),
            (0, 30, DEFAULT_COLS, 30),
            (100, 0, 100, DEFAULT_ROWS),
            (100, 30, 100, 30),
        ] {
            assert_eq!(clamp_size(c, r), (wc, wr));
        }
    }

    #[test]
    fn env_block_shape() {
        assert_eq!(env_block(&[]), Ok(None));
        assert_eq!(env_block(&v(&["", ""])), Ok(None));
        let want: Vec<u16> = "A=1\0B=한\0\0".encode_utf16().collect();
        assert_eq!(env_block(&v(&["A=1", "", "B=한"])), Ok(Some(want)));
        assert_eq!(env_block(&v(&["A=\0"])), Err(()));
    }

    /// golang.org/x/sys/windows v0.36.0 `EscapeArg`·`ComposeCommandLine` 을 go1.27.2 로 돌린 실측값.
    #[test]
    fn windows_command_line() {
        for (input, want) in [
            ("", "\"\""),
            ("plain", "plain"),
            ("a b", "\"a b\""),
            ("a\tb", "\"a\tb\""),
            ("a\"b", "a\\\"b"),
            ("a\\b", "a\\b"),
            ("a\\\"b", "a\\\\\\\"b"),
            ("a b\\", "\"a b\\\\\""),
            ("C:\\Program Files\\x\\", "\"C:\\Program Files\\x\\\\\""),
        ] {
            assert_eq!(escape_arg(input), want, "{input:?}");
        }
        assert_eq!(compose_command_line(&[]), "");
        assert_eq!(compose_command_line(&v(&["pwsh.exe"])), "pwsh.exe");
        assert_eq!(
            compose_command_line(&v(&[
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "-NoLogo",
                "-c",
                "echo \"hi\""
            ])),
            "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -c \"echo \\\"hi\\\"\""
        );
        assert_eq!(compose_command_line(&v(&["\"q\"x", "a"])), "\"qx\" a");
        assert_eq!(compose_command_line(&v(&["", "a"])), "\"\" a");
    }
}
