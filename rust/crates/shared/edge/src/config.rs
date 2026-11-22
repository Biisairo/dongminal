//! `edges.json` (노드 설정과 간선 목록) 의 주인 (FR-PNW-2·3, EDGE_PAIRING_SRS, EDGE_MESH_SRS).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dm_gocompat::json;
use dm_shared_dmenv as dmenv;
use dm_shared_dmlog as dmlog;
use serde::{Deserialize, Serialize};

use crate::addr::{FINGERPRINT_LEN, parse_addr, valid_addr, valid_fingerprint, valid_port};
use crate::error::Error;
use crate::profile::tag;

pub const DEFAULT_PORT: i64 = 58147;
pub const DEFAULT_BIND: &str = "0.0.0.0";
pub const NAME_MAX_LEN: usize = 32;
/// 상대가 알린 표시 이름의 바이트 상한이다 (FR-EPR-8).
pub const DISPLAY_NAME_MAX: usize = 64;
/// 이름의 UTF-8 바이트 상한이다. 상대의 [`DISPLAY_NAME_MAX`] 와 같다 (FR-PFN-2).
pub const NAME_MAX_BYTES: usize = DISPLAY_NAME_MAX;
/// 간선을 찾을 때 받는 지문 앞자리의 최소 길이다 (FR-EPR-30).
pub const MIN_PREFIX: usize = 8;
/// 맺을 수 있는 간선 수의 상한이다 (FR-ATF-80). 추가만 막는다 — 파일에 이미 더 있으면 그대로
/// 읽고 저장한다.
pub const MAX_EDGES: usize = 64;
/// 호스트 이름에서 아무것도 얻지 못했을 때의 이름이다.
const FALLBACK_NAME: &str = "node";
const FILE_MODE: u32 = 0o600;
/// 깨진 설정 파일을 비켜 둘 이름의 꼬리다 (D-ATF-5).
const BAD_SUFFIX: &str = ".bad-";
const JSON_INDENT: &str = "  ";

/// 간선 하나다. 신원은 지문이다. 이름은 상대가 알린 표시 이름이라 겹쳐도 된다. 상대의 노드
/// 포트가 닫혀 있었으면 주소·포트가 비어 있고, 이 노드는 걸지 않는다 (FR-EPR-2·31·80).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Edge {
    pub name: String,
    pub addr: String,
    pub port: i64,
    #[serde(rename = "fp")]
    pub fingerprint: String,
    /// 상대 도우미의 공개키다. 채팅 연결로 처음 받은 값을 고정한다 (FR-PCH-74).
    #[serde(rename = "helperKey", skip_serializing_if = "String::is_empty")]
    pub helper_key: String,
    /// 이 노드의 바뀐 직접 정보를 상대가 아직 받지 못했다는 표시다 (FR-EGM-25).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
}

/// `edges.json` 전체다 (FR-PNW-2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Config {
    pub enabled: bool,
    pub port: i64,
    pub bind: String,
    pub name: String,
    pub advertise: String,
    pub edges: Vec<Edge>,
}

/// 이름 규칙이다 (FR-PFN-2).
pub fn valid_name(name: &str) -> Result<(), Error> {
    if name.is_empty() || name.chars().count() > NAME_MAX_LEN || name.len() > NAME_MAX_BYTES {
        return Err(Error::InvalidName);
    }
    if name.chars().all(name_rune) { Ok(()) } else { Err(Error::InvalidName) }
}

fn name_rune(r: char) -> bool {
    r.is_ascii_alphanumeric() || r == '_' || r == '-' || ('가'..='힣').contains(&r)
}

/// 표시 이름 규칙이다: 비지 않고, 64바이트 안이며, 제어 문자가 없다.
pub fn valid_display_name(name: &str) -> bool {
    !name.is_empty() && dm_shared_termtext::line(name, DISPLAY_NAME_MAX)
}

/// 상대가 알린 이름이다. 규칙에 맞지 않으면 거절하지 않고 [`default_name`] 으로 고친다 (FR-EPR-8).
pub fn display_name(name: &str) -> String {
    if valid_display_name(name) { name.to_string() } else { default_name(name) }
}

