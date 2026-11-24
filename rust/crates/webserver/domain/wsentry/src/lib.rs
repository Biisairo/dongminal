//! Go 기준선 `otterminal/internal/webserver/domain/wsentry` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! workspace.json 최상위의 두 목록 — `git.pinned[]` 와 `editors.list[]` — 을 함께 소유한다
//! (EDITOR_TAB_SRS FR-EDT-116, D-17). 핀 하나를 더하면 같은 경로의 Editor 행이 함께 생겨야
//! 하므로 변경은 언제나 한 번의 read-modify-write 다 (FR-EDT-35). git 을 실행하지 않는다 —
//! 저장소 루트 판정은 [`RepoRootFn`] 으로 주입받는다.

#![forbid(unsafe_code)]

mod error;
mod fsx;
mod link;
mod mutate;

use std::sync::{Arc, Mutex};

use otter_gocompat::filepath;
use otter_webserver_domain_git_core::{BoxFut, Ctx};

pub use error::Error;
pub use link::{link_editor_add, link_editor_remove, link_pin_add, link_pin_remove};

/// 두 목록을 읽고 쓰기 위한 최소 표면이다. `otter_shared_workspace::Manager` 가 만족한다.
pub trait WorkspaceStore: Send + Sync {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64);
    fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, otter_shared_workspace::Error>;
}

impl WorkspaceStore for otter_shared_workspace::Manager {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        otter_shared_workspace::Manager::snapshot(self)
    }
    fn save(&self, blob: &[u8], if_match: &str) -> Result<u64, otter_shared_workspace::Error> {
        otter_shared_workspace::Manager::save(self, blob, if_match)
    }
}

/// 목록 변경을 다른 브라우저 창에 알리기 위한 최소 표면이다.
pub trait Broadcaster: Send + Sync {
    fn broadcast(&self, payload: &[u8]) -> usize;
}

/// 경로가 속한 git 저장소의 루트를 답한다 (FR-EDT-33 판정용). 오류는 "루트가 아님"으로 읽는다.
pub type RepoRootFn = Arc<dyn Fn(Ctx, String) -> BoxFut<Result<String, String>> + Send + Sync>;

/// root 에디터의 경로다 (FR-EDT-13). 없으면 Go `os.UserHomeDir` 이다 (FR-EDT-17). 오류는 문구다.
pub type HomeFn = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

/// 한 번의 저장에 함께 담기는 두 목록이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lists {
    pub pinned: Vec<String>,
    pub editors: Vec<String>,
}

/// 두 목록의 소유자다. `work` 가 없으면 모든 변경이 [`Error::Unavailable`] 이다.
#[derive(Default)]
pub struct Store {
    pub work: Option<Arc<dyn WorkspaceStore>>,
    pub commands: Option<Arc<dyn Broadcaster>>,
    /// 없으면 FR-EDT-33 의 연동만 서지 않는다. Editor 행 자체는 그대로 추가된다.
    pub repo_root: Option<RepoRootFn>,
    pub home_fn: Option<HomeFn>,
    /// 메모 루트가 놓일 자리다 (FR-NOT-1). 비면 메모장 표면이 없다 (FR-NOT-11).
    pub notes_dir: String,
    /// 언어 서버 플러그인 선언들의 자리다 (FR-EXT-9b).
    pub plugins_dir: String,
    /// Roots 의 기억 — workspace rev 하나에 대한 editors.list (FR-OPT-8-2). 정규화는 기억하지
    /// 않는다 — 요청 경로 정규화와 같은 시점의 파일시스템을 따라야 한다.
    roots_memo: Mutex<Option<(u64, Arc<Vec<String>>)>>,
}

/// 경로 정규화의 유일한 함수다 (FR-EDT-24, D-15). 링크를 풀지 못하면 Clean 만 한 값이다 —
/// 사라진 디렉터리의 핀·행도 지울 수 있어야 한다 (FR-EDT-26).
pub fn normalize_path(p: &str) -> String {
    let cleaned = filepath::clean(p);
    match filepath::eval_symlinks(&cleaned) {
        Ok(r) => filepath::clean(&r),
        Err(_) => cleaned,
    }
}

