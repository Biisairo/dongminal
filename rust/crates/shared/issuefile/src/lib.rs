//! 로컬 이슈 파일 (ISSUE_TREE_CHAT_SRS 묶음 L, FR-LIS-3~8). 폴더의 파일 하나가 이슈 하나다. 경로는
//! `<ID>-<짧은 이름>.md`, 머리말은 `id · title · status · deps · owner · branch`, 본문은 「목표」「완료 조건」「진행 기록」이다
//! (`docs/internal/perf/README.md` 의 형식 그대로). 부모는 ID 의 마지막 조각을 뗀 ID 다.
//!
//! 쓰기는 폴더의 잠금 파일로 줄 세우고, 형식을 검사한 뒤 임시 파일과 이름 바꾸기로 한다. otterctl 과 서버가 같은 한
//! 벌을 쓴다.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use otter_shared_platform::{lock_file, write_file_atomic};

/// 폴더의 쓰기를 줄 세우는 잠금 파일.
pub const LOCK_FILE: &str = ".issue.lock";
/// 잠금을 기다리는 상한.
pub const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
/// 폴더 안내 파일.
pub const README_FILE: &str = "README.md";
const FILE_EXT: &str = ".md";
const FILE_PERM: u32 = 0o644;
const FENCE: &str = "---";
const LOG_HEAD: &str = "## 진행 기록";
/// 파일 이름의 짧은 이름 상한(글자).
const SLUG_MAX: usize = 40;
/// 별칭을 부모 폴더 이름으로 바꾸는 폴더 이름 (§10 A-5).
const ISSUES_DIR: &str = "issues";

/// 이슈의 상태 (FR-LIS-5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Todo,
    Ready,
    InProgress,
    Review,
    Done,
    Blocked,
    Split,
}

impl Status {
    pub const ALL: [Status; 7] = [
        Status::Todo,
        Status::Ready,
        Status::InProgress,
        Status::Review,
        Status::Done,
        Status::Blocked,
        Status::Split,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::Ready => "ready",
            Status::InProgress => "in-progress",
            Status::Review => "review",
            Status::Done => "done",
            Status::Blocked => "blocked",
            Status::Split => "split",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        Status::ALL.into_iter().find(|x| x.as_str() == s)
    }
}

/// 허용되는 전이인가 (FR-LIS-5). `todo→ready→in-progress→review→done`, 곁가지 `→blocked`(끝나지 않은 이슈에서),
/// `blocked→ready|in-progress`, `in-progress→split` 만이다. 같은 상태로는 바뀌지 않으므로 허용한다.
pub fn transition_ok(from: Status, to: Status) -> bool {
    use Status::*;
    if from == to {
        return true;
    }
    matches!(
        (from, to),
        (Todo, Ready)
            | (Ready, InProgress)
            | (InProgress, Review)
            | (Review, Done)
            | (Todo | Ready | InProgress | Review, Blocked)
            | (Blocked, Ready | InProgress)
            | (InProgress, Split)
    )
}

/// 이슈 하나.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub deps: Vec<String>,
    pub owner: String,
    pub branch: String,
    /// 머리말 뒤의 본문 그대로.
    pub body: String,
}

