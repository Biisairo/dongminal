//! Go `app_test.go`·`compose_test.go`·`bind_env_test.go`·`liveness_test.go`·`records_test.go`·
//! `report_wire_test.go`·`attention_wire_test.go`·`lsp_watch_test.go` 의 관측 단정이다.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_daemon_ipc::PanedServer;
use dm_gocompat::json::RawMessage;
use dm_shared_activity as activity;
use dm_shared_agentrec as agentrec;
use dm_shared_toolhub::{AgentState, Placement, ToolInfo, ToolManager};
use dm_shared_toolipc::{FEATURE_RECORDS, RECORD_USAGE, RecordsResult, ReportEvent, ToolRecords};
use dm_webserver_domain_git_core::{Ctx, Service as GitService};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use dm_webserver_domain_lsp::{NameStatus, RepoView};
use dm_webserver_httpapi::{AttentionDaemon, Deps};
use dm_webserver_hub::{AttnTracker, CmdResult, CmdSub, CommandBroker};
use dm_webserver_recordsync::Writer;
use dm_webserver_toolclient::{Error as ClientError, ToolClient};
use futures_util::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use super::attention::{DaemonAttention, ListOk, attn_live_probe, wire_daemon_attention};
use super::compose::{BuiltDeps, attach_sandbox, new_tool_adapters};
use super::lsp_watch::LspRepoView;
use super::records::{
    RecordClient, RecordMirror, new_record_writer, new_report_queue, record_sender, sync_records,
};
use super::{App, start_edge_scoped};

// ── app_test.go ──

// M8 D-A-12 (GO-16): 종료 순서는 표다. 이름의 순서를 잰다. 조립되지 않은 구성원은 건너뛴다 — 빈
// App 의 shutdown 이 패닉하지 않는다.
#[test]
fn shutdown_steps_order_is_the_contract() {
    let a = App::default();
    let names: Vec<&str> = a.shutdown_steps().iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "git 잡·쓰기 대기",
            "마커",
            "데몬 연결",
            "샌드박스",
            "LSP",
            "판 확인",
            "워크스페이스"
        ]
    );
    a.shutdown();
}

// REPO_FIX 01 §8: 종료의 첫 단계가 git 루트를 취소한다.
#[test]
fn shutdown_steps_cancels_git_root_first() {
    let called = Arc::new(AtomicBool::new(false));
    let c = called.clone();
    let a = App {
        cancel_git: Some(Arc::new(move || c.store(true, Ordering::SeqCst))),
        ..App::default()
    };
    let first = a.shutdown_steps().into_iter().next().unwrap();
    (first.run)();
    assert!(
        called.load(Ordering::SeqCst),
        "첫 단계가 git 루트를 취소하지 않았다"
    );
}

// C7: UI 서버가 종료 신호 없이 실패해도(포트 사용 중) 노드 포트를 닫고 기다린다.
#[tokio::test]
async fn start_edge_scoped_closes_without_cancel() {
    let stop_seen: Arc<Mutex<Option<CancellationToken>>> = Arc::default();
    let done = Arc::new(AtomicBool::new(false));
    let (s, d) = (stop_seen.clone(), done.clone());
    let ctx = CancellationToken::new();
    let close = start_edge_scoped(ctx.clone(), move |stop| {
        *s.lock().unwrap() = Some(stop.clone());
        tokio::spawn(async move {
            stop.cancelled().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            d.store(true, Ordering::SeqCst);
        })
    });
    close.await;
    let stop = stop_seen.lock().unwrap().clone().unwrap();
    assert!(stop.is_cancelled(), "노드 포트를 닫으라는 신호가 없다");
    assert!(done.load(Ordering::SeqCst), "닫기가 끝나기 전에 돌아왔다");
    assert!(!ctx.is_cancelled(), "바깥 문맥까지 끝냈다");
}

// ── compose_test.go ──

struct NoTools;

impl dm_webserver_seam_adapters::ToolSource for NoTools {
    fn list(&self) -> Vec<ToolInfo> {
        Vec::new()
    }
    fn has(&self, _: &str) -> bool {
        false
    }
    fn snapshot_tool(
        &self,
        _: &str,
    ) -> Result<dm_shared_toolhub::ToolSnapshot, dm_webserver_seam_toolaccess::Error> {
        Err("없다".into())
    }
    fn send_paste(
        &self,
        _: &str,
        _: &[u8],
        _: bool,
    ) -> Result<(), dm_webserver_seam_toolaccess::Error> {
        Ok(())
    }
}

