use std::collections::BTreeMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::*;
use crate::codec::read_frame;
use crate::service::Tunnel;
use crate::watch::{
    DEFAULT_WATCH_MAX, FileEvent, FileNotifier, NameStatus, RepoSnap, RepoView, RepoWatch,
    WATCH_CHANGED, WATCH_CREATED, WATCH_DELETED, repo_events,
};

#[derive(Deserialize, Default)]
#[serde(default)]
struct Change {
    uri: String,
    #[serde(rename = "type")]
    typ: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Params {
    changes: Vec<Change>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Msg {
    method: String,
    params: Params,
}

fn read_msg(e: &mut PipeEnd) -> Msg {
    let b = read_frame(&mut e.input).unwrap();
    otter_gocompat::json::unmarshal(&b).unwrap()
}

fn uri(p: &str) -> String {
    otter_shared_platform::current().paths.file_uri(p)
}

fn uris(m: &Msg) -> Vec<String> {
    m.params.changes.iter().map(|c| c.uri.clone()).collect()
}

fn ev(p: &str, typ: i64) -> FileEvent {
    FileEvent {
        path: p.to_owned(),
        typ,
    }
}

const INITIALIZED: &[u8] = br#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#;

fn open_ready(
    svc: &Service,
    ends: &std::sync::mpsc::Receiver<PipeEnd>,
    root: &str,
) -> (Arc<dyn Tunnel>, PipeEnd) {
    let tn = svc.open_tunnel(root, "gopls/gopls").unwrap();
    let mut e = next_end(ends);
    tn.send(INITIALIZED).unwrap();
    assert_eq!(read_msg(&mut e).method, "initialized");
    (tn, e)
}

#[test]
fn only_after_initialized() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let (_t, root) = tmp();
    let tn = svc.open_tunnel(&root, "gopls/gopls").unwrap();
    let mut e = next_end(&ends);
    let a = filepath::join(&[root.as_str(), "a.go"]);
    svc.notify_files(&[ev(&a, WATCH_CHANGED)]); // initialized 전 — 버린다
    tn.send(INITIALIZED).unwrap();
    svc.notify_files(&[ev(&a, WATCH_CREATED)]);
    assert_eq!(read_msg(&mut e).method, "initialized");
    let m = read_msg(&mut e);
    assert_eq!(m.method, "workspace/didChangeWatchedFiles");
    assert_eq!(m.params.changes.len(), 1);
    assert_eq!(
        (m.params.changes[0].uri.clone(), m.params.changes[0].typ),
        (uri(&a), WATCH_CREATED)
    );
    svc.shutdown();
}

#[test]
fn only_paths_under_each_root() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let (_t, base) = tmp();
    let (ra, rb) = (
        filepath::join(&[base.as_str(), "a"]),
        filepath::join(&[base.as_str(), "b"]),
    );
    let (_ta, mut ea) = open_ready(&svc, &ends, &ra);
    let (_tb, mut eb) = open_ready(&svc, &ends, &rb);
    let pa = filepath::join(&[ra.as_str(), "x.go"]);
    let pb = filepath::join(&[rb.as_str(), "y.go"]);
    let sib = filepath::join(&[base.as_str(), "ab", "z.go"]);
    svc.notify_files(&[
        ev(&pa, WATCH_CHANGED),
        ev(&pb, WATCH_DELETED),
        ev(&sib, WATCH_CHANGED),
    ]);
    assert_eq!(uris(&read_msg(&mut ea)), [uri(&pa)]);
    let mb = read_msg(&mut eb);
    assert_eq!(uris(&mb), [uri(&pb)]);
    assert_eq!(mb.params.changes[0].typ, WATCH_DELETED);
    svc.shutdown();
}

