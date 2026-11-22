//! 대화형 셸의 선택과 훅 주입 (FR-XSH-1).
//!
//! 두 제공자는 cfg 없이 컴파일되고, 환경·파일시스템을 주입받아 어느 호스트에서도 검사된다.
//! 경로 조립은 Go 와 같이 호스트의 `filepath` 규약을 따른다.

pub(crate) mod gopath;
pub(crate) mod lookpath;

use std::path::Path;
use std::sync::LazyLock;

use dm_shared_dmenv::ENV_SHELL;

use gopath::Conv;

/// 도구 하나를 띄울 셸의 명세.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellSpec {
    /// 실행 파일.
    pub path: String,
    /// argv[0] 을 뺀 인자.
    pub args: Vec<String>,
    /// 이 셸에만 필요한 추가 "K=V".
    pub env: Vec<String>,
}

/// 대화형 셸의 선택과 훅 주입 방식.
pub trait ShellProvider: Send + Sync {
    /// text 한 줄을 내보내고 끝나는 명령의 argv.
    fn echo_command(&self, text: &str) -> Vec<String>;
    /// cmdline 한 줄을 그 셸의 문법으로 실행하고 끝나는 명령의 argv (FR-BGP-3).
    fn run_command(&self, cmdline: &str) -> Vec<String>;
    /// 이 호스트의 대화형 셸 명세. bin_dir 은 헬퍼와 훅이 설치된 곳이다.
    fn shell(&self, bin_dir: &Path) -> ShellSpec;
    /// bin_dir 에 풀어야 할 훅 자산의 임베드 서브트리 이름 (FR-XSH-4).
    fn hook_root(&self) -> &'static str;
    /// s 를 이 셸에 그대로 타이핑해도 한 덩어리 리터럴로 남도록 인용한다.
    fn quote(&self, s: &str) -> String;
}

pub const POSIX_HOOK_ROOT: &str = "posix";
pub const WINDOWS_HOOK_ROOT: &str = "windows";
pub const BASH_HOOK_FILE: &str = "bash-hook.sh";
pub const POWERSHELL_HOOK_FILE: &str = "powershell-hook.ps1";

