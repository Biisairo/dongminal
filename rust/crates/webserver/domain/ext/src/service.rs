//! HTTP 종단과 세션 계층이 딛는 표면. **선언을 캐시하지 않는다** (FR-EXT-33·9c) — 매 조회마다
//! 격리 칸을 다시 읽는다.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use otter_gocompat::strconv::quote;

use crate::builtin::deploy;
use crate::ctx::Ctx;
use crate::error::Error;
use crate::fetch::{Fetch, HttpFetch};
use crate::install::{Exec, HostExec, Installer, Outcome, fail};
use crate::load::{load, packs, runtimes, server_for_ext};
use crate::locate::{
    Locator, LookPath, MISSING_RUNTIME, MISSING_TARGET, MISSING_TOOL, Status, host_look_path,
    with_readiness,
};
use crate::manifest::{Manifest, Server};

/// 확장 서비스.
pub struct Service {
    /// 격리 칸 (`<데이터>/ext`).
    pub root: String,
    pub look_path: LookPath,
    pub fetch: Arc<dyn Fetch>,
    pub exec: Arc<dyn Exec>,
    /// 지금 받고 있는 팩들 (FR-EXT-32). 다른 탭·기기의 두 번째 조달을 서버가 막는다.
    installing: Mutex<HashSet<String>>,
}

/// installing 의 칸 하나를 쥔다. 조달이 끝나거나 취소되면(Drop) 놓는다.
struct InstallingGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for InstallingGuard<'_> {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

impl Service {
    /// 실제 PATH·네트워크·프로세스를 쓰는 Service.
    pub fn new(root: &str) -> Self {
        Self::with(
            root,
            host_look_path(),
            Arc::new(HttpFetch),
            Arc::new(HostExec),
        )
    }

    /// 의존을 주입한 Service.
    pub fn with(
        root: &str,
        look_path: LookPath,
        fetch: Arc<dyn Fetch>,
        exec: Arc<dyn Exec>,
    ) -> Self {
        Self {
            root: root.to_owned(),
            look_path,
            fetch,
            exec,
            installing: Mutex::new(HashSet::new()),
        }
    }

    /// 동봉 선언을 편다 (FR-EXT-34). 기동에서 한 번 부른다.
    pub fn deploy(&self) -> Vec<Error> {
        deploy(&self.root)
    }

    /// 지금 격리 칸에 있는 선언들.
    pub fn manifests(&self) -> (Vec<Manifest>, Vec<Error>) {
        load(&self.root)
    }

    fn locator(&self, ms: &[Manifest], overrides: &HashMap<String, String>) -> Locator {
        Locator {
            root: self.root.clone(),
            look_path: Arc::clone(&self.look_path),
            overrides: overrides.clone(),
            runtimes: runtimes(ms),
            target: String::new(),
        }
    }

    fn inflight(&self) -> HashSet<String> {
        self.installing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 서버마다 한 줄의 관측과, 깨진 선언의 사유 (FR-EXT-33·8). overrides 는 화면이 실어 보낸
    /// 절대경로 표다 (FR-LSP-4b).
    pub fn status(&self, overrides: &HashMap<String, String>) -> (Vec<Status>, Vec<String>) {
        let (ms, load_errs) = self.manifests();
        let loc = self.locator(&ms, overrides);
        let inflight = self.inflight();
        let mut out = Vec::new();
        for m in packs(&ms) {
            // 조달 판정은 팩 단위다 (FR-EXT-5 / FR-OPT-6-4).
            let (can, missing) = loc.readiness(&m);
            for srv in &m.servers {
                let mut st = loc.find(&m, srv);
                with_readiness(&mut st, can, missing.clone());
                st.installing = inflight.contains(&m.id);
                st.note = missing_text(&st);
                out.push(st);
            }
        }
        (out, load_errs.iter().map(Error::to_string).collect())
    }

    /// 지금 선언이 내는 서술자 id(팩/서버)들 (FR-OPT-6-4). 탐색하지 않는다.
    pub fn server_ids(&self) -> BTreeSet<String> {
        let (ms, _) = self.manifests();
        packs(&ms)
            .iter()
            .flat_map(|m| m.servers.iter().map(move |s| format!("{}/{}", m.id, s.id)))
            .collect()
    }

    /// 확장자를 (팩, 서버, 관측) 으로 푼다. 찾았으면 조달 가능성을 따지지 않는다 (FR-OPT-6-4).
    pub fn resolve(
        &self,
        ext: &str,
        overrides: &HashMap<String, String>,
    ) -> Option<(Manifest, Server, Status)> {
        let (ms, _) = self.manifests();
        let (m, srv) = server_for_ext(&ms, ext)?;
        let st = self.observe(&ms, &m, &srv, overrides);
        Some((m, srv, st))
    }

    /// 서술자 id(팩/서버)를 (서버, 관측) 으로 푼다 (CODEMIRROR_MIGRATION_SRS FR-CMR-91).
    pub fn resolve_id(
        &self,
        desc_id: &str,
        overrides: &HashMap<String, String>,
    ) -> Option<(Server, Status)> {
        let (ms, _) = self.manifests();
        for m in packs(&ms) {
            for srv in &m.servers {
                if format!("{}/{}", m.id, srv.id) == desc_id {
                    let st = self.observe(&ms, &m, srv, overrides);
                    return Some((srv.clone(), st));
                }
            }
        }
        None
    }

    fn observe(
        &self,
        ms: &[Manifest],
        m: &Manifest,
        srv: &Server,
        overrides: &HashMap<String, String>,
    ) -> Status {
        let loc = self.locator(ms, overrides);
        let mut st = loc.find(m, srv);
        if !st.found {
            let (can, missing) = loc.readiness(m);
            with_readiness(&mut st, can, missing);
        }
        st
    }

    /// 팩 하나를 조달한다 (FR-EXT-16·31·32). 같은 팩의 두 번째 요청은 거절된다.
    pub async fn install(&self, ctx: &Ctx, pack_id: &str) -> Outcome {
        let (ms, _) = self.manifests();
        let Some(m) = packs(&ms).into_iter().find(|c| c.id == pack_id) else {
            return fail(format!("{} 는 아는 플러그인이 아닙니다", quote(pack_id)));
        };
        let _guard = {
            let mut set = self.installing.lock().unwrap_or_else(|e| e.into_inner());
            if !set.insert(pack_id.to_owned()) {
                return fail(format!("{pack_id} 를 이미 받고 있습니다"));
            }
            InstallingGuard {
                set: &self.installing,
                id: pack_id.to_owned(),
            }
        };
        let r = Installer {
            look_path: Arc::clone(&self.look_path),
            fetch: Arc::clone(&self.fetch),
            exec: Arc::clone(&self.exec),
            ..Installer::new(&self.root)
        };
        r.install(ctx, &m, &runtimes(&ms)).await
    }
}

/// 없는 것을 사람의 말로 옮긴다 (FR-EXT-29). 옮기는 자리가 여기 하나인 것이 규칙이다.
pub fn missing_text(st: &Status) -> String {
    let Some(m) = &st.missing else {
        return String::new();
    };
    match m.kind.as_str() {
        MISSING_RUNTIME => format!("{} 가 필요합니다", m.name),
        MISSING_TOOL => format!(
            "{} 가 이 기계에 없어 받을 수 없습니다 — {} 를 먼저 설치하세요",
            m.name, m.name
        ),
        MISSING_TARGET => format!("이 플랫폼({})의 조달처가 선언에 없습니다", m.name),
        _ => "아직 받지 않았습니다".to_owned(),
    }
}
