//! 저장소 트리의 파일 감시 (PERF M4 설계 §1 S1, D-61). 감시 사건은 계기 관측(`kick`)으로 status 를
//! 당기고, 감시를 세우지 못했거나 넘치면 그 저장소는 워크트리 회차로 물러선다 (Q4).

use std::sync::Arc;

use super::GitWatcher;

/// 트리 감시가 알리는 것이다.
#[derive(Clone, Copy, Debug)]
pub enum TreeEvent<'a> {
    /// 이 경로들이 바뀌었다.
    Paths(&'a [String]),
    /// 사건을 놓쳤다(넘침) — 감시를 더는 믿을 수 없다.
    Lost,
}

pub type TreeHook = Arc<dyn Fn(TreeEvent<'_>) + Send + Sync>;
/// 감시 하나다. 버리면 감시가 멈춘다.
pub type WatchGuard = Box<dyn Send>;

/// 저장소 트리를 재귀로 감시하는 자리다. 서버는 OS 감시(macOS FSEvents, Linux inotify)를 단다.
pub trait TreeWatcher: Send + Sync {
    /// `root` 아래 전체를 감시한다. 세우지 못하면(감시 한도 포함) 오류다.
    fn watch(&self, root: &str, hook: TreeHook) -> Result<WatchGuard, String>;
}

impl GitWatcher {
    /// 저장소 트리 감시를 단다. 없으면 모든 저장소가 워크트리 회차로 돈다.
    pub fn set_tree_watcher(&self, t: Option<Arc<dyn TreeWatcher>>) {
        self.lock().tree = t;
    }

    /// 새 감시 항목의 트리 감시를 세운다. 세우면 그 저장소는 워크트리 회차를 돌지 않는다.
    pub(super) fn watch_tree(&self, repo: &str, id: u64) {
        let Some(tree) = self.lock().tree.clone() else {
            return;
        };
        // 감시 사건은 tokio 밖의 스레드에서 오고, 계기 관측은 tokio 타이머를 건다.
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let me = self.me.clone();
        let r = repo.to_owned();
        let hook: TreeHook = Arc::new(move |ev: TreeEvent<'_>| {
            let Some(w) = me.upgrade() else {
                return;
            };
            match ev {
                TreeEvent::Paths(p) => {
                    let _g = rt.enter();
                    w.kick(p);
                }
                TreeEvent::Lost => w.tree_lost(&r, id),
            }
        });
        let guard = match tree.watch(repo, hook) {
            Ok(g) => g,
            Err(err) => {
                otter_shared_otterlog::infof!(
                    None,
                    "[gitwatch] 파일 감시를 세우지 못해 회차로 물러선다 (repo={repo} err={err})"
                );
                return;
            }
        };
        let stale = {
            let mut g = self.lock();
            match g.watch.get_mut(repo) {
                Some(e) if e.watch_id == id => {
                    e.tree = Some(guard);
                    e.fallback = false;
                    None
                }
                _ => Some(guard),
            }
        };
        drop(stale);
    }

    /// 감시가 넘쳤다. 감시를 놓고 그 저장소를 워크트리 회차로 돌린다.
    fn tree_lost(&self, repo: &str, id: u64) {
        let guard = {
            let mut g = self.lock();
            match g.watch.get_mut(repo) {
                Some(e) if e.watch_id == id && !e.fallback => {
                    e.fallback = true;
                    e.tree.take()
                }
                _ => return,
            }
        };
        drop(guard);
        otter_shared_otterlog::infof!(
            None,
            "[gitwatch] 파일 감시가 넘쳐 회차로 물러선다 (repo={repo})"
        );
    }
}