/// `os.Getenv`.
pub(crate) type EnvFn = Box<dyn Fn(&str) -> String + Send + Sync>;
/// "이 경로가 있는가" (`os.Stat` 성공).
pub(crate) type StatFn = Box<dyn Fn(&str) -> bool + Send + Sync>;
/// `exec.LookPath`. 찾지 못하면 `None`.
pub(crate) type LookFn = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// `os.Getenv` — 없거나 비면 빈 문자열이다.
pub(crate) fn os_env(k: &str) -> String {
    std::env::var_os(k)
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn stat_exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ── posix ────────────────────────────────────────────

const POSIX_SHELL_FALLBACKS: &[&str] = &["/bin/bash", "/bin/sh"];
const ZDOTDIR_NAME: &str = "zdotdir";

/// 상대경로 bin 에는 훅을 걸지 않는다 — 셸이 도구의 cwd 기준으로 풀어 사용자 저장소의 같은
/// 이름 파일이 실행된다. 판정은 호스트가 아니라 대상 규약으로 한다.
fn posix_abs(p: &str) -> bool {
    p.starts_with('/')
}

fn windows_abs(p: &str) -> bool {
    if p.starts_with(r"\\") {
        return true;
    }
    let b = p.as_bytes();
    b.len() >= 3 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct PosixShell {
    pub(crate) env: EnvFn,
    pub(crate) stat: StatFn,
}

impl PosixShell {
    #[cfg_attr(windows, allow(dead_code))]
    fn system() -> Self {
        PosixShell {
            env: Box::new(os_env),
            stat: Box::new(stat_exists),
        }
    }

    /// `$SHELL` 을 우선하고, 없거나 실재하지 않으면 차선으로 내려간다.
    fn pick(&self) -> String {
        let v = (self.env)("SHELL");
        if !v.is_empty() && (self.stat)(&v) {
            return v;
        }
        let c = POSIX_SHELL_FALLBACKS
            .iter()
            .find(|c| (self.stat)(c))
            .unwrap_or(&POSIX_SHELL_FALLBACKS[POSIX_SHELL_FALLBACKS.len() - 1]);
        (*c).to_owned()
    }
}

impl ShellProvider for PosixShell {
    fn echo_command(&self, text: &str) -> Vec<String> {
        vec![self.pick(), "-c".to_owned(), format!("echo {text}")]
    }

    fn run_command(&self, cmdline: &str) -> Vec<String> {
        vec![self.pick(), "-c".to_owned(), cmdline.to_owned()]
    }

    fn shell(&self, bin_dir: &Path) -> ShellSpec {
        let path = self.pick();
        let mut spec = ShellSpec {
            path: path.clone(),
            args: vec!["-l".to_owned()],
            env: vec![
                "LANG=en_US.UTF-8".to_owned(),
                "LC_ALL=en_US.UTF-8".to_owned(),
                "LC_CTYPE=en_US.UTF-8".to_owned(),
                // macOS /etc/zshrc_Apple_Terminal 의 세션 저장/복원을 끈다. /etc/zshrc 보다 먼저
                // 보여야 하므로 프로세스 환경에서 준다.
                "SHELL_SESSIONS_DISABLE=1".to_owned(),
                format!("SHELL={path}"),
            ],
        };
        let bin = path_str(bin_dir);
        if !posix_abs(&bin) {
            return spec;
        }
        // 셸 분기다. zsh 는 환경변수, bash 는 인자로 건다 (FR-HPR-7). bash 는 --rcfile 을 로그인
        // 셸에서 읽지 않으므로 -l 을 대신한다.
        if path.contains("zsh") {
            spec.env.push(format!(
                "ZDOTDIR={}",
                Conv::HOST.join(&[&bin, ZDOTDIR_NAME])
            ));
        } else if path.contains("bash") {
            spec.args = vec![
                "--rcfile".to_owned(),
                Conv::HOST.join(&[&bin, BASH_HOOK_FILE]),
            ];
        }
        spec
    }

    fn hook_root(&self) -> &'static str {
        POSIX_HOOK_ROOT
    }

    /// 홑따옴표 자신만 닫고(') 이스케이프한 뒤(\') 다시 연다(').
    fn quote(&self, s: &str) -> String {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

// ── windows ──────────────────────────────────────────

/// PowerShell 계열이 먼저다 — cmd.exe 에는 프롬프트 후크 자리가 없다.
const WIN_SHELL_CANDIDATES: &[&str] = &["pwsh.exe", "powershell.exe", "cmd.exe"];
const WIN_CMD: &str = "cmd.exe";
const COMSPEC_ENV: &str = "ComSpec";

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WindowsShell {
    pub(crate) env: EnvFn,
    pub(crate) look: LookFn,
}

/// PowerShell 이 홑따옴표로 읽는 문자. 굽은 따옴표도 문자열을 닫는다.
const POWERSHELL_SINGLE_QUOTES: &[char] = &['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// PowerShell 의 홑따옴표(축자) 문자열. 그 안의 홑따옴표 문자는 겹쳐 써서 리터럴로 남긴다.
/// Go 는 `'` 만 겹친다. 굽은 따옴표까지 겹치는 것은 보안 강화다 (RUST_PORT_SRS 3.7 D-2).
pub(crate) fn power_shell_quote(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('\'');
    for c in v.chars() {
        if POWERSHELL_SINGLE_QUOTES.contains(&c) {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// 스크립트를 현재 세션 스코프로 읽는 명령. -File 은 -NoExit 과 함께일 때 대화형 유지가
/// PowerShell 판본마다 달라 쓰지 않는다.
fn dot_source(path: &str) -> String {
    format!(". {}", power_shell_quote(path))
}

fn is_power_shell(path: &str) -> bool {
    let base = Conv::HOST.base(path).to_lowercase();
    base.contains("powershell") || base.contains("pwsh")
}

impl WindowsShell {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn system() -> Self {
        WindowsShell {
            env: Box::new(os_env),
            look: Box::new(lookpath::look_path),
        }
    }

    fn pick(&self) -> String {
        let v = (self.env)(ENV_SHELL);
        if !v.is_empty() {
            return v;
        }
        WIN_SHELL_CANDIDATES
            .iter()
            .find_map(|c| (self.look)(c))
            .unwrap_or_else(|| WIN_CMD.to_owned())
    }
}

impl ShellProvider for WindowsShell {
    /// cmd.exe 를 쓴다 — 가장 얇아 배관 문제와 기동 지연이 섞이지 않는다.
    fn echo_command(&self, text: &str) -> Vec<String> {
        let mut comspec = (self.env)(COMSPEC_ENV);
        if comspec.is_empty() {
            comspec = WIN_CMD.to_owned();
        }
        vec![comspec, "/c".to_owned(), format!("echo {text}")]
    }

    fn run_command(&self, cmdline: &str) -> Vec<String> {
        let path = self.pick();
        if is_power_shell(&path) {
            return vec![
                path,
                "-NoLogo".to_owned(),
                "-ExecutionPolicy".to_owned(),
                "Bypass".to_owned(),
                "-Command".to_owned(),
                cmdline.to_owned(),
            ];
        }
        vec![path, "/c".to_owned(), cmdline.to_owned()]
    }

    fn shell(&self, bin_dir: &Path) -> ShellSpec {
        let path = self.pick();
        let bin = path_str(bin_dir);
        // cmd.exe 로 떨어지면 훅이 없다 — 성능 저하이지 오류가 아니다 (FR-XSH-3).
        if !is_power_shell(&path) || !windows_abs(&bin) {
            return ShellSpec {
                path,
                ..ShellSpec::default()
            };
        }
        let hook = Conv::HOST.join(&[&bin, POWERSHELL_HOOK_FILE]);
        ShellSpec {
            path,
            args: vec![
                "-NoLogo".to_owned(),
                "-NoExit".to_owned(),
                "-ExecutionPolicy".to_owned(),
                "Bypass".to_owned(),
                "-Command".to_owned(),
                dot_source(&hook),
            ],
            env: Vec::new(),
        }
    }

    fn hook_root(&self) -> &'static str {
        WINDOWS_HOOK_ROOT
    }

    /// cmd.exe 로 떨어진 경우에는 맞지 않지만, cmd.exe 에는 개행을 담을 인용 자체가 없다.
    fn quote(&self, s: &str) -> String {
        power_shell_quote(s)
    }
}

pub(crate) fn current() -> &'static dyn ShellProvider {
    #[cfg(windows)]
    {
        static S: LazyLock<WindowsShell> = LazyLock::new(WindowsShell::system);
        &*S
    }
    #[cfg(not(windows))]
    {
        static S: LazyLock<PosixShell> = LazyLock::new(PosixShell::system);
        &*S
    }
}

#[cfg(test)]
pub(crate) mod tests;