// FR-DMR-12: 어댑터 둘은 같은 허브를 싣는다.
#[test]
fn new_tool_adapters_use_hub() {
    let h: Arc<dyn dm_webserver_seam_adapters::ToolSource> = Arc::new(NoTools);
    let (pa, rc) = new_tool_adapters(h.clone());
    assert!(Arc::ptr_eq(pa.hub.as_ref().unwrap(), &h));
    assert!(Arc::ptr_eq(rc.hub.as_ref().unwrap(), &h));
}

// 런타임이 없으면(placer 없음) 샌드박스를 싣지도 회수하지도 않는다.
#[test]
fn attach_sandbox_none_is_noop() {
    let mut bd = BuiltDeps::default();
    attach_sandbox(&mut bd, None);
    assert!(bd.deps.sandbox.is_none());
    assert!(bd.sandbox.is_none());
}

// FR-SBX-9: 해석할 수 없는 workspace 는 "판단 근거 없음"(None)이고, 창이 없는 workspace 는 빈 목록이다.
#[test]
fn live_window_uuids_keeps_unknown_apart_from_empty() {
    use super::compose::live_window_uuids;
    assert_eq!(live_window_uuids(None), None);
    assert_eq!(live_window_uuids(Some(Vec::new())), Some(Vec::new()));
}

// ── bind_env_test.go (TC-HRB-4) ──

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_sources(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs")
            && p.file_name().is_none_or(|n| n != "tests.rs")
        {
            out.push(p);
        }
    }
}

// FR-HRB-11: 서버는 자기 바인드를 환경변수에 넣지 않는다. Rust 는 프로세스 환경을 아예 바꾸지 않는다.
#[test]
fn server_sets_no_env() {
    let mut files = Vec::new();
    rust_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(files.len() >= 5, "훑은 파일이 {} 개뿐이다", files.len());
    for f in files {
        let src = std::fs::read_to_string(&f).unwrap();
        assert!(
            !src.contains("set_var("),
            "{}: 프로세스 환경을 바꾼다",
            f.display()
        );
    }
}

// ── liveness_test.go (TC-ARD-1) ──

struct Lister(Option<Vec<ToolInfo>>);

impl ListOk for Lister {
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        self.0.clone()
    }
}

// FR-ARD-2: 알람 생존 검사는 확인된 죽음만 거른다.
#[test]
fn attn_live_probe_filters_confirmed_death_only() {
    let known = attn_live_probe(Arc::new(Lister(Some(vec![ToolInfo {
        id: "a".into(),
        ..ToolInfo::default()
    }]))));
    assert!(known("a"), "목록에 있는 도구를 걸렀다");
    assert!(!known("b"), "확인된 죽음을 거르지 않았다");
    let unknown = attn_live_probe(Arc::new(Lister(None)));
    assert!(
        unknown("a") && unknown("b"),
        "생존을 모르는데 알람을 걸렀다"
    );
}

// ── records_test.go ──

#[derive(Default)]
struct FakeRecordClient {
    features: bool,
    log: Mutex<Vec<String>>,
}

impl RecordClient for FakeRecordClient {
    fn has_feature(&self, name: &str) -> bool {
        self.features && name == FEATURE_RECORDS
    }
    fn record_set(&self, kind: &str, tool: &str, _: RawMessage) -> Result<(), ClientError> {
        self.log.lock().unwrap().push(format!("set {kind}/{tool}"));
        Ok(())
    }
    fn records(&self) -> Result<RecordsResult, ClientError> {
        self.log.lock().unwrap().push("records".into());
        Ok(RecordsResult {
            tools: Some(vec![ToolRecords {
                tool: "t1".into(),
                ..ToolRecords::default()
            }]),
            ..RecordsResult::default()
        })
    }
}

#[derive(Default)]
struct FakeMirror(Mutex<Vec<RecordsResult>>);

impl RecordMirror for FakeMirror {
    fn apply_records(&self, res: &RecordsResult) {
        self.0.lock().unwrap().push(res.clone());
    }
}