#[test]
fn nothing_under_root_sends_nothing() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let (_t, root) = tmp();
    let (tn, mut e) = open_ready(&svc, &ends, &root);
    let (_o, other) = tmp();
    svc.notify_files(&[ev(
        &filepath::join(&[other.as_str(), "o.go"]),
        WATCH_CHANGED,
    )]);
    svc.notify_files(&[]);
    tn.send(br#"{"jsonrpc":"2.0","method":"ping"}"#).unwrap();
    assert_eq!(read_msg(&mut e).method, "ping", "빈 끼워 넣기가 나갔다");
    svc.shutdown();
}

#[test]
fn stuck_tunnel_does_not_block_others() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let (_t, base) = tmp();
    let (ra, rb) = (
        filepath::join(&[base.as_str(), "a"]),
        filepath::join(&[base.as_str(), "b"]),
    );
    let _stuck = open_ready(&svc, &ends, &ra); // 이 서버는 더 읽지 않는다
    let (_tb, mut eb) = open_ready(&svc, &ends, &rb);
    let svc = Arc::new(svc);
    let s2 = Arc::clone(&svc);
    let (ra2, rb2) = (ra.clone(), rb.clone());
    let h = thread::spawn(move || {
        for n in ["1.go", "2.go", "3.go"] {
            s2.notify_files(&[
                ev(&filepath::join(&[ra2.as_str(), n]), WATCH_CHANGED),
                ev(&filepath::join(&[rb2.as_str(), n]), WATCH_CHANGED),
            ]);
        }
    });
    let t0 = std::time::Instant::now();
    h.join().unwrap();
    assert!(t0.elapsed() < WAIT, "NotifyFiles 가 막힌 통로를 기다렸다");
    for n in ["1.go", "2.go", "3.go"] {
        assert_eq!(
            uris(&read_msg(&mut eb)),
            [uri(&filepath::join(&[rb.as_str(), n]))]
        );
    }
    svc.shutdown();
}

#[test]
fn caps_at_watch_max() {
    let (start, ends, _) = pipe_starter();
    let (_d, mut svc) = go_tunnel_svc(start);
    svc.watch_max = 3;
    let (_t, root) = tmp();
    let (_tn, mut e) = open_ready(&svc, &ends, &root);
    let paths: Vec<String> = (1..=5)
        .map(|i| filepath::join(&[root.as_str(), &format!("{i}.go")]))
        .collect();
    let evs: Vec<FileEvent> = paths.iter().map(|p| ev(p, WATCH_CHANGED)).collect();
    svc.notify_files(&evs);
    let want: Vec<String> = paths[..3].iter().map(|p| uri(p)).collect();
    assert_eq!(uris(&read_msg(&mut e)), want);
    svc.shutdown();
}

#[test]
fn default_watch_max() {
    assert_eq!(DEFAULT_WATCH_MAX, 2000);
}

#[test]
fn no_touch_and_nothing_to_browser() {
    let (start, ends, _) = pipe_starter();
    let (_d, mut svc) = go_tunnel_svc(start);
    let now = Arc::new(Mutex::new(UNIX_EPOCH + Duration::from_secs(1000)));
    let c = Arc::clone(&now);
    svc.now = Some(Arc::new(move || -> SystemTime { *c.lock().unwrap() }));
    let (_t, root) = tmp();
    let (tn, mut e) = open_ready(&svc, &ends, &root);
    let before = tn.last_use();
    *now.lock().unwrap() += Duration::from_secs(3600);
    svc.notify_files(&[ev(&filepath::join(&[root.as_str(), "a.go"]), WATCH_CHANGED)]);
    read_msg(&mut e);
    assert_eq!(tn.last_use(), before, "끼워 넣기가 LastUse 를 옮겼다");
    let back = br#"{"jsonrpc":"2.0","method":"from-server"}"#;
    e.write_frame(back);
    assert_eq!(tn.recv().unwrap(), back);
    svc.shutdown();
}

fn exists(set: &[String]) -> impl Fn(&str) -> bool + use<> {
    let set = set.to_vec();
    move |p| set.iter().any(|s| s == p)
}