/// 이슈 파일의 오류.
#[derive(Debug)]
pub enum Error {
    /// 형식이 틀렸다. 파일 이름(있으면)과 이유.
    Format(String),
    NotFound(String),
    Exists(String),
    /// 부모 이슈가 없다.
    NoParent(String),
    /// 없는 이슈를 deps 로 가리킨다.
    BadDep(String),
    /// 허용되지 않은 전이.
    Transition {
        from: Status,
        to: Status,
    },
    /// blocked 는 이유가 있어야 한다.
    NeedReason,
    Lock(String),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Format(s) => write!(f, "이슈 형식이 틀렸습니다: {s}"),
            Error::NotFound(id) => write!(f, "이슈가 없습니다: {id}"),
            Error::Exists(id) => write!(f, "이미 있는 이슈입니다: {id}"),
            Error::NoParent(id) => write!(f, "부모 이슈가 없습니다: {id}"),
            Error::BadDep(id) => write!(f, "deps 의 이슈가 없습니다: {id}"),
            Error::Transition { from, to } => write!(
                f,
                "허용되지 않은 전이입니다: {} → {}",
                from.as_str(),
                to.as_str()
            ),
            Error::NeedReason => f.write_str("blocked 로 바꾸려면 이유(--reason)가 있어야 합니다"),
            Error::Lock(s) => write!(f, "이슈 폴더를 잠그지 못했습니다: {s}"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// ID 의 꼴: 점으로 이은 조각, 조각은 영문·숫자다.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .split('.')
            .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// 부모 ID — 마지막 조각을 뗀 ID 다 (FR-LIS-4). 맨 위 이슈는 None.
pub fn parent(id: &str) -> Option<&str> {
    id.rfind('.').map(|i| &id[..i])
}

/// ID 의 차례: 조각마다 둘 다 숫자면 수로, 아니면 글자로 견준다.
pub fn id_cmp(a: &str, b: &str) -> Ordering {
    let mut x = a.split('.');
    let mut y = b.split('.');
    loop {
        match (x.next(), y.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) => {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    _ => p.cmp(q),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
        }
    }
}

/// 실제 일을 시작할 수 있는가 (FR-LIS-4): ready 이거나, deps 가 모두 done 인 todo 다.
pub fn is_ready(i: &Issue, all: &[Issue]) -> bool {
    match i.status {
        Status::Ready => true,
        Status::Todo => i
            .deps
            .iter()
            .all(|d| all.iter().any(|x| &x.id == d && x.status == Status::Done)),
        _ => false,
    }
}

/// 보이는 상태 — 시작할 수 있는 todo 는 ready 로 본다.
pub fn shown_status(i: &Issue, all: &[Issue]) -> Status {
    if i.status == Status::Todo && is_ready(i, all) {
        return Status::Ready;
    }
    i.status
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        return serde_json::from_str::<String>(v).unwrap_or_else(|_| v[1..v.len() - 1].to_owned());
    }
    v.to_owned()
}

fn quote(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// 이슈 파일을 읽는다 (FR-LIS-3).
pub fn parse(text: &str) -> Result<Issue, Error> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    if lines.next().map(str::trim_end) != Some(FENCE) {
        return Err(Error::Format("머리말(---)로 시작하지 않는다".into()));
    }
    let mut head: Vec<(String, String)> = Vec::new();
    let mut used = FENCE.len() + 1;
    let mut closed = false;
    for l in lines.by_ref() {
        used += l.len();
        let t = l.trim_end();
        if t == FENCE {
            closed = true;
            break;
        }
        if t.trim().is_empty() || t.trim_start().starts_with('#') {
            continue;
        }
        let Some((k, v)) = t.split_once(':') else {
            return Err(Error::Format(format!("머리말 줄을 읽지 못했다: {t}")));
        };
        head.push((k.trim().to_owned(), v.trim().to_owned()));
    }
    if !closed {
        return Err(Error::Format("머리말이 닫히지 않았다".into()));
    }
    let get = |k: &str| head.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
    let id = unquote(get("id").ok_or_else(|| Error::Format("id 가 없다".into()))?);
    if !valid_id(&id) {
        return Err(Error::Format(format!("id 꼴이 틀렸다: {id}")));
    }
    let title = unquote(get("title").ok_or_else(|| Error::Format("title 이 없다".into()))?);
    if title.is_empty() {
        return Err(Error::Format("title 이 비었다".into()));
    }
    let st = unquote(get("status").ok_or_else(|| Error::Format("status 가 없다".into()))?);
    let status = Status::parse(&st).ok_or_else(|| Error::Format(format!("모르는 status: {st}")))?;
    let deps = match get("deps") {
        None | Some("") => Vec::new(),
        Some(v) => serde_json::from_str::<Vec<String>>(v)
            .map_err(|_| Error::Format(format!("deps 를 읽지 못했다: {v}")))?,
    };
    if let Some(d) = deps.iter().find(|d| !valid_id(d)) {
        return Err(Error::Format(format!("deps 의 id 꼴이 틀렸다: {d}")));
    }
    let body = text
        .get(used.min(text.len())..)
        .unwrap_or_default()
        .to_owned();
    Ok(Issue {
        id,
        title,
        status,
        deps,
        owner: get("owner").map(unquote).unwrap_or_default(),
        branch: get("branch").map(unquote).unwrap_or_default(),
        body,
    })
}

/// 이슈 파일의 글. 머리말의 모양은 perf 이슈와 같다.
pub fn render(i: &Issue) -> String {
    let deps = serde_json::to_string(&i.deps).unwrap_or_else(|_| "[]".into());
    let branch = if i.branch.is_empty() {
        quote("")
    } else {
        i.branch.clone()
    };
    format!(
        "{FENCE}\nid: {}\ntitle: {}\nstatus: {}\ndeps: {deps}\nowner: {}\nbranch: {branch}\n{FENCE}\n{}",
        quote(&i.id),
        i.title,
        i.status.as_str(),
        quote(&i.owner),
        i.body
    )
}

/// 새 이슈의 본문.
fn new_body(id: &str, title: &str) -> String {
    format!("\n# {id} {title}\n\n## 목표\n\n## 완료 조건\n\n{LOG_HEAD}\n")
}

/// 제목에서 파일 이름의 짧은 이름을 만든다.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_whitespace() || "/\\:*?\"<>|#".contains(c) {
            if !out.ends_with('-') && !out.is_empty() {
                out.push('-');
            }
        } else {
            out.push(c);
        }
    }
    let s: String = out.trim_matches('-').chars().take(SLUG_MAX).collect();
    s.trim_end_matches('-').to_owned()
}

