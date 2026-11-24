//! 저장소 단위 상호 배제 (REPO_FIX 01 §5). 동기 쓰기의 잠금(LockTop·LockCommon)과 잡의 칸(claim)이다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use otter_webserver_domain_git_core::{self as core, Ctx};
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{Error, JobsKind};

pub const SLOT_INDEX: &str = "index";
pub const SLOT_COMMON: &str = "common";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename = "jobs.SlotInfo")]
pub struct SlotInfo {
    pub slot: &'static str,
    pub remote: bool,
}

/// 화면이 칸을 보일 순서다.
pub const SLOT_ORDER: [SlotInfo; 2] = [
    SlotInfo {
        slot: SLOT_INDEX,
        remote: false,
    },
    SlotInfo {
        slot: SLOT_COMMON,
        remote: true,
    },
];

/// 그 종류의 잡이 쥐는 칸이다.
pub fn slots_of(kind: &str) -> Vec<String> {
    match kind {
        "pull" => vec![SLOT_INDEX.to_owned(), SLOT_COMMON.to_owned()],
        "fetch" | "push" | "submodule" | "worktree" => vec![SLOT_COMMON.to_owned()],
        _ => vec![SLOT_INDEX.to_owned()],
    }
}

/// 잡이 쥐는 칸의 키다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Keys {
    /// `--show-toplevel`.
    pub top: String,
    /// `--git-common-dir` 절대화.
    pub common: String,
}

#[derive(Default)]
struct State {
    tops: HashMap<String, Sem>,
    commons: HashMap<String, Sem>,
    index: HashMap<String, String>,
    common: HashMap<String, String>,
}

struct Sem {
    sem: Arc<Semaphore>,
    /// 쥔 쪽 + 기다리는 쪽. 0 이 되면 자리를 지운다.
    refs: usize,
}

#[derive(Clone, Copy)]
enum Table {
    Tops,
    Commons,
}

#[derive(Clone, Default)]
pub struct Exclusion {
    st: Arc<Mutex<State>>,
}

/// 쥔 잠금. [`Release::release`] 나 drop 으로 놓는다.
pub struct Release {
    x: Exclusion,
    table: Table,
    key: String,
    sem: Arc<Semaphore>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Release {
    pub fn release(mut self) {
        self.free();
    }

    fn free(&mut self) {
        if self.permit.take().is_some() {
            self.x.unref(self.table, &self.key, &self.sem);
        }
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        self.free();
    }
}

impl Exclusion {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn lock_top(&self, ctx: &Ctx, key: &str, wait: Duration) -> Result<Release, Error> {
        self.acquire(ctx, Table::Tops, key, wait).await
    }

    pub async fn lock_common(
        &self,
        ctx: &Ctx,
        key: &str,
        wait: Duration,
    ) -> Result<Release, Error> {
        self.acquire(ctx, Table::Commons, key, wait).await
    }

    pub fn try_lock_top(&self, key: &str) -> Option<Release> {
        let sem = self.ref_sem(Table::Tops, key);
        match Arc::clone(&sem).try_acquire_owned() {
            Ok(p) => Some(self.releaser(Table::Tops, key, sem, p)),
            Err(_) => {
                self.unref(Table::Tops, key, &sem);
                None
            }
        }
    }

    /// 그 toplevel 의 index 칸을 쥔 잡 id.
    pub fn index_busy(&self, top: &str) -> Option<String> {
        self.lock().index.get(top).cloned()
    }

    /// 그 common-dir 의 common 칸을 쥔 잡 id.
    pub fn common_busy(&self, common: &str) -> Option<String> {
        self.lock().common.get(common).cloned()
    }

    async fn acquire(
        &self,
        ctx: &Ctx,
        table: Table,
        key: &str,
        wait: Duration,
    ) -> Result<Release, Error> {
        if let Some(e) = ctx_err(ctx) {
            return Err(e);
        }
        let sem = self.ref_sem(table, key);
        tokio::select! {
            p = Arc::clone(&sem).acquire_owned() => match p {
                Ok(p) => Ok(self.releaser(table, key, sem, p)),
                Err(_) => {
                    self.unref(table, key, &sem);
                    Err(Error::new(JobsKind::RepoBusy, key))
                }
            },
            () = ctx.done() => {
                self.unref(table, key, &sem);
                Err(ctx_err(ctx).unwrap_or_else(|| Error::new(JobsKind::RepoBusy, key)))
            }
            () = tokio::time::sleep(wait) => {
                self.unref(table, key, &sem);
                Err(Error::new(
                    JobsKind::RepoBusy,
                    format!(
                        "{key} 의 쓰기가 {} 안에 끝나지 않았다",
                        otter_gocompat::time::format_std_duration(wait)
                    ),
                ))
            }
        }
    }

    fn ref_sem(&self, table: Table, key: &str) -> Arc<Semaphore> {
        let mut st = self.lock();
        let m = match table {
            Table::Tops => &mut st.tops,
            Table::Commons => &mut st.commons,
        };
        let s = m.entry(key.to_owned()).or_insert_with(|| Sem {
            sem: Arc::new(Semaphore::new(1)),
            refs: 0,
        });
        s.refs += 1;
        Arc::clone(&s.sem)
    }

    fn unref(&self, table: Table, key: &str, sem: &Arc<Semaphore>) {
        let mut st = self.lock();
        let m = match table {
            Table::Tops => &mut st.tops,
            Table::Commons => &mut st.commons,
        };
        if let Some(s) = m.get_mut(key)
            && Arc::ptr_eq(&s.sem, sem)
        {
            s.refs -= 1;
            if s.refs == 0 {
                m.remove(key);
            }
        }
    }

    fn releaser(
        &self,
        table: Table,
        key: &str,
        sem: Arc<Semaphore>,
        permit: OwnedSemaphorePermit,
    ) -> Release {
        Release {
            x: self.clone(),
            table,
            key: key.to_owned(),
            sem,
            permit: Some(permit),
        }
    }

    pub(crate) fn claim(&self, k: &Keys, slots: &[String], id: &str) -> Result<(), Error> {
        let mut st = self.lock();
        for slot in slots {
            let (m, key) = slot_of(&mut st, k, slot);
            if let Some(other) = m.get(key) {
                return Err(Error::new(
                    JobsKind::JobBusy,
                    format!("{key} 의 {slot} 칸에 진행 중인 작업이 있다 ({other})"),
                ));
            }
        }
        for slot in slots {
            let (m, key) = slot_of(&mut st, k, slot);
            m.insert(key.to_owned(), id.to_owned());
        }
        Ok(())
    }

    pub(crate) fn free(&self, k: &Keys, slots: &[String], id: &str) {
        let mut st = self.lock();
        for slot in slots {
            let (m, key) = slot_of(&mut st, k, slot);
            if m.get(key).is_some_and(|v| v == id) {
                m.remove(key);
            }
        }
    }

    /// 쥔 것도 기다리는 것도 없는가 (시험용).
    #[cfg(test)]
    pub(crate) fn idle(&self) -> bool {
        let st = self.lock();
        st.tops.is_empty() && st.commons.is_empty()
    }
}

fn slot_of<'a>(
    st: &'a mut State,
    k: &'a Keys,
    slot: &str,
) -> (&'a mut HashMap<String, String>, &'a str) {
    if slot == SLOT_INDEX {
        (&mut st.index, &k.top)
    } else {
        (&mut st.common, &k.common)
    }
}

fn ctx_err(ctx: &Ctx) -> Option<Error> {
    core::ctx_err(ctx, "잠금을 기다리는 중").map(Error::from)
}
