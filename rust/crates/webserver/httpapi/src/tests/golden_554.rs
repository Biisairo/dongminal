//! Run 오케스트레이션(5.5.4·5.5.5) 종단을 go1.27.2 의 실제 핸들러가 낸 응답과 바이트 단위로
//! 대조한다. 기대값 `go_golden_554.json` 은 Go `New(...).Handler()` 에 같은 가짜(도구 허브·입출력·
//! 색인·명령 허브·workspace)와 시계·id 를 고정한 Run 저장소를 넣고 같은 요청을 차례로 보내 뽑았다.
//! 요청마다 방송(`pub`)·붙여넣기(`pastes`)·workspace rev 도 대조한다. 벽시계 값(`updatedAt`·
//! 봉투의 `ts=`)과 요청 ID 는 양쪽에서 가린다. `$OTTERMINAL_HOME` 은 `{HOME}` 이다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use otter_shared_pollwait::Signal;
use otter_webserver_domain_run::Store;
use otter_webserver_hub::{AttnTracker, CommandBroker, CommandHub};
use otter_webserver_seam_toolaccess::{
    Error, ToolInfo, ToolReader, WorkspaceEntry, WorkspaceReader,
};
use serde::Deserialize;

use super::fakes::{FakeBroker, FakeHub, FakeWork};
use super::support::*;
use crate::{Deps, Server};

/// 골든의 workspace (Go 생성기의 `g554WS`).
pub(crate) const WS: &str = r#"{"windows":[{"id":"win-1","layout":{"tabs":[{"id":"tab-a"},{"id":"tab-b"},{"id":"tab-c"},{"id":"tab-x"}]}}],"windowGroups":[{"id":"grp-1","tree":{"repo":"/repo","root":"1"}}]}"#;

/// 시험 시계 (Go `WithClock`).
pub(crate) const CLOCK: i64 = 1_700_000_000_000;

#[derive(Default)]
pub(crate) struct RunIo {
    pub(crate) has: Mutex<HashMap<String, bool>>,
    pub(crate) pastes: Mutex<Vec<(String, bool, String)>>,
}

impl RunIo {
    pub(crate) fn set_has(&self, id: &str, v: bool) {
        self.has.lock().unwrap().insert(id.to_owned(), v);
    }
}

impl ToolReader for RunIo {
    fn list(&self) -> Vec<ToolInfo> {
        Vec::new()
    }
    fn has(&self, id: &str) -> bool {
        self.has.lock().unwrap().get(id).copied().unwrap_or(false)
    }
    fn snapshot(&self, _: &str) -> Option<(Vec<u8>, i64)> {
        None
    }
    fn screen_text(&self, _: &str, _: usize) -> Option<String> {
        None
    }
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), Error> {
        self.pastes.lock().unwrap().push((
            id.to_owned(),
            submit,
            String::from_utf8_lossy(text).into_owned(),
        ));
        Ok(())
    }
    fn size(&self, _: &str) -> String {
        "80x24".to_owned()
    }
}

#[derive(Default)]
pub(crate) struct RunIndex {
    pub(crate) resolve: HashMap<String, String>,
    pub(crate) labels: HashMap<String, String>,
    pub(crate) entries: Mutex<Vec<WorkspaceEntry>>,
    pub(crate) sig: Signal,
}

impl WorkspaceReader for RunIndex {
    fn resolve(&self, id: &str) -> Result<String, Error> {
        self.resolve_strict(id)
    }
    fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        if let Some(v) = self.resolve.get(id) {
            return Ok(v.clone());
        }
        if self.labels.contains_key(&id.to_uppercase()) {
            return Err(Box::new(otter_shared_workspace::Error::LabelRejected(
                id.to_owned(),
            )));
        }
        Err(format!("not found: {id}").into())
    }
    fn entries(&self) -> Vec<WorkspaceEntry> {
        self.entries.lock().unwrap().clone()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
    }
    fn changes(&self) -> otter_shared_pollwait::Changed {
        self.sig.c()
    }
}

