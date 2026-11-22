//! Go 기준선 `dongminal/internal/shared/serverconf` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 서버 기동값을 네 계층에서 정한다 (CONFIG_MANAGEMENT_SRS 묶음 F·P).
//!
//! ```text
//! 플래그 > 환경변수 > 파일(<home>/server.json) > 기본값
//! ```
//!
//! 바인드(host·port)에는 환경변수 계층이 없다 (HOT_REBIND_SRS FR-HRB-1). 값은 출처와 함께
//! 다닌다 (FR-CFG-7).

mod bind;
mod fsx;

pub use bind::{
    ADDR_DIR, ADDR_FILE_NAME, addr_path, read_addr, read_addr_file, remove_addr, set_bind,
    write_addr,
};

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;

use dm_gocompat::json::{self, RawMessage};
use dm_gocompat::oserr::go_error_string;
use dm_gocompat::strconv::quote;
use dm_shared_dmenv::{DEFAULT_HOST, DEFAULT_PORT, ENV_HOST, ENV_LOG_FILE, ENV_LOG_LEVEL, ENV_PORT};
use serde::{Deserialize, Serialize, Serializer};

/// 파일 계층이 사는 자리다. `<home>` 아래다.
pub const FILE_NAME: &str = "server.json";

/// `logLevel` 의 기본이다.
pub const DEFAULT_LOG_LEVEL: &str = "info";

/// 서버의 자동 판 확인 기본값이다 (UPDATE_NOTICE_SRS FR-UPD-12).
pub const DEFAULT_UPDATE_CHECK: bool = true;

/// DONGMINAL_ 접두어가 붙기 전부터 읽던 포트 변수다. 이제 바인드를 정하지 않는다 (FR-HRB-1).
pub const ENV_PORT_LEGACY: &str = "PORT";

/// 예전에 바인드를 정하던 환경변수다. 이제 경고만 한다 (FR-HRB-8).
const BIND_ENV_NAMES: [&str; 3] = [ENV_HOST, ENV_PORT, ENV_PORT_LEGACY];

const KNOWN_KEYS: [&str; 5] = ["host", "port", "logLevel", "logFile", "updateCheck"];

/// 값이 어느 계층에서 왔는지다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Flag,
    Env,
    File,
    Default,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Flag => "flag",
            Source::Env => "env",
            Source::File => "file",
            Source::Default => "default",
        }
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// 실효값과 그 출처다. `env` 는 환경변수에서 왔을 때 그 변수 이름이다 (FR-CFG-19).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Value {
    pub value: String,
    pub source: Source,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub env: String,
}

impl Value {
    fn new(value: &str, source: Source) -> Self {
        Self {
            value: value.to_owned(),
            source,
            env: String::new(),
        }
    }
}

/// 해석에 필요한 재료다. `getenv` 가 `None` 이면 프로세스 환경을 읽는다.
pub struct Inputs<'a> {
    pub home: &'a Path,
    pub flag_host: &'a str,
    pub flag_port: &'a str,
    pub flag_log_level: &'a str,
    pub flag_log_file: &'a str,
    pub getenv: Option<&'a dyn Fn(&str) -> String>,
    /// OS 마다 다르므로 부르는 쪽이 준다 (FR-XPA-2).
    pub default_log_file: &'a str,
}

impl Default for Inputs<'_> {
    fn default() -> Self {
        Self {
            home: Path::new(""),
            flag_host: "",
            flag_port: "",
            flag_log_level: "",
            flag_log_file: "",
            getenv: None,
            default_log_file: "",
        }
    }
}

/// 기동을 막아야 하는 포트 사유다 (FR-CFG-19).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortError(String);

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PortError {}

/// 네 계층을 지난 결과다.
#[derive(Clone, Debug, Serialize)]
pub struct Resolved {
    pub host: Value,
    pub port: Value,
    #[serde(rename = "logLevel")]
    pub log_level: Value,
    #[serde(rename = "logFile")]
    pub log_file: Value,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub warnings: Vec<String>,
    /// 서버가 스스로 판을 확인하는가다 (FR-UPD-12). 파일과 기본값 둘뿐이다.
    #[serde(rename = "updateCheck")]
    pub update_check: bool,
    /// 파일에 그 키가 적혀 있었는가다. 최초 고지의 표식이다 (FR-UPD-10).
    #[serde(rename = "updateCheckSet")]
    pub update_check_set: bool,
    /// 설정돼 있었지만 바인드를 정하지 않은 환경변수의 이름이다 (FR-HRB-8).
    #[serde(rename = "bindEnv", skip_serializing_if = "json::is_empty")]
    pub bind_env: Vec<String>,
    #[serde(skip)]
    port_err: Option<PortError>,
}