fn ns(status: &str, path: &str, orig: &str) -> NameStatus {
    NameStatus {
        status: status.into(),
        path: path.into(),
        orig_path: orig.into(),
    }
}

fn snap(head: &str, files: &[(&str, bool)]) -> RepoSnap {
    RepoSnap {
        head: head.into(),
        files: files
            .iter()
            .map(|(k, v)| ((*k).to_owned(), *v))
            .collect::<BTreeMap<_, _>>(),
    }
}

#[test]
fn repo_events_head_move() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, filepath::from_slash(rel).as_str()]);
    let list = [
        ns("A", "new.go", ""),
        ns("D", "old.go", ""),
        ns("M", "pkg/mod.go", ""),
        ns("R", "b.go", "a.go"),
    ];
    let ex = exists(&[at("new.go"), at("pkg/mod.go"), at("b.go")]);
    let got = repo_events(repo, Some(&snap("h1", &[])), &snap("h2", &[]), &list, &ex);
    let want = vec![
        ev(&at("a.go"), WATCH_DELETED),
        ev(&at("b.go"), WATCH_CREATED),
        ev(&at("new.go"), WATCH_CREATED),
        ev(&at("old.go"), WATCH_DELETED),
        ev(&at("pkg/mod.go"), WATCH_CHANGED),
    ];
    assert_eq!(got, want);
}

#[test]
fn repo_events_worktree_union() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, rel]);
    let prev = snap("h", &[("x.go", false), ("reverted.go", false)]);
    let cur = snap("h", &[("x.go", false), ("u.go", true), ("gone.go", false)]);
    let ex = exists(&[at("x.go"), at("u.go"), at("reverted.go")]);
    let got = repo_events(repo, Some(&prev), &cur, &[], &ex);
    let want = vec![
        ev(&at("gone.go"), WATCH_DELETED),
        ev(&at("reverted.go"), WATCH_CHANGED),
        ev(&at("u.go"), WATCH_CREATED),
        ev(&at("x.go"), WATCH_CHANGED),
    ];
    assert_eq!(got, want);
}

#[test]
fn repo_events_first_snapshot_and_dedupe() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, rel]);
    let ex = exists(&[at("n.go")]);
    assert_eq!(
        repo_events(repo, None, &snap("h", &[("n.go", true)]), &[], &ex),
        [ev(&at("n.go"), WATCH_CREATED)]
    );
    let got = repo_events(
        repo,
        Some(&snap("h0", &[("n.go", false)])),
        &snap("h1", &[("n.go", false)]),
        &[ns("A", "n.go", "")],
        &ex,
    );
    assert_eq!(got, [ev(&at("n.go"), WATCH_CREATED)]);
    assert!(
        repo_events(
            repo,
            Some(&snap("h", &[])),
            &snap("h", &[]),
            &[],
            &exists(&[])
        )
        .is_empty()
    );
}

#[derive(Default)]
struct FakeView {
    snaps: Mutex<HashMap<String, RepoSnap>>,
    ns: Mutex<Vec<NameStatus>>,
    ns_err: Mutex<Option<String>>,
    asked: Mutex<Vec<(String, String)>>,
}

impl RepoView for FakeView {
    fn snapshot(&self, repo: &str) -> Option<RepoSnap> {
        self.snaps.lock().unwrap().get(repo).cloned()
    }
    fn name_status(&self, _: &str, from: &str, to: &str) -> Result<Vec<NameStatus>, String> {
        self.asked.lock().unwrap().push((from.into(), to.into()));
        match self.ns_err.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(self.ns.lock().unwrap().clone()),
        }
    }
}

#[derive(Default)]
struct FakeOut(Mutex<Vec<Vec<FileEvent>>>);

impl FileNotifier for FakeOut {
    fn notify_files(&self, e: &[FileEvent]) {
        self.0.lock().unwrap().push(e.to_vec());
    }
}

