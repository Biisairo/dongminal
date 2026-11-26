//! Go 기준선 `otterminal/internal/shared/agentadapter` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 에이전트별 지식을 선언 테이블 하나로 모은다 (RUN_ORCHESTRATION_SRS FR-ADP-1~6).
//! 이 crate 는 정책을 담지 않는다 (FR-ADP-6). 확인하지 못한 값은 비워 둔다.

mod claude;
mod codex;
mod install;
mod omp;
mod resume;

use std::fmt;
use std::path::PathBuf;

use otter_gocompat::json::RawMessage;
use otter_gocompat::{filepath, strconv};
use otter_shared_platform::ShellProvider;

pub use claude::CHAT_WAIT_TIMEOUT_SECS;
pub use install::InstallSpec;
pub use omp::{OMP_MEMBER_CONFIG_FILE, OMP_SHIM_FILE};
pub use resume::valid_session_id;

/// 어댑터 조회·기동줄·재개줄의 오류. `Display` 는 Go 의 오류 문구와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// `ErrUnknownAgent` (FR-ADP-3).
    UnknownAgent { id: String },
    /// `ErrNoResume` (RUN_RECOVERY_SRS FR-RRC-1).
    NoResume { agent: String },
    /// `ErrBadSession` (FR-RRC-4).
    BadSession,
    /// `MemberArgs` 의 자리를 채울 경로가 없다 (FR-OMP-22).
    UnfilledToken { agent: String, arg: String },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownAgent { id } => write!(
                f,
                "unknown_agent: {} (알려진 것: {})",
                strconv::quote(id),
                ids().join(", ")
            ),
            Self::NoResume { agent } => write!(f, "no_resume: {agent}"),
            Self::BadSession => f.write_str("bad_session"),
            Self::UnfilledToken { agent, arg } => write!(
                f,
                "{agent}: {} 의 자리를 채울 경로가 없다",
                strconv::quote(arg)
            ),
        }
    }
}

impl std::error::Error for Error {}

/// 에이전트 훅 이벤트(stdin JSON)를 파싱한 결과다. 상태 값은 활동 어휘를 그대로 쓴다.
/// 신호를 주지 않는 에이전트에서는 곁들이 값이 비어 있다 — "모른다"다 (FR-CBG-5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub state: String,
    pub tool: String,
    pub detail: String,
    pub session_id: String,
    /// 대화 기록 파일의 경로다. 내용은 싣지 않는다 (NFR-4).
    pub transcript: String,
    /// 컨텍스트 압축의 확정 신호 (FR-CBG-1).
    pub compacted: bool,
    /// 서브에이전트 활동 (FR-ASV-2·5). `state` 가 비면 main 상태는 보고하지 않는다.
    pub sub: Option<SubReport>,
    /// 훅 이름 (FR-TGB-80).
    pub hook: String,
    /// 사람의 답을 기다리는 훅의 도구 입력 원문. 비면 Go 의 nil 이다 (FR-TGB-81).
    pub input: RawMessage,
    pub input_over: bool,
}

/// `Report::input` 의 상한이다 (FR-TGB-81).
pub const BRIDGE_INPUT_MAX: usize = 16 << 10;

/// 서브에이전트 하나의 활동 보고다 (FR-ASV-5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubReport {
    pub agent_id: String,
    pub agent_type: String,
    pub state: String,
    pub tool: String,
    pub detail: String,
}

/// 초기 프롬프트를 에이전트에 전달하는 방식이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptInjection {
    /// 기동 커맨드의 위치 인자로 싣는다.
    Argv,
    /// 기동 후 준비완료를 기다렸다가 붙여넣는다.
    StdinAfterStart,
}

impl PromptInjection {
    /// 와이어 값 (`argv` · `stdin-after-start`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Argv => "argv",
            Self::StdinAfterStart => "stdin-after-start",
        }
    }
}

/// 세션 스코프 정책 주입 방식 (FR-ADP-5). 값(경로)은 런타임의 것이라 플래그 이름만 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyInjection {
    pub flags: &'static [&'static str],
    pub session_scoped: bool,
    /// 셸 함수 대신 PATH shim(`bin/agent-shims/<명령>`)이 붙이는가 (FR-CAC-83).
    pub shim: bool,
}

