//! OS 비밀 저장소 (CLAUDE_ACCOUNTS_SRS FR-CAC-4). macOS 만 키체인이 있다. 다른 OS 는
//! `available()` 이 false 이고, 호출부는 파일 저장으로 내려간다.

use std::fmt;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use otter_gocompat::oserr::{go_error_string, path_error};

use crate::shell::{EnvFn, os_env};
use otter_gocompat::filepath;

/// 비밀 저장소의 오류. 문구는 Go 와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretsError {
    /// 이 OS 에 비밀 저장소가 없다.
    Unavailable,
    /// `security -i` 로 쓰기에는 값이 너무 길다.
    TooLong,
    Other(String),
}

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretsError::Unavailable => f.write_str("비밀 저장소가 없습니다"),
            SecretsError::TooLong => f.write_str("keychain write: value too long for security -i"),
            SecretsError::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for SecretsError {}

/// OS 의 비밀 저장소.
pub trait Secrets: Send + Sync {
    fn available(&self) -> bool;
    /// Claude Code 가 키체인 항목에 쓰는 계정명.
    fn account(&self) -> String;
    /// 값을 읽는다. 항목이 없으면 `Ok(None)`.
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), SecretsError>;
    /// 항목을 지운다. 없으면 성공이다.
    fn delete(&self, service: &str, account: &str) -> Result<(), SecretsError>;
}

/// 비밀 저장소가 없는 OS 의 구현.
#[cfg_attr(target_os = "macos", allow(dead_code))]
struct NoSecrets;

/// Claude Code 가 키체인 항목에 쓰는 기본 계정명.
const KEYCHAIN_DEFAULT_ACCOUNT: &str = "claude-code-user";

impl Secrets for NoSecrets {
    fn available(&self) -> bool {
        false
    }
    fn account(&self) -> String {
        KEYCHAIN_DEFAULT_ACCOUNT.to_owned()
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), SecretsError> {
        Ok(())
    }
}

const KEYCHAIN_SECURITY_BIN: &str = "/usr/bin/security";
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(5);
const KEYCHAIN_NOT_FOUND: i32 = 44;
const KEYCHAIN_LINE_MAX: usize = 4032;
/// 기한 안에서 끝났는가를 다시 보는 간격. Go 는 기한이 지나는 순간 죽이므로 짧게 둔다.
const KEYCHAIN_POLL: Duration = Duration::from_millis(5);
/// Go 가 기한이 지나 죽인 프로세스의 `Wait` 오류 문구.
const KILLED_TEXT: &str = "signal: killed";

/// 명령을 돌려 표준 출력과 종료 코드를 낸다. 실행 자체가 실패하면 Go 오류 문구가 `Err` 다.
pub(crate) type RunFn =
    Box<dyn Fn(Option<&[u8]>, &str, &[&str]) -> Result<(Vec<u8>, i32), String> + Send + Sync>;
/// `os.UserHomeDir`. 실패는 `None`.
pub(crate) type HomeFn = Box<dyn Fn() -> Option<String> + Send + Sync>;

/// `/usr/bin/security` 로 키체인을 다룬다. 값은 argv 에 싣지 않고 `security -i` 의 표준
/// 입력으로 hex 로 보낸다 (cswap `macos_keychain.py` 와 같은 규약).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct MacKeychain {
    run: RunFn,
    env: EnvFn,
    home: HomeFn,
}

fn hex_encode(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &c in b {
        s.push(char::from(DIGITS[usize::from(c >> 4)]));
        s.push(char::from(DIGITS[usize::from(c & 0x0f)]));
    }
    s
}

fn keychain_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

impl MacKeychain {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn system() -> Self {
        MacKeychain {
            run: Box::new(run_with_stdin),
            env: Box::new(os_env),
            home: Box::new(user_home_dir),
        }
    }
}

impl Secrets for MacKeychain {
    fn available(&self) -> bool {
        true
    }