// FR-ARD-13: 다시 붙으면 남은 쓰기를 먼저 보내고, 그 뒤에 스냅샷을 받는다.
#[test]
fn sync_records_flush_then_snapshot() {
    let c = Arc::new(FakeRecordClient {
        features: true,
        ..Default::default()
    });
    let w = Writer::new(record_sender(c.clone()));
    w.put(RECORD_USAGE, "t1", &1);
    let m = FakeMirror::default();
    sync_records(&*c, &w, &m);
    assert_eq!(*c.log.lock().unwrap(), ["set usage/t1", "records"]);
    let applied = m.0.lock().unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].tools.as_ref().unwrap()[0].tool, "t1");
}

// TC-ARD-12: records 를 말하지 않는 데몬에는 쓰지도 묻지도 않는다.
#[test]
fn sync_records_old_daemon() {
    let c = Arc::new(FakeRecordClient::default());
    let w = Writer::new(record_sender(c.clone()));
    w.put(RECORD_USAGE, "t1", &1);
    let m = FakeMirror::default();
    sync_records(&*c, &w, &m);
    assert!(c.log.lock().unwrap().is_empty());
    assert!(m.0.lock().unwrap().is_empty());
}

// ── report_wire_test.go ──

// §3.2a: report push 는 읽기 루프 밖에서, 받은 순서대로 처리한다.
#[test]
fn report_queue_in_order_off_loop() {
    let (got_tx, got_rx) = std::sync::mpsc::channel::<String>();
    let (rel_tx, rel_rx) = std::sync::mpsc::channel::<()>();
    let rel_rx = Mutex::new(rel_rx);
    let push = new_report_queue(move |method: &str, _: &[u8]| {
        let _ = rel_rx.lock().unwrap().recv();
        got_tx.send(method.to_owned()).unwrap();
    });
    let start = Instant::now();
    for m in ["a", "b"] {
        push(ReportEvent {
            method: m.into(),
            ..ReportEvent::default()
        });
    }
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "처리가 끝날 때까지 push 가 막혔다"
    );
    drop(rel_tx);
    for want in ["a", "b"] {
        assert_eq!(got_rx.recv_timeout(Duration::from_secs(2)).unwrap(), want);
    }
}

// ── 실제 데몬·클라이언트 리그 (attention_wire_test.go·records_test.go·report_wire_test.go) ──

/// 방송된 SSE 를 모은다. 알람 방송 수도 센다.
#[derive(Default)]
struct SseLog {
    sent: Mutex<Vec<String>>,
    attention: AtomicUsize,
}

impl SseLog {
    /// subs 를 모두 담은 방송이 올 때까지 기다린다.
    fn wait_for(&self, subs: &[&str]) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            {
                let mut sent = self.sent.lock().unwrap();
                if sent.iter().any(|p| subs.iter().all(|s| p.contains(s))) {
                    sent.clear();
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!(
            "{subs:?} 방송이 오지 않았다. 받은 것={:?}",
            self.sent.lock().unwrap()
        );
    }
}

impl CommandBroker for SseLog {
    fn add(&self) -> Option<Arc<CmdSub>> {
        Some(CmdSub::new())
    }
    fn remove(&self, s: &Arc<CmdSub>) {
        s.close();
    }
    fn broadcast(&self, payload: &[u8]) -> usize {
        let p = String::from_utf8_lossy(payload).into_owned();
        if p.contains(r#""action":"tool_attention""#) {
            self.attention.fetch_add(1, Ordering::SeqCst);
        }
        self.sent.lock().unwrap().push(p);
        1
    }
    fn broadcast_and_await<'a>(
        &'a self,
        _: &'a [u8],
        _: &'a str,
        _: Duration,
    ) -> BoxFuture<'a, (CmdResult, usize, bool)> {
        Box::pin(async { (CmdResult::default(), 0, false) })
    }
    fn deliver_result(&self, _: &str, _: CmdResult) {}
}

struct Rig {
    closed: Arc<AtomicBool>,
    pm: Arc<ToolManager>,
    srv: PanedServer,
    sock: PathBuf,
    report: PathBuf,
    _dir: tempfile::TempDir,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.pm.delete("t1");
        self.pm.stop_saving();
        self.srv.close();
    }
}

