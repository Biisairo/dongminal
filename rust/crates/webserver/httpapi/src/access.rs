//! 접속 허용 목록 (Go `access.go`·`access_normalize.go`·`access_matcher.go`, ACCESS_ALLOWLIST_SRS).
//!
//! 축이 둘이다. 축①(`entries`)은 출발지 IP·대역·호스트명으로 기기를 거르고, 축②(`hosts`)는 이
//! 컴퓨터가 불리는 이름(Host 헤더)을 허용한다. 판정 표(`Matcher`)는 바뀔 때마다 통째로 갈아
//! 끼운다 — 요청 경로는 잠금 없이 읽는다.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use otter_shared_otterlog::{errorf, infof};
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::netx::{self, Addr, Prefix};

pub use otter_shared_cadence::ACCESS_REFRESH_EVERY as DEFAULT_ACCESS_REFRESH;

/// 호스트명 하나를 해석하는 시한이다. 시한 해석은 [`timed_lookup`] 이 한다.
pub(crate) const ACCESS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// 저장 실패의 문구 (Go `errAccessSaveFailed`).
pub(crate) const ACCESS_SAVE_FAILED: &str = "허용 목록을 저장하지 못했습니다";

/// access.json 의 권한이다.
const ACCESS_FILE_PERM: u32 = 0o644;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct AccessEntry {
    pub(crate) id: String,
    pub(crate) value: String,
    pub(crate) enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct AccessConfig {
    pub(crate) enabled: bool,
    /// Go 의 nil slice 는 `null` 이다.
    pub(crate) entries: Option<Vec<AccessEntry>>,
    /// Go `omitempty`: nil·빈 slice 를 빼고 쓴다.
    #[serde(skip_serializing_if = "hosts_empty")]
    pub(crate) hosts: Option<Vec<AccessEntry>>,
}

fn hosts_empty(h: &Option<Vec<AccessEntry>>) -> bool {
    h.as_ref().is_none_or(|v| v.is_empty())
}

impl AccessConfig {
    fn entries(&self) -> &[AccessEntry] {
        self.entries.as_deref().unwrap_or_default()
    }

    fn hosts(&self) -> &[AccessEntry] {
        self.hosts.as_deref().unwrap_or_default()
    }

    /// Go `config()`: 복사본. `append(nil, ...)` 이라 빈 목록은 nil 이 된다.
    fn copied(&self) -> AccessConfig {
        AccessConfig {
            enabled: self.enabled,
            entries: non_empty(self.entries()),
            hosts: non_empty(self.hosts()),
        }
    }
}

fn non_empty(v: &[AccessEntry]) -> Option<Vec<AccessEntry>> {
    if v.is_empty() { None } else { Some(v.to_vec()) }
}

/// GET /api/access 의 항목 하나다. 해석 결과와 실패 사유를 함께 싣는다.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct AccessEntryView {
    pub(crate) id: String,
    pub(crate) value: String,
    pub(crate) enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resolved: Option<Vec<String>>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) error: String,
}

/// GET /api/access 의 본문이다.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct AccessView {
    pub(crate) enabled: bool,
    pub(crate) entries: Vec<AccessEntryView>,
    pub(crate) you: String,
    #[serde(rename = "self", skip_serializing_if = "Option::is_none")]
    pub(crate) self_: Option<Vec<String>>,
    /// Go 는 `omitempty` 가 없어 nil 이면 `null` 이다.
    pub(crate) hosts: Option<Vec<AccessEntry>>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) hostname: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) host: String,
}

/// 호스트명을 주소들로 푼다. 실패 문구가 화면에 보인다.
pub(crate) type LookupFn = Arc<dyn Fn(&str) -> Result<Vec<String>, String> + Send + Sync>;
/// 이 기계의 인터페이스 주소를 모은다.
pub(crate) type InterfaceAddrsFn = Arc<dyn Fn() -> io::Result<Vec<IpAddr>> + Send + Sync>;

