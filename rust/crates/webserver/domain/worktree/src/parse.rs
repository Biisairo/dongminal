//! `git worktree list --porcelain` 해석 (FR-GIT-240).

use otter_gocompat::filepath;
use serde::Serialize;

/// `git worktree list` 한 레코드다. 소유 판정은 호출자의 일이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Entry {
    pub path: String,
    pub branch: String,
    pub detached: bool,
    /// git 의 main worktree 인가 (V162). 파싱 순서에서 낸다 — git-worktree(1): "The main
    /// worktree is listed first". 조회 경로와 같은가로 판정하지 않는다.
    pub main: bool,
}

pub(crate) fn parse_worktree_list(out: &str) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut cur: Option<Entry> = None;
    for ln in out.split('\n') {
        let ln = ln.trim_end_matches('\r');
        if ln.is_empty() {
            entries.extend(cur.take());
        } else if let Some(p) = ln.strip_prefix("worktree ") {
            entries.extend(cur.take());
            cur = Some(Entry {
                path: normalize_git_path(p),
                main: entries.is_empty(),
                ..Entry::default()
            });
        } else if ln == "detached" {
            if let Some(c) = cur.as_mut() {
                c.detached = true;
            }
        } else if let Some(b) = ln.strip_prefix("branch ")
            && let Some(c) = cur.as_mut()
        {
            c.branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_owned();
        }
    }
    entries.extend(cur);
    entries
}

/// git 이 낸 경로를 OS 형태로 옮긴다 (FR-WTP-3). Windows git 의 `C:/x` 를 `C:\x` 로.
pub(crate) fn normalize_git_path(p: &str) -> String {
    if p.trim().is_empty() {
        return p.to_owned();
    }
    filepath::clean(p)
}