/// hostname 을 FR-PFN-2 에 맞춘 이름이다. 허용하지 않는 글자는 `-` 로 바꾸고 길이 상한 안으로
/// 자른다 (FR-PFN-3).
pub fn default_name(hostname: &str) -> String {
    let mut out = String::new();
    for (n, r) in hostname.chars().enumerate() {
        let r = if name_rune(r) { r } else { '-' };
        if n == NAME_MAX_LEN || out.len() + r.len_utf8() > NAME_MAX_BYTES {
            break;
        }
        out.push(r);
    }
    if out.is_empty() { FALLBACK_NAME.to_string() } else { out }
}

fn default_config(hostname: &str) -> Config {
    Config {
        enabled: false,
        port: DEFAULT_PORT,
        bind: DEFAULT_BIND.to_string(),
        name: default_name(hostname),
        advertise: String::new(),
        edges: Vec::new(),
    }
}

/// 파일에 없던 필드를 def 로 채운다.
fn fill_defaults(mut c: Config, def: &Config) -> Config {
    if c.port == 0 {
        c.port = def.port;
    }
    if c.bind.is_empty() {
        c.bind.clone_from(&def.bind);
    }
    if c.name.is_empty() {
        c.name.clone_from(&def.name);
    }
    c
}

fn validate(c: &Config) -> Result<(), Error> {
    valid_name(&c.name)?;
    if !valid_port(c.port) {
        return Err(Error::InvalidPort);
    }
    if parse_addr(&c.bind).is_none() {
        return Err(Error::InvalidBind);
    }
    let mut fps = std::collections::HashSet::new();
    for e in &c.edges {
        validate_edge(e)?;
        if !fps.insert(e.fingerprint.as_str()) {
            return Err(Error::InvalidEdge);
        }
    }
    Ok(())
}

/// 간선 하나다. 주소와 포트는 함께 있거나 함께 비어 있다 (FR-EPR-80).
fn validate_edge(e: &Edge) -> Result<(), Error> {
    if !valid_display_name(&e.name) || !valid_fingerprint(&e.fingerprint) {
        return Err(Error::InvalidEdge);
    }
    if e.addr.is_empty() && e.port == 0 {
        return Ok(());
    }
    if !valid_addr(&e.addr) || !valid_port(e.port) {
        return Err(Error::InvalidEdge);
    }
    Ok(())
}