/// Go 생성기의 `g554Server` 와 같은 배선이다.
pub(crate) struct RunEnv {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) srv: Arc<Server>,
    pub(crate) hub: Arc<FakeHub>,
    pub(crate) io: Arc<RunIo>,
    pub(crate) idx: Arc<RunIndex>,
    pub(crate) cmds: Arc<FakeBroker>,
    pub(crate) ws: Arc<FakeWork>,
    pub(crate) store: Option<Arc<Store>>,
}

fn entry(tool: &str, tab: &str, win: &str) -> WorkspaceEntry {
    WorkspaceEntry {
        tool_id: tool.to_owned(),
        tab_uuid: tab.to_owned(),
        window_uuid: win.to_owned(),
        ..WorkspaceEntry::default()
    }
}

/// 고정 시계·순번 id 의 저장소다.
pub(crate) fn fixed_store(dir: &std::path::Path) -> Arc<Store> {
    std::fs::create_dir_all(dir).unwrap();
    let n = Arc::new(Mutex::new(0u32));
    let st = Store::new(dir).with_clock(|| CLOCK).with_id_gen(move || {
        let mut g = n.lock().unwrap();
        *g += 1;
        format!("{:08x}-1111-2222-3333-444444444444", *g)
    });
    st.load();
    Arc::new(st)
}

pub(crate) fn run_env(with_store: bool, f: impl FnOnce(&mut Deps)) -> RunEnv {
    run_env_with(with_store, f, |_| {})
}

/// `run_env` 에 서버 하나의 값(복구 판정기 같은 시험 자리)을 바꾸는 손을 더한다.
pub(crate) fn run_env_with(
    with_store: bool,
    f: impl FnOnce(&mut Deps),
    tweak: impl FnOnce(&mut Server),
) -> RunEnv {
    let dir = tempfile::tempdir().unwrap();
    let hub = Arc::new(FakeHub::default());
    let io = Arc::new(RunIo::default());
    let mut idx = RunIndex::default();
    idx.labels
        .insert("W1.P1.T1".to_owned(), "tool-a".to_owned());
    for id in ["tool-a", "tool-b", "tool-c", "tool-d", "tool-e", "tool-f"] {
        hub.seed(id, id);
        idx.resolve.insert(id.to_owned(), id.to_owned());
        if id != "tool-d" {
            io.set_has(id, true);
        }
    }
    for x in ["a", "b", "c", "e", "f"] {
        idx.resolve.insert(format!("tab-{x}"), format!("tool-{x}"));
    }
    *idx.entries.lock().unwrap() = vec![
        entry("tool-a", "tab-a", "win-1"),
        entry("tool-b", "tab-b", "win-1"),
        entry("tool-c", "tab-c", "win-1"),
        entry("tool-x", "tab-x", "win-1"),
        entry("tool-e", "tab-e", "win-2"),
        entry("tool-f", "tab-f", "win-2"),
    ];
    let idx = Arc::new(idx);
    let cmds = Arc::new(FakeBroker::default());
    let ws = Arc::new(FakeWork::with(WS, 1));
    let store = with_store.then(|| fixed_store(&dir.path().join("runs")));
    let tracker_hub: Arc<dyn CommandBroker> = CommandHub::new();
    let mut deps = Deps {
        tools: Some(hub.clone()),
        tool_io: Some(io.clone()),
        work_index: Some(idx.clone()),
        commands: Some(cmds.clone()),
        work: Some(ws.clone()),
        attn_tracker: Some(AttnTracker::new(tracker_hub, 0)),
        runs: store.clone(),
        ..Deps::default()
    };
    f(&mut deps);
    let cfg = crate::Config {
        data_dir: dir.path().join("data"),
        ..crate::Config::default()
    };
    let srv = Server::new_with(cfg, deps, tweak);
    RunEnv {
        _dir: dir,
        srv,
        hub,
        io,
        idx,
        cmds,
        ws,
        store,
    }
}

#[derive(Deserialize)]
struct Case {
    m: String,
    target: String,
    body: String,
    status: u16,
    headers: Option<Vec<String>>,
    resp: String,
    #[serde(rename = "pub")]
    published: Option<Vec<String>>,
    pastes: Option<Vec<String>>,
    rev: u64,
}

