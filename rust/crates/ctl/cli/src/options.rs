//! 액션 옵션 해석 (CLI_CONSOLIDATION_SRS 묶음 A·B·C). 부수효과가 없다.

use std::fmt;
use std::io::Write;
use std::path::Path;

use dm_gocompat::filepath;
use dm_shared_dmenv as dmenv;
use dm_shared_serverconf as serverconf;

use crate::env::Env;
use crate::help::usage;

pub const ENV_PORT: &str = serverconf::ENV_PORT_LEGACY;
pub const ENV_HOME: &str = dmenv::ENV_HOME;
pub const ENV_HOST: &str = dmenv::ENV_HOST;
pub const ENV_LOG: &str = dmenv::ENV_LOG_FILE;
/// 이 실행이 위임된 재시작 대리임을 알린다 (FR-ACT-3b).
pub const ENV_RESTART_RUNNER: &str = dmenv::ENV_RESTART_RUNNER;
/// 도구의 셸에 심기는 도구 식별자다. 있으면 dongminal 도구 안에서 돌고 있다 (FR-ACT-3a).
pub const ENV_TOOL_ID: &str = dmenv::ENV_TOOL_ID;
pub const DEFAULT_PORT: &str = dmenv::DEFAULT_PORT;
pub const DEFAULT_HOST: &str = dmenv::DEFAULT_HOST;
pub const EXPOSE_HOST: &str = "0.0.0.0";

const LOG_FILE_NAME: &str = dmenv::SERVER_LOG_FILE;

/// 파서의 실패다. `Help` 는 -h/--help 이고 액션의 부수효과는 일어나지 않는다 (FR-CLI-6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    Help,
    Invalid(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::Help => f.write_str("help requested"),
            ParseError::Invalid(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ParseError {}

pub(crate) fn invalid(m: impl Into<String>) -> ParseError {
    ParseError::Invalid(m.into())
}

/// 배경 모드 기동이 출력을 남길 자리다. 홈이 있으면 그 아래이고, 홈을 모르면(`usage_start`)
/// OS 의 자리다 (FR-STR-33, FR-XPA-2).
pub fn default_log_file(home: &str) -> String {
    if !home.is_empty() {
        return filepath::join(&[home, LOG_FILE_NAME]);
    }
    dm_shared_platform::current()
        .paths
        .default_log_file()
        .to_string_lossy()
        .into_owned()
}

/// Go `strconv.Atoi` 가 받는 모양만 받는다(부호 하나와 10진 숫자).
pub(crate) fn atoi(s: &str) -> Option<i64> {
    s.parse().ok()
}

/// 모든 액션이 공유하는 옵션이다 (FR-CLI-9). 빈 문자열은 지정하지 않음이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Common {
    pub port: String,
    pub home: String,
}

impl Common {
    /// args[*i] 가 공통 옵션이면 소비하고 true 다. `--port 8080` 과 `--port=8080` 을 모두 받는다.
    pub(crate) fn take(&mut self, args: &[String], i: &mut usize) -> Result<bool, ParseError> {
        let a = args[*i].as_str();
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (a, None),
        };
        let dst = match name {
            "--port" => &mut self.port,
            "--home" => &mut self.home,
            _ => return Ok(false),
        };
        match inline {
            Some("") => return Err(invalid(format!("{name} 에 값이 없습니다"))),
            Some(v) => *dst = v.to_owned(),
            None => {
                if *i + 1 >= args.len() {
                    return Err(invalid(format!("{name} 에 값이 없습니다")));
                }
                *i += 1;
                *dst = args[*i].clone();
            }
        }
        if name == "--port" && !atoi(dst).is_some_and(|n| (1..=65535).contains(&n)) {
            return Err(invalid(format!("--port 값이 포트 번호가 아닙니다: {dst}")));
        }
        Ok(true)
    }

    /// 하위 명령이 모르는 인자를 Common 에 넘긴다. Common 도 모르면 그 명령의 unknown_flag 다
    /// (FR-RDG-25).
    pub(crate) fn take_or(
        &mut self,
        action: &str,
        args: &[String],
        i: &mut usize,
    ) -> Result<(), ParseError> {
        if self.take(args, i)? {
            return Ok(());
        }
        Err(unknown_flag(action, &args[*i]))
    }

    /// 플래그 > 환경변수 > 기본값 순으로 포트를 정한다 (FR-CLI-9).
    pub fn resolve_port(&self) -> String {
        self.resolve_port_in(&Env::process())
    }

    pub(crate) fn resolve_port_in(&self, env: &Env<'_>) -> String {
        if !self.port.is_empty() {
            return self.port.clone();
        }
        let v = env.get(ENV_PORT);
        if !v.is_empty() {
            return v;
        }
        DEFAULT_PORT.to_owned()
    }

    /// 플래그 > 환경변수 > 기본값 순으로 홈을 정한다 (FR-CLI-9).
    pub fn resolve_home(&self) -> Result<String, String> {
        self.resolve_home_in(&Env::process())
    }

    pub(crate) fn resolve_home_in(&self, env: &Env<'_>) -> Result<String, String> {
        if !self.home.is_empty() {
            return Ok(expand_tilde(&self.home, env));
        }
        let v = env.get(ENV_HOME);
        if !v.is_empty() {
            return Ok(expand_tilde(&v, env));
        }
        let user = env
            .user_home_dir()
            .map_err(|e| format!("홈 디렉터리 확인 실패: {e}"))?;
        Ok(filepath::join(&[user.as_str(), dmenv::DEFAULT_HOME_DIR]))
    }

    /// 겨누는 명령이 쓰는 단일 해석이다 (FR-STR-22). 계층은 플래그 > 주소 파일 > `server.json` >
    /// 기본값이다 (FR-HRB-7). 오류는 두드리기 전에 돌려준다.
    pub fn resolve_target(&self) -> Result<Target, String> {
        self.resolve_target_in(&Env::process())
    }

    pub(crate) fn resolve_target_in(&self, env: &Env<'_>) -> Result<Target, String> {
        let home = self.resolve_home_in(env)?;
        let getenv = |k: &str| env.get(k);
        let conf = serverconf::resolve(&serverconf::Inputs {
            home: Path::new(&home),
            flag_port: &self.port,
            getenv: Some(&getenv),
            ..Default::default()
        });
        if let Some(e) = conf.err() {
            return Err(e.to_string());
        }
        let (mut host, mut port) = (conf.host.value, conf.port.value);
        if self.port.is_empty()
            && let Some((h, p)) = serverconf::read_addr(Path::new(&home))
        {
            (host, port) = (h, p);
        }
        Ok(Target {
            url: dmenv::base_url(&host, &port),
            host: dmenv::dial_host(&host),
            home,
            port,
            warnings: conf.warnings,
        })
    }
}

