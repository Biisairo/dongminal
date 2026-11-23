//! 컨테이너 런타임의 상태와 설치·시작 안내 (SANDBOX_RUNTIME_SRS FR-SRT-1).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{ExecFn, RunOutput, combined_output};

pub const RUNTIME_OK: &str = "ok";
pub const RUNTIME_STOPPED: &str = "stopped";
pub const RUNTIME_MISSING: &str = "missing";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const UNKNOWN_START: &str = "docker 데몬을 시작하세요";
const DETAIL_MAX: usize = 400;

/// FR-SRT-1 의 응답이다. 명령은 서버가 정해 함께 싣는다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "sandbox.RuntimeStatus")]
pub struct RuntimeStatus {
    pub state: String,
    pub os: String,
    pub runtime: String,
    pub path: String,
    pub detail: String,
    #[serde(rename = "installCommand")]
    pub install_command: String,
    #[serde(rename = "startCommand")]
    pub start_command: String,
    #[serde(rename = "startTryable")]
    pub start_tryable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "sandbox.StartResult")]
pub struct StartResult {
    pub started: bool,
    pub command: String,
    pub detail: String,
}

struct RuntimeOs {
    install: &'static str,
    start: &'static [&'static str],
    tryable: bool,
}

fn runtime_for(goos: &str) -> Option<RuntimeOs> {
    match goos {
        "darwin" => Some(RuntimeOs {
            install: "brew install --cask docker",
            start: &["open", "-a", "Docker"],
            tryable: true,
        }),
        "windows" => Some(RuntimeOs {
            install: "winget install Docker.DockerDesktop",
            start: &["cmd", "/c", "start", "", "Docker Desktop.exe"],
            tryable: true,
        }),
        "linux" | "wsl" => Some(RuntimeOs {
            install: "curl -fsSL https://get.docker.com | sh",
            start: &["sudo", "systemctl", "start", "docker"],
            tryable: false,
        }),
        _ => None,
    }
}

fn tail(r: &RunOutput) -> String {
    dm_shared_diagtail::of_str(&r.out, r.err.as_deref(), DETAIL_MAX)
}

/// 런타임 상태를 잰다: 바이너리가 없으면 missing, `docker info` 가 실패하면 stopped.
pub fn probe(
    goos: &str,
    look: &dyn Fn(&str) -> Result<String, String>,
    run: &ExecFn<'_>,
) -> RuntimeStatus {
    let (start_command, start_tryable) = start_command(goos);
    let mut st = RuntimeStatus {
        os: goos.into(),
        runtime: "docker".into(),
        install_command: install_command(goos),
        start_command,
        start_tryable,
        ..Default::default()
    };
    let Ok(path) = look("docker") else {
        st.state = RUNTIME_MISSING.into();
        return st;
    };
    let r = run(
        &path,
        &[
            "info".into(),
            "--format".into(),
            "{{.ServerVersion}}".into(),
        ],
    );
    st.path = path;
    if r.err.is_none() {
        st.state = RUNTIME_OK.into();
        return st;
    }
    st.state = RUNTIME_STOPPED.into();
    st.detail = tail(&r);
    st
}

fn command_line(args: &[&str]) -> String {
    args.iter()
        .map(|a| {
            if a.is_empty() || a.contains(' ') {
                format!("\"{a}\"")
            } else {
                (*a).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 런타임을 시작하는 명령과, 서버가 대신 시도할 수 있는가다.
pub fn start_command(goos: &str) -> (String, bool) {
    match runtime_for(goos) {
        Some(r) => (command_line(r.start), r.tryable),
        None => (UNKNOWN_START.into(), false),
    }
}

/// 시도할 수 있으면 시작 명령을 실행한다.
pub fn start_runtime(goos: &str, run: &ExecFn<'_>) -> StartResult {
    let (command, tryable) = start_command(goos);
    let mut res = StartResult {
        command,
        ..Default::default()
    };
    let Some(r) = runtime_for(goos).filter(|_| tryable) else {
        return res;
    };
    let args: Vec<String> = r.start[1..].iter().map(|s| (*s).to_string()).collect();
    let out = run(r.start[0], &args);
    if out.err.is_some() {
        res.detail = tail(&out);
        return res;
    }
    res.started = true;
    res
}

/// 설치 명령이다. 모르는 OS 면 "".
pub fn install_command(goos: &str) -> String {
    runtime_for(goos)
        .map(|r| r.install.to_string())
        .unwrap_or_default()
}

/// 상태 조회용 실행(3초 상한)이다.
pub fn cli_exec(path: &str, args: &[String]) -> RunOutput {
    combined_output(path, args, Some(PROBE_TIMEOUT))
}

/// 시작 명령 실행(상한 없음)이다.
pub fn start_exec(path: &str, args: &[String]) -> RunOutput {
    combined_output(path, args, None)
}