/// list 앞에 서는 고정 루트다 — home → notes → plugins, 빈 자리는 빠진다 (SERVER_DRIVEN_ACTIONS_SRS K-e).
pub fn fixed_roots(home: &str, notes: &str, plugins: &str) -> Vec<String> {
    [home, notes, plugins]
        .into_iter()
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Editor 행이 될 경로의 판정이다 (F-m). 앞뒤 공백을 지운 뒤 보고, 정규화한 경로를 돌려준다.
pub fn check_editor_path(path: &str) -> Result<String, Error> {
    let path = path.trim();
    if path.is_empty() {
        return Err(Error::EmptyPath);
    }
    if !filepath::is_abs(path) {
        return Err(Error::NotAbsolute);
    }
    let norm = normalize_path(path);
    let Ok(st) = std::fs::metadata(&norm) else {
        return Err(Error::NotFound);
    };
    if filepath::dir(&norm) == norm {
        return Err(Error::FilesystemRoot);
    }
    if !st.is_dir() {
        return Err(Error::NotDir);
    }
    Ok(norm)
}

/// Notes·Plugins 의 "없으면 만든다" 다 (FR-RDG-63).
fn ensure_root(dir: &str) -> Result<String, Error> {
    if dir.is_empty() {
        return Err(Error::Unavailable);
    }
    fsx::mkdir_all(dir).map_err(|e| Error::Io(otter_gocompat::oserr::go_error_string(&e)))?;
    Ok(normalize_path(dir))
}

impl Store {
    fn work(&self) -> Result<&Arc<dyn WorkspaceStore>, Error> {
        self.work.as_ref().ok_or(Error::Unavailable)
    }

    /// 정규화 전의 홈이다 — home_fn, 없으면 Go `os.UserHomeDir`.
    fn home_raw(&self) -> Result<String, Error> {
        match &self.home_fn {
            Some(f) => f().map_err(Error::Home),
            None => fsx::user_home_dir().map_err(Error::Home),
        }
    }

    /// 정규화된 홈 디렉터리다. 저장하지 않고 매번 파생한다 (FR-EDT-17).
    pub fn home(&self) -> Result<String, Error> {
        Ok(normalize_path(&self.home_raw()?))
    }

    /// 정규화된 메모 루트다 (FR-NOT-1·2). 없으면 만든다.
    pub fn notes(&self) -> Result<String, Error> {
        ensure_root(&self.notes_dir)
    }

    /// 플러그인 선언들의 루트다 (FR-EXT-9b). 메모 루트와 같은 규약이다.
    pub fn plugins(&self) -> Result<String, Error> {
        ensure_root(&self.plugins_dir)
    }

    /// 저장된 두 목록을 준다.
    pub fn read(&self) -> Result<Lists, Error> {
        let (raw, _) = self.work()?.snapshot();
        Ok(mutate::parse(&raw)?.1)
    }

    /// `{home, list}` 다 (FR-EDT-29). home 은 list 에 들어 있지 않다.
    pub fn list(&self) -> Result<(String, Vec<String>), Error> {
        let home = self.home()?;
        let l = self.read()?;
        Ok((home, l.editors))
    }

    /// `[home, notes, plugins, ...editors.list]` 다 — 파일 조작이 신뢰할 수 있는 루트의 전부다
    /// (FR-EDT-113). 파싱은 rev 로 기억하고 정규화는 매번 한다 (DOM-25).
    pub fn roots(&self) -> Result<Vec<String>, Error> {
        let home = self.home_raw()?;
        let work = self.work()?;
        let editors = self.editors_at(work.as_ref())?;
        // 만들 수 없는 자리는 빈 값으로 빠진다 (FR-NOT-11).
        let notes = ensure_root(&self.notes_dir).unwrap_or_default();
        let plugins = ensure_root(&self.plugins_dir).unwrap_or_default();
        let mut out = fixed_roots(&normalize_path(&home), &notes, &plugins);
        out.extend(editors.iter().map(|e| normalize_path(e)));
        Ok(out)
    }

    fn editors_at(&self, work: &dyn WorkspaceStore) -> Result<Arc<Vec<String>>, Error> {
        let (raw, rev) = work.snapshot();
        let mut memo = self.roots_memo.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((r, editors)) = memo.as_ref()
            && *r == rev
        {
            return Ok(editors.clone());
        }
        let editors = Arc::new(mutate::parse(&raw)?.1.editors);
        *memo = Some((rev, editors.clone()));
        Ok(editors)
    }

    /// Editor 행을 더한다 (FR-EDT-23~25·33). 홈·메모 루트는 고정 행이 대표하므로 무변경이다
    /// (FR-EDT-16, FR-NOT-5).
    pub async fn editor_add(&self, ctx: &Ctx, path: &str) -> Result<Lists, Error> {
        let norm = check_editor_path(path)?;
        let home = self.home()?;
        if norm == home {
            return self.read();
        }
        if let Ok(notes) = self.notes()
            && norm == notes
        {
            return self.read();
        }
        let repo_root = self.is_repo_root(ctx, &norm).await;
        self.mutate(|cur| link_editor_add(cur, &norm, &home, repo_root))
    }

    /// 그 경로가 저장소의 루트인가. 저장소 안이지만 루트가 아니면 거짓이다 (FR-EDT-33).
    async fn is_repo_root(&self, ctx: &Ctx, norm: &str) -> bool {
        let Some(f) = &self.repo_root else {
            return false;
        };
        match f(ctx.clone(), norm.to_owned()).await {
            Ok(root) => normalize_path(&root) == norm,
            Err(_) => false,
        }
    }

    /// 문자열 완전 일치로 지운다 (FR-EDT-26). 다시 정규화하지 않는다.
    pub fn editor_remove(&self, path: &str) -> Result<Lists, Error> {
        let home = self.home()?;
        self.mutate(|cur| link_editor_remove(cur, path, &home))
    }

    /// (src, target, before) 델타를 적용한다 (FR-EDT-27).
    pub fn editor_reorder(
        &self,
        src: &str,
        target: &str,
        before: bool,
    ) -> Result<Vec<String>, Error> {
        let l = self.mutate(|mut cur| {
            cur.editors = link::reorder(&cur.editors, src, target, before);
            cur
        })?;
        Ok(l.editors)
    }

    /// 핀을 더하고 같은 경로의 Editor 행을 함께 만든다 (FR-EDT-31·37). 저장한 정규 경로를 함께
    /// 돌려준다. 홈을 모르면 홈 예외 없이 진행한다.
    pub fn pin_add(&self, root: &str) -> Result<(String, Lists), Error> {
        let norm = normalize_path(root);
        let home = self.home().unwrap_or_default();
        let l = self.mutate(|cur| link_pin_add(cur, &norm, &home))?;
        Ok((norm, l))
    }

    /// 문자열 완전 일치로 핀을 지우고 같은 경로의 Editor 행을 함께 지운다 (FR-EDT-32).
    pub fn pin_remove(&self, path: &str) -> Result<Lists, Error> {
        let home = self.home().unwrap_or_default();
        self.mutate(|cur| link_pin_remove(cur, path, &home))
    }
}

#[cfg(test)]
mod tests;