/// 잠금 아래의 가변 상태다 (Go `mu` 가 지키는 필드).
struct State {
    cfg: AccessConfig,
    /// 호스트명 → 해석된 주소.
    resolved: HashMap<String, Vec<Addr>>,
    /// 호스트명 → 해석 실패 사유.
    res_err: HashMap<String, String>,
    /// 이 기계의 인터페이스 주소 (FR-ACL-5).
    self_addrs: Vec<Addr>,
}

pub(crate) struct AccessStore {
    /// PUT 직렬화. `state` 보다 바깥 잠금이다.
    pub(crate) put_mu: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    path: PathBuf,
    matcher: RwLock<Arc<Matcher>>,
    pub(crate) lookup_host: RwLock<LookupFn>,
    pub(crate) interface_addrs: RwLock<InterfaceAddrsFn>,
}

impl AccessStore {
    /// Go `newAccessStore`: 파일이 없거나 깨졌으면 허용 목록을 끈 채로 시작한다.
    pub(crate) fn new(path: PathBuf) -> AccessStore {
        let st = State {
            cfg: AccessConfig::default(),
            resolved: HashMap::new(),
            res_err: HashMap::new(),
            self_addrs: Vec::new(),
        };
        let s = AccessStore {
            put_mu: tokio::sync::Mutex::new(()),
            matcher: RwLock::new(Arc::new(build_matcher(&st.cfg, &[], &HashMap::new()))),
            state: Mutex::new(st),
            path,
            lookup_host: RwLock::new(Arc::new(|h: &str| timed_lookup(h, ACCESS_LOOKUP_TIMEOUT))),
            interface_addrs: RwLock::new(Arc::new(otter_shared_platform::interface_addrs)),
        };
        let data = match std::fs::read(&s.path) {
            Ok(d) => d,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    infof!(None, "loadAccess: {}", go_read_error(&s.path, &e));
                }
                return s;
            }
        };
        let cfg: AccessConfig = match otter_gocompat::json::unmarshal(&data) {
            Ok(c) => c,
            Err(e) => {
                infof!(None, "loadAccess: {e} — 허용 목록을 끈 채로 시작한다");
                return s;
            }
        };
        infof!(
            None,
            "access loaded: enabled={} entries={} hosts={}",
            cfg.enabled,
            cfg.entries().len(),
            cfg.hosts().len()
        );
        {
            let mut st = s.lock();
            st.cfg = cfg;
            s.rebuild(&st);
        }
        s
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn rebuild(&self, st: &State) {
        let m = Arc::new(build_matcher(&st.cfg, &st.self_addrs, &st.resolved));
        *self.matcher.write().unwrap_or_else(|e| e.into_inner()) = m;
    }

    pub(crate) fn matcher(&self) -> Arc<Matcher> {
        self.matcher
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Go `config()`.
    pub(crate) fn config(&self) -> AccessConfig {
        self.lock().cfg.copied()
    }

    /// Go `setConfig`: 저장하고 곧바로 다시 해석한다.
    #[cfg(test)]
    pub(crate) fn set_config(&self, cfg: AccessConfig) -> Result<(), SaveError> {
        self.save(cfg)?;
        self.refresh();
        Ok(())
    }

    /// Go `save`: 정규화·검증한 뒤 메모리와 파일에 쓴다. 파일 쓰기가 실패하면 메모리도 되돌린다.
    pub(crate) fn save(&self, cfg: AccessConfig) -> Result<(), SaveError> {
        let norm = normalize_access_config(&cfg).map_err(SaveError::Invalid)?;
        let (prev, data) = {
            let mut st = self.lock();
            let prev = std::mem::replace(&mut st.cfg, norm);
            self.rebuild(&st);
            (
                prev,
                otter_gocompat::json::marshal_indent(&st.cfg, "", "  "),
            )
        };
        let data = match data {
            Ok(d) => d,
            Err(e) => {
                infof!(None, "saveAccess marshal: {e}");
                self.restore(prev);
                return Err(SaveError::Failed);
            }
        };
        if let Err(e) = otter_shared_platform::write_state_file(&self.path, &data, ACCESS_FILE_PERM)
        {
            infof!(
                None,
                "saveAccess: {}",
                otter_gocompat::oserr::go_error_string(&e)
            );
            self.restore(prev);
            return Err(SaveError::Failed);
        }
        Ok(())
    }

    fn restore(&self, prev: AccessConfig) {
        let mut st = self.lock();
        st.cfg = prev;
        self.rebuild(&st);
    }

    /// Go `refresh`: 인터페이스 주소와 호스트명 항목을 다시 모은다. 해석은 잠금 밖에서 한다.
    pub(crate) fn refresh(&self) {
        let entries = self.lock().cfg.entries().to_vec();
        let addrs_fn = self
            .interface_addrs
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let self_addrs = match addrs_fn() {
            Ok(v) => v.into_iter().map(|ip| Addr::from_ip(ip).unmap()).collect(),
            Err(e) => {
                errorf!(
                    None,
                    "access: 인터페이스 주소 수집 실패 ({}) — loopback 예외만 남는다",
                    otter_gocompat::oserr::go_error_string(&e)
                );
                Vec::new()
            }
        };
        let lookup = self
            .lookup_host
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut resolved: HashMap<String, Vec<Addr>> = HashMap::new();
        let mut res_err: HashMap<String, String> = HashMap::new();
        for e in &entries {
            if !is_plain_hostname(&e.value)
                || resolved.contains_key(&e.value)
                || res_err.contains_key(&e.value)
            {
                continue;
            }
            let hosts = match lookup(&e.value) {
                Ok(h) => h,
                Err(msg) => {
                    res_err.insert(e.value.clone(), msg);
                    continue;
                }
            };
            let addrs: Vec<Addr> = hosts
                .iter()
                .filter_map(|h| netx::parse_addr(h))
                .map(|a| a.unmap())
                .collect();
            if addrs.is_empty() {
                res_err.insert(e.value.clone(), "해석 결과가 없다".to_owned());
                continue;
            }
            resolved.insert(e.value.clone(), addrs);
        }
        let mut st = self.lock();
        st.self_addrs = self_addrs;
        st.resolved = resolved;
        st.res_err = res_err;
        self.rebuild(&st);
    }

    /// Go `startRefresh`: `every` 마다 다시 해석한다. `done` 이 취소되면 멈춘다.
    pub(crate) fn start_refresh(self: &Arc<Self>, done: CancellationToken, every: Duration) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut t = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                tokio::select! {
                    _ = done.cancelled() => return,
                    _ = t.tick() => {
                        let s = Arc::clone(&me);
                        let _ = tokio::task::spawn_blocking(move || s.refresh()).await;
                    }
                }
            }
        });
    }

    /// Go `checkSave`: 이 구성으로 저장하면 요청자가 스스로를 잠그는가 (FR-ACL-22).
    /// 아직 해석하지 않은 호스트명이 있으면 판정할 수 없으므로 허용한다.
    pub(crate) fn check_save(&self, cfg: &AccessConfig, you: &Addr) -> Result<Answer, String> {
        let norm = normalize_access_config(cfg)?;
        let (m, unknown) = {
            let st = self.lock();
            let m = build_matcher(&norm, &st.self_addrs, &st.resolved);
            let unknown = norm.entries().iter().any(|e| {
                e.enabled
                    && is_plain_hostname(&e.value)
                    && !st.resolved.contains_key(&e.value)
                    && !st.res_err.contains_key(&e.value)
            });
            (m, unknown)
        };
        if m.allowed(you) || unknown {
            return Ok(action::allow());
        }
        let mut args = BTreeMap::new();
        args.insert(
            "you".to_owned(),
            serde_json::Value::String(you.unmap().to_string()),
        );
        Ok(action::deny(409, apierr::CODE_LOCKS_YOU_OUT, Some(args)))
    }

    /// Go `view`.
    pub(crate) fn view(&self) -> AccessView {
        let st = self.lock();
        let entries = st
            .cfg
            .entries()
            .iter()
            .map(|e| AccessEntryView {
                id: e.id.clone(),
                value: e.value.clone(),
                enabled: e.enabled,
                resolved: st
                    .resolved
                    .get(&e.value)
                    .filter(|v| !v.is_empty())
                    .map(|v| v.iter().map(ToString::to_string).collect()),
                error: st.res_err.get(&e.value).cloned().unwrap_or_default(),
            })
            .collect();
        let self_: Vec<String> = st.self_addrs.iter().map(ToString::to_string).collect();
        AccessView {
            enabled: st.cfg.enabled,
            entries,
            you: String::new(),
            self_: if self_.is_empty() { None } else { Some(self_) },
            hosts: non_empty(st.cfg.hosts()),
            hostname: String::new(),
            host: String::new(),
        }
    }

    /// Go `isSelf`.
    pub(crate) fn is_self(&self, a: &Addr) -> bool {
        self.matcher().is_self(&a.unmap())
    }

    /// Go `hasHostAlias`.
    pub(crate) fn has_host_alias(&self, name: &str) -> bool {
        !name.is_empty() && self.matcher().aliases.contains(&name.to_lowercase())
    }

    /// Go `allowed`.
    pub(crate) fn allowed(&self, a: &Addr) -> bool {
        self.matcher().allowed(a)
    }
}