/// Go `strings.ToLower`: 글자마다 한 글자로 바꾼다(문맥 규칙 없음).
pub(crate) fn go_lower(s: &str) -> String {
    s.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

/// Go `strings.EqualFold` 와 같이 글자마다 대소문자를 무시해 비교한다.
fn equal_fold(a: &str, b: &str) -> bool {
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    a.chars().count() == b.chars().count()
        && a.chars().zip(b.chars()).all(|(x, y)| {
            x == y || fold(x) == fold(y) || x.to_uppercase().next() == y.to_uppercase().next()
        })
}

/// 파일 그대로의 모양. 옛 항목의 state 와 옛 키 peers 를 읽는다.
#[derive(Deserialize, Default)]
#[serde(default)]
struct StoredFile {
    enabled: bool,
    port: i64,
    bind: String,
    name: String,
    advertise: String,
    edges: Option<Vec<StoredEdge>>,
    /// 옛 키다. edges 가 없을 때만 쓴다 (PEER_DAEMON_SRS §3.4a).
    peers: Option<Vec<StoredEdge>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StoredEdge {
    name: String,
    addr: String,
    port: i64,
    fp: String,
    #[serde(rename = "helperKey")]
    helper_key: String,
    pending: bool,
    /// 빈 값(짝)이 아니면(pending-out) 버린다 (FR-EPR-80).
    state: String,
}

/// `edges.json` 의 주인이다. 노드를 처리하는 프로세스만 쓴다.
pub struct Store {
    path: PathBuf,
    cfg: Mutex<Config>,
}

impl Store {
    /// path 를 읽는다. 없거나 읽지 못하면 꺼진 기본값으로 선다 — 이 파일이 서버 기동을 막지
    /// 않는다. 열기만으로는 파일을 만들지 않는다 (NFR-PNW-1).
    pub fn open(path: impl Into<PathBuf>, hostname: &str) -> Self {
        let path = path.into();
        let def = default_config(hostname);
        let cfg = load(&path, &def).unwrap_or(def);
        Self { path, cfg: Mutex::new(cfg) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Config> {
        self.cfg.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 지금 값의 사본이다.
    pub fn config(&self) -> Config {
        self.lock().clone()
    }

    /// 설정 전체를 바꾼다. 틀린 값이 하나라도 있으면 아무것도 바꾸지 않고, 쓰기에 실패하면
    /// 메모리도 그대로 둔다.
    pub fn save(&self, c: Config) -> Result<(), Error> {
        let mut cur = self.lock();
        self.save_locked(&mut cur, c)
    }

    fn save_locked(&self, cur: &mut Config, c: Config) -> Result<(), Error> {
        let c = fill_defaults(c, &Config::default());
        validate(&c)?;
        let data = json::marshal_indent(&c, "", JSON_INDENT).map_err(|_| Error::SaveFailed)?;
        if let Err(e) = dm_shared_platform::write_file_atomic(&self.path, &data, FILE_MODE) {
            dmlog::info(None, &format!("saveEdges: {}", dm_gocompat::oserr::go_error_string(&e)), &[]);
            return Err(Error::SaveFailed);
        }
        *cur = c;
        Ok(())
    }

    /// 지금 값을 f 로 바꿔 저장한다.
    fn update(&self, f: impl FnOnce(&mut Config) -> Result<(), Error>) -> Result<(), Error> {
        let mut cur = self.lock();
        let mut c = cur.clone();
        f(&mut c)?;
        self.save_locked(&mut cur, c)
    }

    /// 간선 fp 를 f 로 고친다. 바뀐 것이 있을 때만 저장하고 참이다.
    fn change(&self, fp: &str, f: impl FnOnce(&mut Edge)) -> Result<bool, Error> {
        let mut cur = self.lock();
        let mut c = cur.clone();
        let Some(e) = c.edges.iter_mut().find(|e| e.fingerprint == fp) else {
            return Err(Error::EdgeNotFound);
        };
        let before = e.clone();
        f(e);
        if *e == before {
            return Ok(false);
        }
        self.save_locked(&mut cur, c)?;
        Ok(true)
    }

    /// 짝 fp 의 도우미 공개키를 고정한다. 이미 고정한 값은 바꾸지 않는다 (FR-PCH-74).
    pub fn pin_helper(&self, fp: &str, key: &str) -> Result<(), Error> {
        self.update(|c| {
            for e in c.edges.iter_mut().filter(|e| e.fingerprint == fp && e.helper_key.is_empty()) {
                e.helper_key = key.to_string();
            }
            Ok(())
        })
    }

    /// 노드 설정만 바꾼다. 짝 목록은 그대로다. 알릴 주소는 여기서만 거른다.
    pub fn set_node(&self, n: &Config) -> Result<(), Error> {
        if !n.advertise.is_empty() && !valid_addr(&n.advertise) {
            return Err(Error::InvalidNodeField);
        }
        self.update(|c| {
            c.enabled = n.enabled;
            c.port = n.port;
            c.bind.clone_from(&n.bind);
            c.advertise.clone_from(&n.advertise);
            // 이름은 프로필에서 바꾼다. 빈 값이면 지금 이름을 둔다 (FR-PFN-31).
            if !n.name.is_empty() {
                c.name.clone_from(&n.name);
            }
            Ok(())
        })
    }

    /// 이름만 바꾼다 (FR-PFN-1·11).
    pub fn set_name(&self, name: &str) -> Result<(), Error> {
        valid_name(name)?;
        self.update(|c| {
            c.name = name.to_string();
            Ok(())
        })
    }

    /// fp 가 간선의 지문인가다.
    pub fn is_edge(&self, fp: &str) -> bool {
        self.resolve(fp).is_ok() && fp.len() == FINGERPRINT_LEN
    }

    /// 지문 전체나 앞자리([`MIN_PREFIX`] 자리 이상), 또는 핸들 `이름#번호` 로 간선 하나를 찾는다.
    /// 둘 이상에 맞으면 [`Error::Ambiguous`], 없거나 너무 짧으면 [`Error::EdgeNotFound`] 다.
    pub fn resolve(&self, q: &str) -> Result<Edge, Error> {
        let q = go_lower(q.trim_matches(char::is_whitespace));
        if let Some(i) = q.rfind('#') {
            return self.resolve_handle(&q[..i], &q[i + 1..]);
        }
        if q.len() < MIN_PREFIX {
            return Err(Error::EdgeNotFound);
        }
        let cfg = self.lock();
        if let Some(e) = cfg.edges.iter().find(|e| e.fingerprint == q) {
            return Ok(e.clone());
        }
        one(cfg.edges.iter().filter(|e| e.fingerprint.starts_with(&q)))
    }

    /// 이름은 대소문자를 가리지 않는다 (FR-PFN-24).
    fn resolve_handle(&self, name: &str, num: &str) -> Result<Edge, Error> {
        if name.is_empty() || num.is_empty() {
            return Err(Error::EdgeNotFound);
        }
        let cfg = self.lock();
        one(cfg.edges.iter().filter(|e| equal_fold(&e.name, name) && tag(&e.fingerprint) == num))
    }

    /// 지문 fp 의 간선을 더할 수 있는가다. 이미 있는 간선은 다시 맺을 수 있고, 새 간선은
    /// [`MAX_EDGES`] 개 미만일 때만 더한다.
    pub fn can_add(&self, fp: &str) -> Result<(), Error> {
        can_add(&self.lock().edges, fp)
    }

    /// 간선을 더한다. 같은 지문이 있으면 이름·주소만 바꾸고 고정한 도우미 키는 넘겨받는다 (FR-EPR-7).
    pub fn add_edge(&self, mut e: Edge) -> Result<(), Error> {
        validate_edge(&e)?;
        self.update(|c| {
            if let Some(q) = c.edges.iter_mut().find(|q| q.fingerprint == e.fingerprint) {
                if e.helper_key.is_empty() {
                    e.helper_key = std::mem::take(&mut q.helper_key);
                }
                *q = e;
                return Ok(());
            }
            can_add(&c.edges, &e.fingerprint)?;
            c.edges.push(e);
            Ok(())
        })
    }

    /// 지문이 fp 인 간선을 지운다.
    pub fn remove(&self, fp: &str) -> Result<(), Error> {
        self.update(|c| {
            let i = c.edges.iter().position(|e| e.fingerprint == fp).ok_or(Error::EdgeNotFound)?;
            c.edges.remove(i);
            Ok(())
        })
    }

    /// 지문이 fp 인 간선의 주소를 고친다. 신원(지문)은 그대로다 (FR-EPR-52).
    pub fn set_address(&self, fp: &str, addr: &str, port: i64) -> Result<(), Error> {
        if !valid_addr(addr) || !valid_port(port) {
            return Err(Error::InvalidEdge);
        }
        self.update(|c| {
            let e = c.edges.iter_mut().find(|e| e.fingerprint == fp).ok_or(Error::EdgeNotFound)?;
            e.addr = addr.to_string();
            e.port = port;
            Ok(())
        })
    }

    /// 간선 fp 가 보낸 직접 정보를 반영한다 (FR-EGM-21). 이름은 표시 이름 규칙으로 고쳐 쓴다.
    /// port 가 바를 때만 주소를 고친다 — addr 이 바르면 그 값, 아니면 지금 주소, 그것도 없으면
    /// 출발지 remote_host 다. 바뀐 것이 있으면 저장하고 참이다.
    pub fn apply_hello(&self, fp: &str, name: &str, addr: &str, port: i64, remote_host: &str) -> Result<bool, Error> {
        self.change(fp, |e| {
            if !name.is_empty() {
                e.name = display_name(name);
            }
            if !valid_port(port) {
                return;
            }
            if valid_addr(addr) {
                e.addr = addr.to_string();
                e.port = port;
            } else if !e.addr.is_empty() {
                e.port = port;
            } else if valid_addr(remote_host) {
                e.addr = remote_host.to_string();
                e.port = port;
            }
        })
    }

    /// 모든 간선을 알림 대기로 표시한다 (FR-EGM-23).
    pub fn set_pending_all(&self) -> Result<(), Error> {
        self.update(|c| {
            for e in &mut c.edges {
                e.pending = true;
            }
            Ok(())
        })
    }

    /// 간선 fp 의 알림 대기를 on 으로 둔다. 바뀌었으면 참이다 (FR-EGM-24).
    pub fn set_pending(&self, fp: &str, on: bool) -> Result<bool, Error> {
        self.change(fp, |e| e.pending = on)
    }
}

fn one<'a>(mut it: impl Iterator<Item = &'a Edge>) -> Result<Edge, Error> {
    match (it.next(), it.next()) {
        (None, _) => Err(Error::EdgeNotFound),
        (Some(e), None) => Ok(e.clone()),
        _ => Err(Error::Ambiguous),
    }
}

fn can_add(edges: &[Edge], fp: &str) -> Result<(), Error> {
    if edges.len() < MAX_EDGES || edges.iter().any(|e| e.fingerprint == fp) { Ok(()) } else { Err(Error::EdgeLimit) }
}

fn load(path: &Path, def: &Config) -> Option<Config> {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                let e = dm_gocompat::oserr::path_error("open", &path.to_string_lossy(), e);
                dmlog::info(
                    None,
                    &format!("loadEdges: {} — 노드 기능을 끈 채로 시작한다", dm_gocompat::oserr::go_error_string(&e)),
                    &[],
                );
            }
            return None;
        }
    };
    let f: StoredFile = match json::unmarshal(&data) {
        Ok(f) => f,
        Err(e) => {
            move_broken(path, &e.to_string());
            return None;
        }
    };
    let edges = f
        .edges
        .or(f.peers)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.state.is_empty())
        .map(|e| Edge {
            name: e.name,
            addr: e.addr,
            port: e.port,
            fingerprint: e.fp,
            helper_key: e.helper_key,
            pending: e.pending,
        })
        .collect();
    let c = Config { enabled: f.enabled, port: f.port, bind: f.bind, name: f.name, advertise: f.advertise, edges };
    let mut c = fill_defaults(c, def);
    if valid_name(&c.name).is_err() {
        c.name = default_name(&c.name);
    }
    Some(c)
}