/// 데몬 하나를 임시 폴더에 띄운다. 유닉스 소켓 경로 상한(104 바이트) 때문에 짧은 이름을 쓴다.
fn rig() -> Rig {
    let dir = tempfile::Builder::new().prefix("dm").tempdir().unwrap();
    let data = dir.path().join("d");
    std::fs::create_dir_all(&data).unwrap();
    let pm = Arc::new(ToolManager::new(data.to_str().unwrap(), None));
    let sock = dir.path().join("s");
    let report = dir.path().join(agentrec::SOCKET_FILE);
    let srv = PanedServer::new(pm.clone(), &sock, None);
    // 알람 갈고리는 서버가 선 뒤에 단다 — 그 전에 들인 도구는 판정 결과를 push 하지 않는다.
    pm.adopt_detached("t1");
    srv.listen().unwrap();
    srv.listen_reports(&report).unwrap();
    let closed = Arc::new(AtomicBool::new(false));
    let (s, stop) = (srv.clone(), closed.clone());
    // accept 는 연결 하나가 끝날 때마다 돌아온다. 리그가 닫힐 때까지 다시 받는다.
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            let _ = s.accept();
        }
    });
    let s = srv.clone();
    std::thread::spawn(move || s.serve_reports());
    Rig {
        closed,
        pm,
        srv,
        sock,
        report,
        _dir: dir,
    }
}