#[derive(Deserialize)]
struct Golden {
    http: Vec<Case>,
    ws: String,
}

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn mask(s: &str) -> String {
    let home = std::env::var(otter_shared_otterenv::ENV_HOME).unwrap_or_default();
    let mut s = s.to_owned();
    if !home.is_empty() {
        s = s.replace(&home, "{HOME}");
    }
    // 문서 경로의 홈은 서버의 데이터 디렉터리다 (issue_tree_doc_path).
    let doc = regex::Regex::new(r#"[^\s"\\]+/bin/agent-plugin/commands/issue-tree\.md"#).unwrap();
    s = doc
        .replace_all(&s, "{HOME}/bin/agent-plugin/commands/issue-tree.md")
        .into_owned();
    let re = regex::Regex::new(r#""updatedAt":[1-9][0-9]*"#).unwrap();
    let s = re.replace_all(&s, r#""updatedAt":N"#).into_owned();
    let ts = regex::Regex::new(r"ts=[0-9]{2}:[0-9]{2}:[0-9]{2}").unwrap();
    ts.replace_all(&s, "ts=T").into_owned()
}

fn headers(r: &Resp) -> Vec<String> {
    let mut hs: Vec<String> = r
        .headers
        .iter()
        .filter(|(k, _)| k.as_str() != "x-request-id" && k.as_str() != "date")
        .map(|(k, v)| format!("{}: {}", canon(k.as_str()), v.to_str().unwrap()))
        .collect();
    hs.sort();
    hs
}

async fn send(srv: &Arc<Server>, m: &str, target: &str, body: &str) -> Resp {
    let ct: &[(&str, &str)] = if m == "GET" {
        &[]
    } else {
        &[("Content-Type", "application/json")]
    };
    call(srv, m, target, ct, body, LOCAL).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn golden_554() {
    // OTTERMINAL_RENAME_SRS FR-REN-10: 정답 자료는 옛 이름으로 기록되어 있다.
    let golden = otter_shared_otterenv::legacy::current_names(include_str!("go_golden_554.json"));
    let g: Golden = otter_gocompat::json::unmarshal(golden.as_bytes()).unwrap();
    let env = run_env(true, |_| {});
    let none = run_env(false, |_| {});
    let n = g.http.len();
    for (i, c) in g.http.into_iter().enumerate() {
        // 마지막 셋은 저장소 없는 서버다.
        let srv = if i + 3 >= n { &none.srv } else { &env.srv };
        let r = send(srv, &c.m, &c.target, &c.body).await;
        let at = format!("#{i} {} {}", c.m, c.target);
        assert_eq!(r.status, c.status, "{at} 상태\n{}", r.body);
        // 좌표 라벨 거절의 문구는 Go 시험 가짜의 것이다 — 실물 문구는 5.5.2 골든이 대조한다.
        if !c.target.ends_with("/members") || !c.body.contains("W1.P1.T1") {
            assert_eq!(mask(&r.body), mask(&c.resp), "{at} 본문");
        }
        let want_h: Vec<String> = c
            .headers
            .unwrap_or_default()
            .into_iter()
            .filter(|h| !h.starts_with("X-Request-Id:"))
            .collect();
        assert_eq!(headers(&r), want_h, "{at} 헤더");
        if i + 3 >= n {
            continue;
        }
        let published = std::mem::take(&mut *env.cmds.published.lock().unwrap());
        let want_pub: Vec<String> = c
            .published
            .unwrap_or_default()
            .into_iter()
            .filter(|p| !super::full_topics::migrated(p))
            .collect();
        assert_eq!(published, want_pub, "{at} 방송");
        let pastes: Vec<String> = std::mem::take(&mut *env.io.pastes.lock().unwrap())
            .into_iter()
            .map(|(id, submit, text)| mask(&format!("{id}|{submit}|{text}")))
            .collect();
        let want_p: Vec<String> = c
            .pastes
            .unwrap_or_default()
            .iter()
            .map(|p| mask(p))
            .collect();
        assert_eq!(pastes, want_p, "{at} 붙여넣기");
        assert_eq!(*env.ws.rev.lock().unwrap(), c.rev, "{at} rev");
    }
    assert_eq!(
        String::from_utf8(env.ws.raw.lock().unwrap().clone()).unwrap(),
        g.ws,
        "workspace 표식"
    );
}