/// 깨진 설정 파일을 `<path>.bad-<UTC시각>` 으로 비켜 두고 경고한다. 다음 저장이 원본을 덮지
/// 않는다 (FR-ATF-57, D-ATF-5).
fn move_broken(path: &Path, cause: &str) {
    let mut bad = path.as_os_str().to_owned();
    bad.push(BAD_SUFFIX);
    bad.push(bad_stamp(time::OffsetDateTime::now_utc()));
    let bad = PathBuf::from(bad);
    match std::fs::rename(path, &bad) {
        Ok(()) => dmlog::warn(
            None,
            &format!("loadEdges: {cause} — 깨진 파일을 {} 로 옮기고 노드 기능을 끈 채로 시작한다", bad.display()),
            &[],
        ),
        Err(e) => {
            let e = dm_gocompat::oserr::link_error(
                "rename",
                &path.to_string_lossy(),
                &bad.to_string_lossy(),
                e,
            );
            dmlog::warn(
                None,
                &format!(
                    "loadEdges: {cause} — 깨진 파일을 비켜 두지 못했다({}). 노드 기능을 끈 채로 시작한다",
                    dm_gocompat::oserr::go_error_string(&e)
                ),
                &[],
            );
        }
    }
}

/// Go 배치 `20060102T150405.000000000Z`.
fn bad_stamp(t: time::OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}.{:09}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.nanosecond()
    )
}