/// 저장의 실패. `Failed` 는 500, `Invalid` 는 400 이다.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SaveError {
    Failed,
    Invalid(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Failed => f.write_str(ACCESS_SAVE_FAILED),
            SaveError::Invalid(m) => f.write_str(m),
        }
    }
}

/// Go `os.ReadFile` 오류 문구(`open <path>: ...`).
pub(crate) fn go_read_error(path: &std::path::Path, e: &io::Error) -> String {
    let raw = e.raw_os_error().map_or_else(
        || io::Error::new(e.kind(), e.to_string()),
        io::Error::from_raw_os_error,
    );
    otter_gocompat::oserr::go_error_string(&otter_gocompat::oserr::path_error(
        "open",
        &path.to_string_lossy(),
        raw,
    ))
}

/// Go `timedLookup`: 시한 안에 해석한다. 실패 문구는 Go `*net.DNSError` 의 모양이다.
fn timed_lookup(host: &str, within: Duration) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let name = host.to_owned();
    std::thread::spawn(move || {
        let r = (name.as_str(), 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|sa| sa.ip()).collect::<Vec<_>>());
        let _ = tx.send(r);
    });
    match rx.recv_timeout(within) {
        Ok(Ok(ips)) => {
            let mut seen = HashSet::new();
            Ok(ips
                .into_iter()
                .filter(|ip| seen.insert(*ip))
                .map(|ip| ip.to_string())
                .collect())
        }
        Ok(Err(_)) => Err(format!("lookup {host}: no such host")),
        Err(_) => Err(format!("lookup {host}: i/o timeout")),
    }
}