/// 이 에이전트가 실제로 낼 수 있는 신호의 선언이다 (FR-AEV-2·3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Signals {
    pub idle: bool,
    pub working: bool,
    pub waiting: bool,
    pub done: bool,
    pub ended: bool,
    pub compaction: bool,
    pub tool_detail: bool,
    pub session: bool,
}

/// 준비완료를 무엇으로 아는가다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Readiness {
    pub hooks: bool,
    /// FR-STA-4 2단계의 자리. 소비자가 없으므로 비워 둔다.
    pub screen_patterns: &'static [&'static str],
}

/// 전사본 한 줄이 말하는 사용량이다 (FR-AAC-12). 숫자와 모델 이름뿐이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    pub tokens: i64,
    pub model: String,
}

/// 훅 stdin JSON 을 활동 보고로 바꾼다. 받지 않는 입력이면 `None` (FR-ADP-2).
pub type HookParseFn = fn(&[u8]) -> Option<Report>;
/// 세션 등록부에서 그 세션의 pid 들. 등록부를 읽지 못하면 `None` — "모른다" (FR-RRC-5).
pub type SessionPidsFn = fn(&str, &[PathBuf]) -> Option<Vec<i64>>;

/// 에이전트 하나의 선언이다 (FR-ADP-1). `Option` 필드의 `None` 은 "하지 않는다"는 선언이다.
#[derive(Debug, Clone, Copy)]
pub struct Adapter {
    pub id: &'static str,
    pub detect_cmd: &'static str,
    pub launch: &'static [&'static str],
    /// 비어 있으면 모델 지정 방법을 확인하지 못했다 — 기동줄에서 조용히 생략된다.
    pub model_flag: &'static str,
    pub prompt_injection: PromptInjection,
    /// 위치 인자 프롬프트 바로 앞의 구분자. 가변 인자 플래그가 프롬프트를 삼키지 않게 한다.
    pub argv_separator: &'static str,
    /// Run 멤버로 띄울 때 덧붙는 인자. [`HOOKS_DIR_TOKEN`] 은 런타임이 채운다.
    pub member_args: &'static [&'static str],
    pub policy_injection: PolicyInjection,
    pub hook_parse: HookParseFn,
    pub signals: Signals,
    pub readiness: Readiness,
    /// 활동을 `notify` 경로로만 보고한다 (FR-AAC-31).
    pub activity_from_notify: bool,
    /// statusLine 프록시가 사용량을 보고한다 (FR-ASV-20).
    pub status_line_reporter: bool,
    /// 정중한 종료 지시. 비어 있으면 미확인이다 (FR-RUN-11a).
    pub exit_command: &'static str,
    /// 세션 id 로 재개할 때 Launch 뒤에 붙일 인자 (FR-RRC-1).
    pub resume: Option<fn(&str) -> Vec<String>>,
    pub session_pids: Option<SessionPidsFn>,
    /// 디스크에 놓아야 할 것을 쓴다 (FR-AAC-1).
    pub install_assets: Option<fn(&InstallSpec) -> std::io::Result<()>>,
    /// 전사본 한 줄에서 사용량을 뽑는다 (FR-AAC-10).
    pub parse_usage: Option<fn(&str) -> Option<Usage>>,
    /// 모델 이름이 말하는 컨텍스트 창 크기 (FR-AAC-20).
    pub context_window: Option<fn(&str) -> Option<f64>>,
}

/// `member_args` 안에서 런타임이 채우는 자리다 (FR-OMP-22).
pub const HOOKS_DIR_TOKEN: &str = "{{otterHooks}}";

/// 선언 전부다. id 순으로 둔다.
static REGISTRY: [&Adapter; 3] = [&claude::ADAPTER, &codex::ADAPTER, &omp::ADAPTER];

/// 에이전트 id 로 어댑터를 찾는다. 알 수 없는 id 는 오류다 — 폴백하지 않는다 (FR-ADP-3).
pub fn get(id: &str) -> Result<&'static Adapter, Error> {
    REGISTRY
        .iter()
        .copied()
        .find(|a| a.id == id)
        .ok_or_else(|| Error::UnknownAgent { id: id.to_owned() })
}