/// 옛 이름의 홈 파일을 정리한다 (FR-PDM-71). edges.json 이 없고 peers.json 이 있으면 이름을
/// 바꾼다. 둘 다 있으면 그대로 둔다. 옛 신원 파일 node-*.pem 은 옮기지 않고 지운다 (D-PDM-18).
pub fn migrate_legacy_files(dir: &Path) -> io::Result<()> {
    for n in [dmenv::LEGACY_NODE_CERT_FILE, dmenv::LEGACY_NODE_KEY_FILE] {
        let p = dir.join(n);
        if let Err(e) = std::fs::remove_file(&p)
            && e.kind() != io::ErrorKind::NotFound
        {
            return Err(dm_gocompat::oserr::path_error("remove", &p.to_string_lossy(), e));
        }
    }
    let cur = dir.join(dmenv::EDGES_FILE);
    match std::fs::metadata(&cur) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            return Err(dm_gocompat::oserr::path_error("stat", &cur.to_string_lossy(), e));
        }
        Err(_) => {}
    }
    let legacy = dir.join(dmenv::LEGACY_PEERS_FILE);
    match std::fs::rename(&legacy, &cur) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(dm_gocompat::oserr::link_error("rename", &legacy.to_string_lossy(), &cur.to_string_lossy(), e)),
        Ok(()) => Ok(()),
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