/// 보고 소켓에 한 건을 보내고 ok 답을 확인한다.
fn report(path: &Path, method: &str, body: &str) {
    let mut c = dm_shared_platform::current()
        .ipc
        .dial(path, Duration::from_secs(1))
        .unwrap();
    c.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    writeln!(c, r#"{{"method":"{method}","body":{body}}}"#).unwrap();
    let mut line = String::new();
    BufReader::new(&mut c).read_line(&mut line).unwrap();
    assert!(line.contains(r#""ok":true"#), "reply={line}");
}

struct AttnRig {
    rig: Rig,
    c: Arc<ToolClient>,
    tr: Arc<AttnTracker>,
    sse: Arc<SseLog>,
    d: DaemonAttention<ToolClient>,
}

fn attn_rig() -> AttnRig {
    let rig = rig();
    let c = Arc::new(ToolClient::dial(&rig.sock).unwrap());
    let sse = Arc::new(SseLog::default());
    let tr = AttnTracker::new(sse.clone(), 0);
    let d = wire_daemon_attention(&c, &tr);
    c.set_on_report(Some(Arc::new(|_| {})));
    AttnRig { rig, c, tr, sse, d }
}

// TC-ARD-30: 판정은 데몬 Tool 이 하고, 서버는 그 결과를 방송한다.
#[tokio::test(flavor = "multi_thread")]
async fn attention_wire_daemon_judges_server_broadcasts() {
    let r = attn_rig();
    assert!(r.d.judges(), "새 데몬인데 판정을 넘기지 않았다");
    let p = r.rig.pm.get("t1").unwrap();

    // 출력의 알림 시퀀스 — 데몬 Tool 이 판정한다.
    p.observe_output(b"\x1b]9;hi\x07");
    r.sse
        .wait_for(&[r#""action":"tool_attention""#, r#""reason":"signaled""#]);
    assert!(r.tr.attention("t1"), "거울에 알람이 없다");

    // 보기만 한 해제 — 데몬에 보내고 그 결과가 방송된다.
    r.d.attend("t1", false).unwrap();
    r.sse.wait_for(&["\"tool_attention_clear\""]);
    assert!(
        !p.attention() && !r.tr.attention("t1"),
        "해제가 데몬·거울에 닿지 않았다"
    );

    // 보고 소켓의 사용자 턴 done — 사유 done 으로 운다.
    report(
        &r.rig.report,
        agentrec::METHOD_ACTIVITY,
        r#"{"toolId":"t1","agent":"claude","state":"working","tool":"Bash"}"#,
    );
    r.sse
        .wait_for(&["\"tool_activity\"", r#""state":"working""#]);
    report(
        &r.rig.report,
        agentrec::METHOD_ACTIVITY,
        r#"{"toolId":"t1","agent":"claude","state":"done"}"#,
    );
    r.sse
        .wait_for(&[r#""action":"tool_attention""#, r#""reason":"done""#]);
    let a = r.tr.activity("t1");
    assert!(
        a.as_ref().is_some_and(|a| a.state == activity::DONE) && r.tr.attention("t1"),
        "거울={a:?}"
    );
    assert_eq!(r.d.attend_all().unwrap(), 1);
    r.sse.wait_for(&["\"tool_attention_clear\""]);
}

// 서버의 추적기는 판정하지 않는다 — 출력의 알림 시퀀스를 서버가 따로 보아도 울지 않는다.
#[tokio::test(flavor = "multi_thread")]
async fn attention_wire_server_does_not_judge() {
    let r = attn_rig();
    r.tr.feed_output("t1", b"\x1b]9;hi\x07");
    assert!(!r.tr.attention("t1"), "거울이 출력으로 판정했다");
}

// UX_BATCH6_SRS FR-BGP-2 · FR-ATL-3: 데몬이 도구의 죽음을 알리면 서버는 그 도구의 주의를 버리고
// 백그라운드 목록을 다시 묻게 방송한다.
#[tokio::test(flavor = "multi_thread")]
async fn daemon_pushes_exit_forgets_and_broadcasts_background() {
    let r = attn_rig();
    let a = App {
        client: Some(r.c.clone()),
        bd: BuiltDeps {
            attn_tracker: Some(r.tr.clone()),
            deps: Deps {
                commands: Some(r.sse.clone()),
                ..Deps::default()
            },
            ..BuiltDeps::default()
        },
        ..App::default()
    };
    a.wire_daemon_pushes();
    let cwd = tempfile::tempdir().unwrap();
    let tool = match r
        .c
        .create(cwd.path().to_str().unwrap(), 80, 24, &Placement::default())
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("PTY 생성 불가(환경): {e}");
            return;
        }
    };
    r.rig
        .pm
        .get(&tool.id)
        .unwrap()
        .observe_output(b"\x1b]9;hi\x07");
    r.sse.wait_for(&[r#""action":"tool_attention""#]);
    assert!(r.tr.attention(&tool.id), "거울에 알람이 없다");
    r.c.delete(&tool.id).unwrap();
    r.sse.wait_for(&["\"tools_background_changed\""]);
    assert!(
        !r.tr.attention(&tool.id),
        "죽은 도구의 알람이 거울에 남았다"
    );
}

/// 스냅샷을 추적기에 되살리는 거울이다 (Go `trackerMirror`).
struct TrackerMirror(Arc<AttnTracker>);

impl RecordMirror for TrackerMirror {
    fn apply_records(&self, res: &RecordsResult) {
        let states: HashMap<String, AgentState> = res
            .tools
            .iter()
            .flatten()
            .map(|t| (t.tool.clone(), t.agent.clone()))
            .collect();
        self.0.restore_all(&states);
    }
}

// TC-ARD-11: 서버가 쓴 기록이 서버를 넘어 남는다. 새 서버는 붙을 때 스냅샷으로 같은 상태를 얻고,
// 그 반영은 알람을 방송하지 않는다.
#[tokio::test(flavor = "multi_thread")]
async fn records_new_server_sees_old_server_state() {
    let rig = rig();
    let c1 = Arc::new(ToolClient::dial(&rig.sock).unwrap());
    let tr1 = AttnTracker::new(Arc::new(SseLog::default()), 0);
    let w1 = new_record_writer(c1.clone(), &tr1);
    tr1.set_activity("t1", activity::WORKING, "Bash", "ls");
    tr1.signal_attention("t1", activity::WAITING);
    w1.flush();
    c1.close();

    let c2 = Arc::new(ToolClient::dial(&rig.sock).unwrap());
    let fb = Arc::new(SseLog::default());
    let tr2 = AttnTracker::new(fb.clone(), 0);
    let w2 = new_record_writer(c2.clone(), &tr2);
    sync_records(&*c2, &w2, &TrackerMirror(tr2.clone()));

    let (mut got, mut want) = (tr2.agent_state_of("t1"), tr1.agent_state_of("t1"));
    got.last_output_at = 0;
    want.last_output_at = 0;
    assert_eq!(
        dm_gocompat::json::marshal(&got).unwrap(),
        dm_gocompat::json::marshal(&want).unwrap(),
        "새 서버의 거울"
    );
    assert_eq!(
        fb.attention.load(Ordering::SeqCst),
        0,
        "스냅샷 반영이 알람을 방송했다"
    );
    c2.close();
}

// TC-ARD-22: 서버 없이 보고 소켓에 온 보고가, 나중에 붙은 서버의 스냅샷에 실린다 (FR-ARD-25).
#[tokio::test(flavor = "multi_thread")]
async fn report_no_server_then_snapshot() {
    let rig = rig();
    for body in [
        r#"{"toolId":"t1","agent":"claude","state":"working","tool":"Bash"}"#,
        r#"{"toolId":"t1","agent":"claude","state":"done"}"#,
    ] {
        report(&rig.report, agentrec::METHOD_ACTIVITY, body);
    }
    let c = Arc::new(ToolClient::dial(&rig.sock).unwrap());
    let fb = Arc::new(SseLog::default());
    let tr = AttnTracker::new(fb.clone(), 0);
    let w = new_record_writer(c.clone(), &tr);
    sync_records(&*c, &w, &TrackerMirror(tr.clone()));
    let st = tr.agent_state_of("t1");
    assert!(
        st.activity
            .as_ref()
            .is_some_and(|a| a.state == activity::DONE)
            && st.attention,
        "새 서버의 거울={st:?} — 서버가 꺼진 동안 끝난 턴이 done·알람으로 보여야 한다"
    );
    assert_eq!(
        fb.attention.load(Ordering::SeqCst),
        0,
        "스냅샷 반영이 알람을 방송했다 (FR-ARD-25)"
    );
    c.close();
}

// ── lsp_watch_test.go ──

// §11.6 W: 관측의 HEAD·작업 트리 변경(새 파일인가)과, 두 커밋 사이의 name-status.
#[tokio::test(flavor = "multi_thread")]
async fn lsp_repo_view_snapshot_and_name_status() {
    let Some(r) = dm_shared_gittest::init() else {
        eprintln!("git 없음 — 건너뛴다");
        return;
    };
    let repo = r.path().to_path_buf();
    let write = |rel: &str, s: &str| std::fs::write(repo.join(rel), s).unwrap();
    let git = |args: &[&str]| dm_shared_gittest::run(&repo, args);
    write("a.go", "package a\n");
    write("b.go", "package a\n\n// b 는 지워진다.\nfunc B() {}\n");
    write(
        "r.go",
        "package a\n\n// r 은 이름이 바뀐다.\nfunc R() int { return 42 }\n",
    );
    git(&["add", "."]);
    git(&["commit", "-qm", "1"]);
    let c1 = git(&["rev-parse", "HEAD"]);
    git(&["rm", "-q", "b.go"]);
    git(&["mv", "r.go", "r2.go"]);
    write("c.go", "package a\n\nvar c = map[string]int{\"zz\": 9}\n");
    git(&["add", "."]);
    git(&["commit", "-qm", "2"]);
    let c2 = git(&["rev-parse", "HEAD"]);
    write("a.go", "package a\n\nvar x = 1\n");
    write("u.go", "package a\n");
    write("s.go", "package a\n");
    git(&["add", "s.go"]);

    let st = Store::new(Arc::new(GitService::new()), StoreOptions::default());
    let v = Arc::new(LspRepoView { st: st.clone() });
    let repo_s = repo.to_str().unwrap().to_owned();
    assert!(v.snapshot(&repo_s).is_none(), "관측 전인데 스냅숏이 있다");
    let (res, _) = st.status(&Ctx::background(), &repo_s).await;
    res.unwrap();
    let snap = v.snapshot(&repo_s).expect("관측 뒤 스냅숏이 없다");
    assert_eq!(snap.head, c2);
    assert_eq!(
        snap.files,
        BTreeMap::from([
            ("a.go".to_owned(), false),
            ("u.go".to_owned(), true),
            ("s.go".to_owned(), true),
        ])
    );
    let (vv, rr, a, b) = (v.clone(), repo_s.clone(), c1.clone(), c2.clone());
    let ns = tokio::task::spawn_blocking(move || vv.name_status(&rr, &a, &b))
        .await
        .unwrap()
        .unwrap();
    let ns_of = |s: &str, p: &str, o: &str| NameStatus {
        status: s.into(),
        path: p.into(),
        orig_path: o.into(),
    };
    assert_eq!(
        ns,
        [
            ns_of("D", "b.go", ""),
            ns_of("A", "c.go", ""),
            ns_of("R", "r2.go", "r.go")
        ]
    );
    let (vv, rr) = (v.clone(), repo_s.clone());
    let bad = tokio::task::spawn_blocking(move || vv.name_status(&rr, &c1, "nope"))
        .await
        .unwrap();
    assert!(bad.is_err(), "없는 커밋인데 오류가 없다");
}