/// 이 명령이 겨누는 서버다. `start` 와 같은 규칙으로 정한다 (FR-WIN-2, FR-STR-22).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Target {
    pub home: String,
    /// 미지정 주소(`0.0.0.0`·`::`)를 접속 주소로 바꾼 값이다.
    pub host: String,
    pub port: String,
    /// `dmenv::base_url(host, port)` 다.
    pub url: String,
    /// `serverconf` 가 낸 경고다. 버리지 않는다 (FR-CFG-15).
    pub warnings: Vec<String>,
}

impl Target {
    /// 해석 경고를 찍는다. 막지 않는다 (FR-CFG-15 / D-CFG-3).
    pub fn warn(&self, stderr: &mut dyn Write) {
        for w in &self.warnings {
            let _ = writeln!(stderr, "⚠ {w}");
        }
    }
}

/// 선행 `~/` 만 사용자 홈으로 편다. 사용자 홈을 모르면 그대로 둔다.
pub(crate) fn expand_tilde(p: &str, env: &Env<'_>) -> String {
    if (p == "~" || p.starts_with("~/"))
        && let Ok(h) = env.user_home_dir()
    {
        let rest = p.strip_prefix('~').unwrap_or(p);
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        return filepath::join(&[h.as_str(), rest]);
    }
    p.to_owned()
}

pub(crate) fn unknown_flag(action: &str, a: &str) -> ParseError {
    invalid(format!("알 수 없는 옵션: {a}\n\n{}", usage(action)))
}

/// `dongminal start` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartOpts {
    pub common: Common,
    pub expose: bool,
    /// 데몬에 아무것도 묻지 않고 서버만 다시 띄운다 (FR-DSK-4).
    pub server_only: bool,
    /// 데몬을 끝내고 새로 띄운다. 터미널 세션을 잃는다 (FR-DSK-5).
    pub refresh_daemon: bool,
    pub isolated: bool,
    pub foreground: bool,
}

const ERR_RESTART_DAEMON_REMOVED: &str = "--restart-daemon 은 없어졌습니다.
  세션을 유지하며 데몬을 바꾸려면: dongminal start
  세션을 버리고 새로 띄우려면:    dongminal start --refresh-daemon";

const ERR_START_DAEMON_FLAGS: &str = "--server-only 와 --refresh-daemon 은 함께 쓸 수 없습니다";