    fn account(&self) -> String {
        let u = (self.env)("USER");
        if !u.is_empty() {
            return u;
        }
        if let Some(h) = (self.home)() {
            let b = filepath::base(&h);
            if !b.is_empty() && b != "." && b != "/" {
                return b;
            }
        }
        KEYCHAIN_DEFAULT_ACCOUNT.to_owned()
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError> {
        let args = ["find-generic-password", "-a", account, "-w", "-s", service];
        let (out, code) = (self.run)(None, KEYCHAIN_SECURITY_BIN, &args)
            .map_err(|e| SecretsError::Other(format!("keychain read: {e}")))?;
        match code {
            0 => {
                let s = String::from_utf8_lossy(&out);
                Ok(Some(s.strip_suffix('\n').unwrap_or(&s).to_owned()))
            }
            KEYCHAIN_NOT_FOUND => Ok(None),
            _ => Err(SecretsError::Other(format!(
                "keychain read failed (rc={code})"
            ))),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), SecretsError> {
        let line = format!(
            "add-generic-password -U -a {} -s {} -X {}\n",
            keychain_quote(account),
            keychain_quote(service),
            hex_encode(value.as_bytes())
        );
        // 값을 argv 로 넘기지 않는다 — 같은 컴퓨터의 다른 사용자가 ps 로 볼 수 있다.
        // 호출하는 쪽이 파일로 내려간다 (FR-CAC-4·6).
        if line.len() > KEYCHAIN_LINE_MAX {
            return Err(SecretsError::TooLong);
        }
        let (_, code) = (self.run)(Some(line.as_bytes()), KEYCHAIN_SECURITY_BIN, &["-i"])
            .map_err(|e| SecretsError::Other(format!("keychain write: {e}")))?;
        if code != 0 {
            return Err(SecretsError::Other(format!(
                "keychain write failed (rc={code})"
            )));
        }
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), SecretsError> {
        let args = ["delete-generic-password", "-a", account, "-s", service];
        let (_, code) = (self.run)(None, KEYCHAIN_SECURITY_BIN, &args)
            .map_err(|e| SecretsError::Other(format!("keychain delete: {e}")))?;
        if code != 0 && code != KEYCHAIN_NOT_FOUND {
            return Err(SecretsError::Other(format!(
                "keychain delete failed (rc={code})"
            )));
        }
        Ok(())
    }
}

/// `os.UserHomeDir`(unix): `$HOME`, 비면 실패.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn user_home_dir() -> Option<String> {
    let h = os_env("HOME");
    (!h.is_empty()).then_some(h)
}

/// [`RunFn`] 의 실제 구현. 종료 코드가 0 이 아닌 것은 오류가 아니다. 기한
/// ([`KEYCHAIN_TIMEOUT`])이 지나면 죽이고 Go 와 같이 `signal: killed` 를 낸다.
/// 표준 입력이 없으면 /dev/null, 표준 오류는 버린다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run_with_stdin(
    stdin: Option<&[u8]>,
    name: &str,
    args: &[&str],
) -> Result<(Vec<u8>, i32), String> {
    let prog = crate::command_path(name)?;
    let mut cmd = Command::new(&prog);
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| go_error_string(&path_error("fork/exec", &prog, e)))?;
    let deadline = Instant::now() + KEYCHAIN_TIMEOUT;
    let writer = match (child.stdin.take(), stdin) {
        (Some(mut w), Some(data)) => {
            let data = data.to_vec();
            // 쓰기 실패(EPIPE 등)는 Go 와 같이 결과에 넣지 않는다 — 종료 코드가 말한다.
            Some(thread::spawn(move || {
                let _ = w.write_all(&data);
            }))
        }
        _ => None,
    };
    let reader = child.stdout.take().map(|mut r| {
        thread::spawn(move || {
            let mut out = Vec::new();
            let _ = r.read_to_end(&mut out);
            out
        })
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(KILLED_TEXT.to_owned());
            }
            Ok(None) => thread::sleep(KEYCHAIN_POLL),
            Err(e) => break Err(go_error_string(&e)),
        }
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    let out = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let st = status?;
    Ok((out, st.code().unwrap_or(-1)))
}

pub(crate) fn current() -> &'static dyn Secrets {
    #[cfg(target_os = "macos")]
    {
        static S: std::sync::LazyLock<MacKeychain> = std::sync::LazyLock::new(MacKeychain::system);
        &*S
    }
    #[cfg(not(target_os = "macos"))]
    {
        &NoSecrets
    }
}

#[cfg(test)]
mod tests;