/// 진행 기록에 덧붙인다. 「진행 기록」 머리가 없으면 만든다.
fn append_log(body: &str, date: &str, text: &str) -> String {
    let mut b = body.trim_end().to_owned();
    if !b.contains(LOG_HEAD) {
        b.push_str("\n\n");
        b.push_str(LOG_HEAD);
    }
    b.push_str(&format!("\n\n{date}:\n{}\n", text.trim_end()));
    b
}

/// 로컬 트리의 별칭 (§10 A-5, FR-LIS-16): 폴더 이름, 폴더 이름이 `issues` 면 부모 폴더 이름이다.
pub fn alias(dir: &Path) -> String {
    let name = |p: &Path| {
        p.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let n = name(dir);
    if n == ISSUES_DIR
        && let Some(p) = dir.parent()
    {
        return name(p);
    }
    n
}

/// `set` 의 바꿀 값. None 이면 그대로다.
#[derive(Clone, Debug, Default)]
pub struct Change {
    pub status: Option<Status>,
    pub owner: Option<String>,
    pub branch: Option<String>,
    /// blocked 의 이유. 진행 기록에 남는다.
    pub reason: Option<String>,
}

/// 이슈 폴더 하나 (FR-LIS-6~8).
pub struct Dir {
    path: PathBuf,
}

impl Dir {
    pub fn new(path: impl Into<PathBuf>) -> Dir {
        Dir { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 폴더와 안내 파일을 만든다. 안내 파일이 있으면 두고, 폴더가 있어도 된다.
    pub fn init(&self, readme: &str) -> Result<(), Error> {
        std::fs::create_dir_all(&self.path)?;
        let p = self.path.join(README_FILE);
        if !p.exists() {
            write_file_atomic(&p, readme.as_bytes(), FILE_PERM)?;
        }
        Ok(())
    }

    /// 모든 이슈를 ID 차례로 읽는다. 하나라도 형식이 틀리면 그 파일 이름과 함께 오류다.
    pub fn load(&self) -> Result<Vec<(PathBuf, Issue)>, Error> {
        let mut out = Vec::new();
        let rd = std::fs::read_dir(&self.path)
            .map_err(|e| Error::Format(format!("{}: {e}", self.path.display())))?;
        for ent in rd {
            let p = ent?.path();
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if !name.ends_with(FILE_EXT) || name == README_FILE || name.starts_with('.') {
                continue;
            }
            let text = std::fs::read_to_string(&p)?;
            let i = parse(&text).map_err(|e| Error::Format(format!("{name}: {e}")))?;
            if !name.starts_with(&format!("{}-", i.id)) && name != format!("{}{FILE_EXT}", i.id) {
                return Err(Error::Format(format!(
                    "{name}: 파일 이름이 id({})로 시작하지 않는다",
                    i.id
                )));
            }
            out.push((p, i));
        }
        out.sort_by(|a, b| id_cmp(&a.1.id, &b.1.id));
        if let Some(w) = out.windows(2).find(|w| w[0].1.id == w[1].1.id) {
            return Err(Error::Format(format!("id 가 겹친다: {}", w[0].1.id)));
        }
        Ok(out)
    }

    pub fn issues(&self) -> Result<Vec<Issue>, Error> {
        Ok(self.load()?.into_iter().map(|(_, i)| i).collect())
    }

    pub fn get(&self, id: &str) -> Result<(PathBuf, Issue), Error> {
        self.load()?
            .into_iter()
            .find(|(_, i)| i.id == id)
            .ok_or_else(|| Error::NotFound(id.to_owned()))
    }

    fn locked<T>(&self, f: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
        let _g = lock_file(&self.path.join(LOCK_FILE), LOCK_TIMEOUT)
            .map_err(|e| Error::Lock(e.to_string()))?;
        f()
    }

    fn save(path: &Path, i: &Issue) -> Result<(), Error> {
        let text = render(i);
        // 쓴 것을 다시 읽어 형식을 검사한다 (FR-LIS-8).
        parse(&text)?;
        write_file_atomic(path, text.as_bytes(), FILE_PERM)?;
        Ok(())
    }

    /// 하위 이슈 파일을 만든다 (FR-LIS-6 `new`). 부모와 deps 의 이슈가 있어야 한다.
    pub fn create(&self, id: &str, title: &str, deps: &[String]) -> Result<PathBuf, Error> {
        if !valid_id(id) {
            return Err(Error::Format(format!("id 꼴이 틀렸다: {id}")));
        }
        let title = title.trim();
        if title.is_empty() || title.contains('\n') {
            return Err(Error::Format("title 은 한 줄이어야 한다".into()));
        }
        self.locked(|| {
            let all = self.issues()?;
            if all.iter().any(|i| i.id == id) {
                return Err(Error::Exists(id.to_owned()));
            }
            if let Some(p) = parent(id)
                && !all.iter().any(|i| i.id == p)
            {
                return Err(Error::NoParent(p.to_owned()));
            }
            if let Some(d) = deps.iter().find(|d| !all.iter().any(|i| &i.id == *d)) {
                return Err(Error::BadDep(d.clone()));
            }
            let s = slug(title);
            let name = if s.is_empty() {
                format!("{id}{FILE_EXT}")
            } else {
                format!("{id}-{s}{FILE_EXT}")
            };
            let path = self.path.join(name);
            let i = Issue {
                id: id.to_owned(),
                title: title.to_owned(),
                status: Status::Todo,
                deps: deps.to_vec(),
                owner: String::new(),
                branch: String::new(),
                body: new_body(id, title),
            };
            Self::save(&path, &i)?;
            Ok(path)
        })
    }

    /// 머리말을 고친다 (FR-LIS-6 `set`). 허용되지 않은 전이는 거절한다 (FR-LIS-5·8). blocked 의 이유는 진행 기록에
    /// 남긴다.
    pub fn set(&self, id: &str, c: &Change, date: &str) -> Result<Issue, Error> {
        self.locked(|| {
            let (path, mut i) = self.get(id)?;
            if let Some(to) = c.status {
                if !transition_ok(i.status, to) {
                    return Err(Error::Transition { from: i.status, to });
                }
                if to == Status::Blocked && i.status != Status::Blocked {
                    let reason = c.reason.as_deref().map(str::trim).unwrap_or_default();
                    if reason.is_empty() {
                        return Err(Error::NeedReason);
                    }
                    i.body = append_log(&i.body, date, &format!("blocked — {reason}"));
                }
                i.status = to;
            }
            if let Some(o) = &c.owner {
                i.owner = o.clone();
            }
            if let Some(b) = &c.branch {
                i.branch = b.clone();
            }
            Self::save(&path, &i)?;
            Ok(i)
        })
    }

    /// 진행 기록에 글을 덧붙인다 (FR-LIS-6 `log`).
    pub fn log(&self, id: &str, date: &str, text: &str) -> Result<(), Error> {
        if text.trim().is_empty() {
            return Err(Error::Format("덧붙일 글이 비었다".into()));
        }
        self.locked(|| {
            let (path, mut i) = self.get(id)?;
            i.body = append_log(&i.body, date, text);
            Self::save(&path, &i)
        })
    }

    /// 트리를 찍는다 (FR-LIS-6 `tree`, `tree.sh` 와 같은 모양). filter 가 있으면 그 상태(보이는 상태)만 찍는다.
    pub fn tree(&self, filter: &[String]) -> Result<String, Error> {
        let all = self.issues()?;
        let mut out = String::new();
        for i in &all {
            let st = shown_status(i, &all).as_str();
            if !filter.is_empty() && !filter.iter().any(|f| f == st) {
                continue;
            }
            let depth = i.id.matches('.').count();
            out.push_str(&format!(
                "{:indent$}{:<7} [{st:<11}] {}",
                "",
                i.id,
                i.title,
                indent = depth * 2
            ));
            if !i.deps.is_empty() {
                out.push_str(&format!("  ← {}", i.deps.join(",")));
            }
            if !i.owner.is_empty() {
                let o: String = i.owner.chars().take(8).collect();
                out.push_str(&format!("  @{o}"));
            }
            out.push('\n');
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests;