/// Go `normalizeAccessConfig`: 값의 공백을 걷고 검증한다. 축② 이름은 소문자·끝 점 없음으로.
pub(crate) fn normalize_access_config(cfg: &AccessConfig) -> Result<AccessConfig, String> {
    let mut entries = Vec::with_capacity(cfg.entries().len());
    for (i, e) in cfg.entries().iter().enumerate() {
        let v = go_trim_space(&e.value);
        validate_access_value(v).map_err(|err| format!("entries[{i}]: {err}"))?;
        entries.push(AccessEntry {
            value: v.to_owned(),
            ..e.clone()
        });
    }
    let mut hosts = Vec::with_capacity(cfg.hosts().len());
    for (i, e) in cfg.hosts().iter().enumerate() {
        let v = normalize_host_alias(&e.value).map_err(|err| format!("hosts[{i}]: {err}"))?;
        hosts.push(AccessEntry {
            value: v,
            ..e.clone()
        });
    }
    Ok(AccessConfig {
        enabled: cfg.enabled,
        entries: Some(entries),
        hosts: Some(hosts),
    })
}

/// Go `strings.TrimSpace`(유니코드 공백).
pub(crate) fn go_trim_space(s: &str) -> &str {
    s.trim_matches(char::is_whitespace)
}

fn validate_access_value(v: &str) -> Result<(), String> {
    if v.is_empty() {
        return Err("빈 값".to_owned());
    }
    if netx::parse_addr(v).is_some() || netx::parse_prefix(v).is_some() || is_hostname(v) {
        return Ok(());
    }
    Err(format!(
        "{} 는 IP·CIDR·호스트명 중 어느 것도 아니다",
        otter_gocompat::strconv::quote(v)
    ))
}