pub fn parse_start(args: &[String]) -> Result<StartOpts, ParseError> {
    let mut o = StartOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--expose" => o.expose = true,
            "--server-only" => o.server_only = true,
            "--refresh-daemon" => o.refresh_daemon = true,
            "--restart-daemon" => return Err(invalid(ERR_RESTART_DAEMON_REMOVED)),
            "--isolated" => o.isolated = true,
            "--foreground" => o.foreground = true,
            "-h" | "--help" => return Err(ParseError::Help),
            _ => o.common.take_or("start", args, &mut i)?,
        }
        i += 1;
    }
    if o.server_only && o.refresh_daemon {
        return Err(invalid(ERR_START_DAEMON_FLAGS));
    }
    Ok(o)
}

/// `dongminal stop` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StopOpts {
    pub common: Common,
    pub all: bool,
}

pub fn parse_stop(args: &[String]) -> Result<StopOpts, ParseError> {
    let mut o = StopOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--all" => o.all = true,
            "-h" | "--help" => return Err(ParseError::Help),
            _ => o.common.take_or("stop", args, &mut i)?,
        }
        i += 1;
    }
    Ok(o)
}

/// `dongminal doctor` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DoctorOpts {
    pub common: Common,
    /// 내부용. 의사 터미널 검사만 하고 결과를 이 파일에 적는다 (FR-XDG-2).
    pub probe_pty: String,
    /// 진단 번들을 쓸 자리다 (G2-3). 비면 종전의 doctor 다.
    pub bundle: String,
}

pub fn parse_doctor(args: &[String]) -> Result<DoctorOpts, ParseError> {
    let mut o = DoctorOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--probe-pty" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--probe-pty 에 값이 없습니다"));
                }
                i += 1;
                o.probe_pty = args[i].clone();
            }
            "--bundle" => {
                if i + 1 >= args.len() {
                    return Err(invalid("--bundle 에 파일 경로가 없습니다"));
                }
                i += 1;
                o.bundle = args[i].clone();
            }
            "-h" | "--help" => return Err(ParseError::Help),
            _ => o.common.take_or("doctor", args, &mut i)?,
        }
        i += 1;
    }
    Ok(o)
}

/// `dongminal verify` 의 옵션이다. 홈·포트를 겨눌 수단을 두지 않는다 (FR-E2C-2/3).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VerifyOpts {
    /// git 표면 검사의 대상이다. 비면 현재 작업 디렉터리다.
    pub repo: String,
}

pub fn parse_verify(args: &[String]) -> Result<VerifyOpts, ParseError> {
    let mut o = VerifyOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (a, None),
        };
        match name {
            "--repo" => {
                if let Some(v) = inline {
                    o.repo = v.to_owned();
                } else {
                    if i + 1 >= args.len() {
                        return Err(invalid("--repo 에 값이 없습니다"));
                    }
                    i += 1;
                    o.repo = args[i].clone();
                }
            }
            "-h" | "--help" => return Err(ParseError::Help),
            "--port" | "--home" => {
                return Err(invalid(format!(
                    "verify 는 {name} 를 받지 않습니다 — 언제나 격리 인스턴스에서만 돕니다"
                )));
            }
            _ => return Err(unknown_flag("verify", a)),
        }
        i += 1;
    }
    Ok(o)
}

/// `dongminal health` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HealthOpts {
    pub common: Common,
    /// 데몬의 낡음만 묻는다 (FR-DFP-7).
    pub daemon_only: bool,
}

pub fn parse_health(args: &[String]) -> Result<HealthOpts, ParseError> {
    let mut o = HealthOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            "--daemon" => o.daemon_only = true,
            _ => o.common.take_or("health", args, &mut i)?,
        }
        i += 1;
    }
    Ok(o)
}

/// `dongminal window` 의 옵션이다. 겨눌 서버를 정하는 규칙은 `start` 와 같다 (FR-WIN-2).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowOpts {
    pub common: Common,
}

pub fn parse_window(args: &[String]) -> Result<WindowOpts, ParseError> {
    let mut o = WindowOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Err(ParseError::Help),
            _ => o.common.take_or("window", args, &mut i)?,
        }
        i += 1;
    }
    Ok(o)
}

/// `dongminal migrate` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MigrateOpts {
    pub common: Common,
    pub dry_run: bool,
}

pub fn parse_migrate(args: &[String]) -> Result<MigrateOpts, ParseError> {
    let mut o = MigrateOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dry-run" | "-n" => o.dry_run = true,
            "-h" | "--help" => return Err(ParseError::Help),
            _ => o.common.take_or("migrate", args, &mut i)?,
        }
        i += 1;
    }
    Ok(o)
}
