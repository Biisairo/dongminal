//! 대화형 셸의 선택과 훅 주입 (FR-XSH-1). 구현은 이슈 1.4.3 이 채운다.

use std::path::Path;

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

struct Pending;

impl ShellProvider for Pending {
    fn echo_command(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn run_command(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn shell(&self, _: &Path) -> ShellSpec {
        ShellSpec::default()
    }
    fn hook_root(&self) -> &'static str {
        if cfg!(windows) {
            WINDOWS_HOOK_ROOT
        } else {
            POSIX_HOOK_ROOT
        }
    }
    fn quote(&self, s: &str) -> String {
        s.to_owned()
    }
}

pub(crate) fn current() -> &'static dyn ShellProvider {
    &Pending
}