/// Go `normalizeHostAlias`.
pub(crate) fn normalize_host_alias(raw: &str) -> Result<String, String> {
    let t = go_trim_space(raw);
    let v = t.strip_suffix('.').unwrap_or(t).to_lowercase();
    if v.is_empty() {
        return Err("빈 값".to_owned());
    }
    let q = otter_gocompat::strconv::quote(raw);
    if v.contains(['*', '?']) {
        return Err(format!(
            "{q} — 와일드카드는 쓸 수 없다. 이 컴퓨터가 불리는 이름을 그대로 적는다"
        ));
    }
    if !is_hostname(&v) {
        return Err(format!(
            "{q} 는 이름이 아니다 — IP·대역·포트·스킴은 위쪽 허용 목록이 담당한다"
        ));
    }
    Ok(v)
}

/// Go `isHostname`: LDH 레이블, 마지막 레이블이 숫자만은 아니다.
pub(crate) fn is_hostname(s: &str) -> bool {
    if s.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = s.split('.').collect();
    for label in &labels {
        if label.is_empty() || label.len() > 63 {
            return false;
        }
        let n = label.len();
        for (i, c) in label.char_indices() {
            let ok = c.is_ascii_alphanumeric() || (c == '-' && i > 0 && i < n - 1);
            if !ok {
                return false;
            }
        }
    }
    let last = labels.last().copied().unwrap_or_default();
    !last
        .trim_start_matches(|c: char| c.is_ascii_digit())
        .is_empty()
}

/// Go `isPlainHostname`: IP·CIDR 이 아닌 호스트명이다.
pub(crate) fn is_plain_hostname(v: &str) -> bool {
    netx::parse_addr(v).is_none() && netx::parse_prefix(v).is_none() && is_hostname(v)
}

/// 판정 표 (Go `accessMatcher`).
pub(crate) struct Matcher {
    pub(crate) enabled: bool,
    self_addrs: HashSet<Addr>,
    /// 켜진 IP 항목 + 켜진 호스트명의 해석 결과.
    addrs: HashSet<Addr>,
    /// 켜진 CIDR 항목.
    prefixes: Vec<Prefix>,
    /// 켜진 축② 이름(소문자, 끝 점 없음).
    aliases: HashSet<String>,
}

impl Matcher {
    /// Go `isSelf`: loopback 이거나 이 기계의 주소다 (FR-ACL-5).
    pub(crate) fn is_self(&self, a: &Addr) -> bool {
        a.is_loopback() || self.self_addrs.contains(a)
    }

    /// Go `allowed`: 자기 자신은 언제나, 꺼져 있으면 누구나, 켜져 있으면 목록에 있는 것만.
    pub(crate) fn allowed(&self, a: &Addr) -> bool {
        let a = a.unmap();
        if self.is_self(&a) || !self.enabled || self.addrs.contains(&a) {
            return true;
        }
        self.prefixes.iter().any(|p| p.contains(&a))
    }
}

fn build_matcher(
    cfg: &AccessConfig,
    self_addrs: &[Addr],
    resolved: &HashMap<String, Vec<Addr>>,
) -> Matcher {
    let mut m = Matcher {
        enabled: cfg.enabled,
        self_addrs: self_addrs.iter().cloned().collect(),
        addrs: HashSet::new(),
        prefixes: Vec::new(),
        aliases: HashSet::new(),
    };
    for e in cfg.entries() {
        if !e.enabled {
            continue; // FR-ACL-17
        }
        if let Some(a) = netx::parse_addr(&e.value) {
            m.addrs.insert(a.unmap());
            continue;
        }
        if let Some(p) = netx::parse_prefix(&e.value) {
            m.prefixes.push(p);
            continue;
        }
        if let Some(list) = resolved.get(&e.value) {
            m.addrs.extend(list.iter().cloned());
        }
    }
    for e in cfg.hosts() {
        if e.enabled {
            let v = e.value.strip_suffix('.').unwrap_or(&e.value);
            m.aliases.insert(v.to_lowercase());
        }
    }
    m
}
