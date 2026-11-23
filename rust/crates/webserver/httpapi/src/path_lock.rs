//! 경로마다 잠금 하나 (Go `path_lock.go`, REFACTOR3_DEFECTS_SRS FR-RD3-20·22).
//!
//! 쓰는 동안만 항목을 두고 다 풀면 지운다 — 열어 본 경로 수만큼 쌓이지 않는다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::OwnedMutexGuard;

#[derive(Default)]
struct Entry {
    lock: Arc<tokio::sync::Mutex<()>>,
    n: usize,
}

#[derive(Default)]
pub(crate) struct PathLocks {
    m: Arc<Mutex<HashMap<String, Entry>>>,
}

/// 잡은 잠금이다. 놓으면 풀린다.
pub(crate) struct PathGuard {
    _g: OwnedMutexGuard<()>,
    m: Arc<Mutex<HashMap<String, Entry>>>,
    path: String,
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        let mut m = self.m.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = m.get_mut(&self.path) {
            e.n -= 1;
            if e.n == 0 {
                m.remove(&self.path);
            }
        }
    }
}

impl PathLocks {
    /// path 의 잠금을 얻는다.
    pub(crate) async fn lock(&self, path: &str) -> PathGuard {
        let lock = {
            let mut m = self.m.lock().unwrap_or_else(|e| e.into_inner());
            let e = m.entry(path.to_owned()).or_default();
            e.n += 1;
            e.lock.clone()
        };
        PathGuard {
            _g: lock.lock_owned().await,
            m: self.m.clone(),
            path: path.to_owned(),
        }
    }

    #[cfg(test)]
    pub(crate) fn size(&self) -> usize {
        self.m.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}