fn watch(v: &Arc<FakeView>, out: &Arc<FakeOut>, ex: Vec<String>) -> RepoWatch {
    let mut w = RepoWatch::new(v.clone(), out.clone());
    let f = exists(&ex);
    w.exists = Some(Arc::new(f));
    w
}

fn put(v: &FakeView, repo: &str, s: RepoSnap) {
    v.snaps.lock().unwrap().insert(repo.into(), s);
}

#[test]
fn repo_watch_remembers_and_asks_only_on_head_move() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, rel]);
    let v = Arc::new(FakeView::default());
    let out = Arc::new(FakeOut::default());
    put(&v, repo, snap("h1", &[("a.go", false)]));
    let mut w = watch(&v, &out, vec![at("a.go"), at("b.go")]);
    w.changed(repo);
    assert!(v.asked.lock().unwrap().is_empty(), "첫 관측에 물었다");
    assert_eq!(out.0.lock().unwrap()[0], [ev(&at("a.go"), WATCH_CHANGED)]);
    put(&v, repo, snap("h1", &[("b.go", true)]));
    w.changed(repo);
    assert!(
        v.asked.lock().unwrap().is_empty(),
        "HEAD 가 그대로인데 물었다"
    );
    assert_eq!(
        out.0.lock().unwrap()[1],
        [
            ev(&at("a.go"), WATCH_CHANGED),
            ev(&at("b.go"), WATCH_CREATED)
        ]
    );
    put(&v, repo, snap("h2", &[]));
    *v.ns.lock().unwrap() = vec![ns("M", "c.go", "")];
    let f = exists(&[at("b.go"), at("c.go")]);
    w.exists = Some(Arc::new(f));
    w.changed(repo);
    assert_eq!(
        *v.asked.lock().unwrap(),
        [("h1".to_owned(), "h2".to_owned())]
    );
    assert_eq!(
        out.0.lock().unwrap()[2],
        [
            ev(&at("b.go"), WATCH_CHANGED),
            ev(&at("c.go"), WATCH_CHANGED)
        ]
    );
}

#[test]
fn repo_watch_no_snapshot_or_nothing_changed() {
    let v = Arc::new(FakeView::default());
    let out = Arc::new(FakeOut::default());
    let w = watch(&v, &out, vec![]);
    w.changed("/r");
    put(&v, "/r", snap("h", &[]));
    w.changed("/r");
    assert!(out.0.lock().unwrap().is_empty());
}

#[test]
fn repo_watch_name_status_error_still_sends_worktree() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, rel]);
    let v = Arc::new(FakeView::default());
    let out = Arc::new(FakeOut::default());
    put(&v, repo, snap("h1", &[]));
    let w = watch(&v, &out, vec![at("w.go")]);
    w.changed(repo);
    put(&v, repo, snap("h2", &[("w.go", false)]));
    *v.ns_err.lock().unwrap() = Some("boom".into());
    w.changed(repo);
    assert_eq!(
        *out.0.lock().unwrap(),
        [vec![ev(&at("w.go"), WATCH_CHANGED)]]
    );
}

#[test]
fn repo_watch_seen_sets_baseline_without_notify() {
    let repo = "/r";
    let at = |rel: &str| filepath::join(&[repo, rel]);
    let v = Arc::new(FakeView::default());
    let out = Arc::new(FakeOut::default());
    put(&v, repo, snap("h1", &[]));
    let w = watch(&v, &out, vec![at("c.go")]);
    w.seen(repo);
    assert!(out.0.lock().unwrap().is_empty());
    put(&v, repo, snap("h2", &[]));
    *v.ns.lock().unwrap() = vec![ns("A", "c.go", "")];
    w.changed(repo);
    assert_eq!(
        *v.asked.lock().unwrap(),
        [("h1".to_owned(), "h2".to_owned())]
    );
    assert_eq!(
        *out.0.lock().unwrap(),
        [vec![ev(&at("c.go"), WATCH_CREATED)]]
    );
}
