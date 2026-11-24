//! 파일 변경을 언어 서버에 알린다 (`workspace/didChangeWatchedFiles`). 브라우저를 거치지 않고
//! 터널에 끼워 넣는다.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use dm_gocompat::filepath;
use dm_gocompat::json;
use serde::Serialize;

use crate::service::{Service, under_root};

/// LSP FileChangeType.
pub const WATCH_CREATED: i64 = 1;
pub const WATCH_CHANGED: i64 = 2;
pub const WATCH_DELETED: i64 = 3;

/// 알림 하나에 싣는 변경 수의 기본 상한.
pub const DEFAULT_WATCH_MAX: usize = 2000;

/// 파일 하나의 변경.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEvent {
    pub path: String,
    pub typ: i64,
}

#[derive(Serialize)]
struct WatchChange {
    uri: String,
    #[serde(rename = "type")]
    typ: i64,
}

#[derive(Serialize)]
struct WatchParams {
    changes: Vec<WatchChange>,
}

#[derive(Serialize)]
struct WatchNote {
    jsonrpc: &'static str,
    method: &'static str,
    params: WatchParams,
}

/// 변경을 받는 쪽.
pub trait FileNotifier: Send + Sync {
    fn notify_files(&self, events: &[FileEvent]);
}

impl Service {
    fn watch_max(&self) -> usize {
        if self.watch_max > 0 {
            self.watch_max
        } else {
            DEFAULT_WATCH_MAX
        }
    }
}

impl FileNotifier for Service {
    /// 각 터널의 루트 아래 변경만 그 터널에 보낸다. 초기화 전이거나 줄이 찬 터널은 건너뛴다 —
    /// 하나가 막혀도 다른 터널을 기다리게 하지 않는다.
    fn notify_files(&self, events: &[FileEvent]) {
        if events.is_empty() {
            return;
        }
        let max = self.watch_max();
        for t in self.state.tunnels() {
            let changes: Vec<WatchChange> = events
                .iter()
                .filter(|e| under_root(&t.root, &e.path))
                .take(max)
                .map(|e| WatchChange {
                    uri: path_to_uri(&e.path),
                    typ: e.typ,
                })
                .collect();
            if changes.is_empty() {
                continue;
            }
            let n = changes.len();
            let note = WatchNote {
                jsonrpc: "2.0",
                method: "workspace/didChangeWatchedFiles",
                params: WatchParams { changes },
            };
            let Ok(body) = json::marshal(&note) else {
                continue;
            };
            if !t.enqueue(body) && t.ready.load(std::sync::atomic::Ordering::SeqCst) {
                dm_shared_dmlog::warnf!(
                    None,
                    "lsp: 끼워 넣기 줄이 찼다 ({}) — 변경 {n}개를 버린다",
                    t.root
                );
            }
        }
    }
}

fn path_to_uri(p: &str) -> String {
    dm_shared_platform::current().paths.file_uri(p)
}

/// git `--name-status` 한 줄 (A D M R C T).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NameStatus {
    pub status: String,
    pub path: String,
    pub orig_path: String,
}

/// 저장소 한 순간: HEAD 와 작업 트리에서 바뀐 파일들(상대경로 → 새 파일인가).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoSnap {
    pub head: String,
    pub files: BTreeMap<String, bool>,
}

/// 저장소를 들여다보는 쪽.
pub trait RepoView: Send + Sync {
    fn snapshot(&self, repo: &str) -> Option<RepoSnap>;
    fn name_status(&self, repo: &str, from: &str, to: &str) -> Result<Vec<NameStatus>, String>;
}

/// 경로가 있는가. 검사가 바꿔 끼운다.
pub type ExistsFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// 저장소 변화를 파일 변경 알림으로 바꾼다.
pub struct RepoWatch {
    pub view: Arc<dyn RepoView>,
    pub out: Arc<dyn FileNotifier>,
    /// 비면 실제 파일시스템이다.
    pub exists: Option<ExistsFn>,
    last: Mutex<HashMap<String, RepoSnap>>,
}

impl RepoWatch {
    pub fn new(view: Arc<dyn RepoView>, out: Arc<dyn FileNotifier>) -> Self {
        Self {
            view,
            out,
            exists: None,
            last: Mutex::new(HashMap::new()),
        }
    }

    /// 기준만 세운다. 알리지 않는다.
    pub fn seen(&self, repo: &str) {
        if let Some(cur) = self.view.snapshot(repo) {
            self.last
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(repo.to_owned(), cur);
        }
    }

    /// 지난 기준과 비교해 바뀐 파일들을 알린다. HEAD 가 움직였을 때만 git 에 묻는다.
    pub fn changed(&self, repo: &str) {
        let Some(cur) = self.view.snapshot(repo) else {
            return;
        };
        let prev = self
            .last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(repo.to_owned(), cur.clone());
        let mut ns = Vec::new();
        if let Some(p) = &prev
            && !p.head.is_empty()
            && !cur.head.is_empty()
            && p.head != cur.head
        {
            match self.view.name_status(repo, &p.head, &cur.head) {
                Ok(got) => ns = got,
                Err(e) => dm_shared_dmlog::warnf!(
                    None,
                    "lsp: {repo} 의 {}..{} 변경 목록을 얻지 못했다: {e}",
                    p.head,
                    cur.head
                ),
            }
        }
        let exists = |p: &str| match &self.exists {
            Some(f) => f(p),
            None => std::fs::metadata(p).is_ok(),
        };
        let evs = repo_events(repo, prev.as_ref(), &cur, &ns, &exists);
        if !evs.is_empty() {
            self.out.notify_files(&evs);
        }
    }
}

/// 바뀐 파일들을 경로 순 이벤트로. 같은 파일은 한 번이며, 새로 생긴 표시가 하나라도 있으면 새 파일이다.
pub(crate) fn repo_events(
    repo: &str,
    prev: Option<&RepoSnap>,
    cur: &RepoSnap,
    ns: &[NameStatus],
    exists: &dyn Fn(&str) -> bool,
) -> Vec<FileEvent> {
    let mut created: HashMap<String, bool> = HashMap::new();
    let mut mark = |rel: &str, is_new: bool| {
        if rel.is_empty() {
            return;
        }
        let e = created.entry(rel.to_owned()).or_insert(false);
        *e = *e || is_new;
    };
    for n in ns {
        match n.status.as_str() {
            "A" | "C" => mark(&n.path, true),
            "R" => {
                mark(&n.orig_path, false);
                mark(&n.path, true);
            }
            _ => mark(&n.path, false),
        }
    }
    if let Some(p) = prev {
        for rel in p.files.keys() {
            mark(rel, false);
        }
    }
    for (rel, is_new) in &cur.files {
        mark(rel, *is_new);
    }
    let mut out: Vec<FileEvent> = created
        .into_iter()
        .map(|(rel, is_new)| {
            let p = filepath::join(&[repo, filepath::from_slash(&rel).as_str()]);
            let typ = if !exists(&p) {
                WATCH_DELETED
            } else if is_new {
                WATCH_CREATED
            } else {
                WATCH_CHANGED
            };
            FileEvent { path: p, typ }
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}