impl Resolved {
    /// 바인드 환경변수가 설정돼 있을 때의 경고 한 줄이다. 없으면 빈 문자열.
    pub fn bind_env_warning(&self) -> String {
        if self.bind_env.is_empty() {
            return String::new();
        }
        format!(
            "{} 는 바인드를 정하지 않습니다 — {FILE_NAME} 나 --port·--expose 를 쓰세요",
            self.bind_env.join("·")
        )
    }

    /// 기동을 막아야 하는 사유다. 경고와 달리 진행하지 않는다.
    pub fn err(&self) -> Option<&PortError> {
        self.port_err.as_ref()
    }
}

/// 쓰기 함수의 오류다.
#[derive(Debug)]
pub enum Error {
    /// 홈 없이 부른 경우다.
    NoHome,
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NoHome => f.write_str("DONGMINAL_HOME 이 없습니다"),
            Error::Io(e) => f.write_str(&go_error_string(e)),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

/// 파일 계층의 모양이다 (FR-CFG-12). `updateCheck` 는 구조체로 읽지 않는다 (FR-UPD-16) —
/// 한 키의 오타가 host·port 까지 함께 잃게 하지 않는다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "serverconf.file")]
struct File {
    host: Option<String>,
    port: Option<String>,
    #[serde(rename = "logLevel")]
    log_level: Option<String>,
    #[serde(rename = "logFile")]
    log_file: Option<String>,
    #[serde(skip)]
    update_check: Option<bool>,
}

fn is_unset(home: &Path) -> bool {
    home.as_os_str().is_empty()
}

/// 네 계층을 지나 실효값을 정한다. 파일이 깨져도 기동을 막지 않는다 (FR-CFG-15).
pub fn resolve(input: &Inputs<'_>) -> Resolved {
    let os_getenv = |k: &str| {
        std::env::var_os(k)
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let getenv: &dyn Fn(&str) -> String = match input.getenv {
        Some(g) => g,
        None => &os_getenv,
    };
    let (f, mut warnings) = read_file(input.home);

    let host = pick(input.flag_host, &[], f.host.as_deref(), DEFAULT_HOST);
    let mut port = pick(input.flag_port, &[], f.port.as_deref(), DEFAULT_PORT);
    if port.source == Source::File {
        // FR-HRB-2: 파일의 틀린 포트는 기동을 막지 않는다 — 기본값으로 간다.
        if let Err(e) = check_port(&port) {
            warnings.push(format!(
                "{FILE_NAME} 의 port 를 쓸 수 없습니다: {e} — 기본값({DEFAULT_PORT})을 씁니다"
            ));
            port = Value::new(DEFAULT_PORT, Source::Default);
        }
    }
    let bind_env = BIND_ENV_NAMES
        .iter()
        .filter(|k| !getenv(k).is_empty())
        .map(|k| (*k).to_owned())
        .collect();
    let log_level = pick(
        input.flag_log_level,
        &[(ENV_LOG_LEVEL, getenv(ENV_LOG_LEVEL))],
        f.log_level.as_deref(),
        DEFAULT_LOG_LEVEL,
    );
    let log_file = pick(
        input.flag_log_file,
        &[(ENV_LOG_FILE, getenv(ENV_LOG_FILE))],
        f.log_file.as_deref(),
        input.default_log_file,
    );
    let port_err = check_port(&port).err();
    Resolved {
        host,
        port,
        log_level,
        log_file,
        warnings,
        update_check: f.update_check.unwrap_or(DEFAULT_UPDATE_CHECK),
        update_check_set: f.update_check.is_some(),
        bind_env,
        port_err,
    }
}

/// 한 값의 네 계층을 지난다. 빈 문자열은 "정하지 않음" 이다 (FR-CFG-13).
fn pick(flag: &str, envs: &[(&str, String)], file: Option<&str>, def: &str) -> Value {
    if !flag.is_empty() {
        return Value::new(flag, Source::Flag);
    }
    for (name, val) in envs {
        if !val.is_empty() {
            return Value {
                value: val.clone(),
                source: Source::Env,
                env: (*name).to_owned(),
            };
        }
    }
    match file {
        Some(v) if !v.is_empty() => Value::new(v, Source::File),
        _ => Value::new(def, Source::Default),
    }
}

/// 파일 계층을 읽는다. 없으면 조용하고(FR-CFG-14), 깨졌으면 경고만 낸다.
fn read_file(home: &Path) -> (File, Vec<String>) {
    if is_unset(home) {
        return (File::default(), Vec::new());
    }
    let data = match fsx::read_file(&home.join(FILE_NAME)) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (File::default(), Vec::new()),
        Err(e) => {
            return (
                File::default(),
                vec![format!(
                    "{FILE_NAME} 를 읽지 못했습니다: {} (무시하고 진행합니다)",
                    go_error_string(&e)
                )],
            );
        }
    };
    let mut f: File = match json::unmarshal(&data) {
        Ok(f) => f,
        Err(e) => {
            return (
                File::default(),
                vec![format!(
                    "{FILE_NAME} 가 깨졌습니다: {e} (무시하고 진행합니다)"
                )],
            );
        }
    };
    let mut warns = Vec::new();
    if let Ok(raw) = json::unmarshal::<BTreeMap<String, RawMessage>>(&data) {
        for k in raw.keys().filter(|k| !KNOWN_KEYS.contains(&k.as_str())) {
            warns.push(format!("{FILE_NAME}: 알 수 없는 키 {} (무시합니다)", quote(k)));
        }
        if let Some(v) = raw.get("updateCheck") {
            match json::unmarshal::<bool>(&v.0) {
                Ok(b) => f.update_check = Some(b),
                Err(_) => warns.push(format!(
                    "{FILE_NAME}: updateCheck 가 true/false 가 아닙니다 (기본값 {DEFAULT_UPDATE_CHECK} 를 씁니다)"
                )),
            }
        }
    }
    (f, warns)
}

/// Go `strconv.Atoi` 로 읽히는 범위의 정수.
pub(crate) fn atoi(s: &str) -> Option<i64> {
    s.parse::<i64>().ok()
}

/// 포트를 `net.Listen` 전에 본다 (FR-CFG-19).
fn check_port(v: &Value) -> Result<(), PortError> {
    match atoi(&v.value) {
        None => Err(PortError(format!(
            "포트가 숫자가 아닙니다: {} (출처: {})",
            describe(v),
            v.source
        ))),
        Some(n) if !(1..=65535).contains(&n) => Err(PortError(format!(
            "포트가 범위(1~65535) 밖입니다: {} (출처: {})",
            describe(v),
            v.source
        ))),
        Some(_) => Ok(()),
    }
}

/// "어느 변수의 어떤 값" 을 사람이 읽는 말로 만든다.
fn describe(v: &Value) -> String {
    if v.env.is_empty() {
        quote(&v.value)
    } else {
        format!("{}={}", v.env, v.value)
    }
}

/// 자동 판 확인 토글을 `server.json` 에 적는다 (FR-UPD-13). 다른 키를 보존한다.
pub fn set_update_check(home: &Path, on: bool) -> Result<(), Error> {
    set_keys(home, &[("updateCheck", raw_of(&on))])
}

fn raw_of<T: Serialize + ?Sized>(v: &T) -> RawMessage {
    // bool·string 의 인코딩은 실패하지 않는다.
    RawMessage(json::marshal(v).unwrap_or_default())
}

/// `server.json` 의 키 몇 개만 바꿔 쓴다. 읽지 못한 파일은 빈 표로 친다 (D-CFG-3).
fn set_keys(home: &Path, kv: &[(&str, RawMessage)]) -> Result<(), Error> {
    if is_unset(home) {
        return Err(Error::NoHome);
    }
    let path = home.join(FILE_NAME);
    let mut m: BTreeMap<String, RawMessage> = match fsx::read_file(&path) {
        Ok(data) => json::unmarshal::<BTreeMap<String, RawMessage>>(&data).unwrap_or_default(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e.into()),
    };
    for (k, v) in kv {
        m.insert((*k).to_owned(), v.clone());
    }
    let mut out = json::marshal_indent(&m, "", "  ").map_err(io::Error::other)?;
    out.push(b'\n');
    fsx::mkdir_all(home, 0o700)?;
    dm_shared_platform::write_file_atomic(&path, &out, 0o600)?;
    Ok(())
}

#[cfg(test)]
mod tests;