/// 선언된 에이전트 id 를 정렬해 낸다.
pub fn ids() -> Vec<&'static str> {
    let mut out: Vec<_> = REGISTRY.iter().map(|a| a.id).collect();
    out.sort_unstable();
    out
}

fn sorted() -> impl Iterator<Item = &'static Adapter> {
    ids().into_iter().filter_map(|id| get(id).ok())
}

/// statusLine 사용량을 보고하는 에이전트의 id (FR-ASV-20). 여럿이면 id 순으로 첫째다.
pub fn status_line_reporter() -> Option<&'static str> {
    sorted().find(|a| a.status_line_reporter).map(|a| a.id)
}

/// PATH shim 으로 정책을 주입하는 에이전트의 명령 이름 (FR-CAC-83).
pub fn shim_commands() -> Vec<&'static str> {
    sorted()
        .filter(|a| a.policy_injection.shim)
        .map(|a| a.detect_cmd)
        .collect()
}

/// 전경 프로그램 이름이 그 어댑터의 실행 파일인 어댑터 (PEER_NETWORK_SRS §1.4).
pub fn by_command(name: &str) -> Option<&'static Adapter> {
    if name.is_empty() {
        return None;
    }
    REGISTRY.iter().copied().find(|a| a.detect_cmd == name)
}

impl Adapter {
    /// 이 어댑터의 실행 파일이 이 기계에 있는가. OTTERMINAL_AGENT_BIN_DIR 을 먼저, 그다음 PATH 를 본다.
    pub fn installed(&self) -> bool {
        let dir = std::env::var(otter_shared_otterenv::ENV_AGENT_BIN_DIR).unwrap_or_default();
        if !dir.is_empty()
            && otter_shared_platform::look_path(&filepath::join(&[dir.as_str(), self.detect_cmd]))
                .is_some()
        {
            return true;
        }
        otter_shared_platform::look_path(self.detect_cmd).is_some()
    }

    /// 도구의 셸에 그대로 타이핑할 기동 명령줄이다. 인용은 호스트 셸이 정한다 (FR-XBD-3).
    /// prompt_injection 이 argv 가 아니면 프롬프트를 싣지 않는다 (FR-PRE-8).
    pub fn launch_line(&self, hooks_dir: &str, model: &str, prompt: &str) -> Result<String, Error> {
        self.launch_line_in(
            otter_shared_platform::current().shell,
            hooks_dir,
            model,
            prompt,
        )
    }

    /// [`Adapter::launch_line`] 과 같되 인용할 셸을 받는다 (CROSS_PLATFORM_SRS §4.2).
    pub fn launch_line_in(
        &self,
        sh: &dyn ShellProvider,
        hooks_dir: &str,
        model: &str,
        prompt: &str,
    ) -> Result<String, Error> {
        let mut parts: Vec<String> = self.launch.iter().map(|s| (*s).to_owned()).collect();
        if !model.is_empty() && !self.model_flag.is_empty() {
            parts.push(self.model_flag.to_owned());
            parts.push(sh.quote(model));
        }
        parts.extend(self.member_args_in(sh, hooks_dir)?);
        if self.prompt_injection == PromptInjection::Argv && !prompt.is_empty() {
            if !self.argv_separator.is_empty() {
                parts.push(self.argv_separator.to_owned());
            }
            parts.push(sh.quote(prompt));
        }
        Ok(parts.join(" "))
    }

    /// 인용을 마친 member_args. 자리를 먼저 채우고 OS 표기로 맞춘 뒤 인용한다 (FR-OMP-22).
    fn member_args_in(
        &self,
        sh: &dyn ShellProvider,
        hooks_dir: &str,
    ) -> Result<Vec<String>, Error> {
        let mut parts = Vec::with_capacity(self.member_args.len());
        for arg in self.member_args {
            let mut arg = (*arg).to_owned();
            if arg.contains(HOOKS_DIR_TOKEN) {
                if hooks_dir.is_empty() {
                    return Err(Error::UnfilledToken {
                        agent: self.id.to_owned(),
                        arg,
                    });
                }
                arg = filepath::from_slash(&arg.replace(HOOKS_DIR_TOKEN, hooks_dir));
            }
            parts.push(sh.quote(&arg));
        }
        Ok(parts)
    }
}
