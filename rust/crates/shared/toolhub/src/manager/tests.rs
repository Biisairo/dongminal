use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicI32;

use super::*;

/// 프로세스 정보의 가짜다. pid 1000 대의 도구만 다룬다.
#[derive(Default)]
struct FakeInfo {
    cwds_calls: AtomicI32,
    children: HashMap<i32, bool>,
    parents: Option<HashMap<i32, i32>>,
    names: HashMap<i32, String>,
}

impl ProcInfo for FakeInfo {
    fn has_children(&self, pid: i32) -> bool {
        self.children.get(&pid).copied().unwrap_or(false)
    }
    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool> {
        pids.iter().map(|p| (*p, self.has_children(*p))).collect()
    }
    fn cwd(&self, _: i32) -> Option<String> {
        None
    }
    fn cwds(&self, pids: &[i32]) -> HashMap<i32, String> {
        self.cwds_calls.fetch_add(1, SeqCst);
        pids.iter().map(|p| (*p, "/many".to_string())).collect()
    }
    fn names(&self, pids: &[i32]) -> HashMap<i32, String> {
        pids.iter()
            .filter_map(|p| self.names.get(p).map(|n| (*p, n.clone())))
            .collect()
    }
    fn listener_pids(&self, _: &str) -> Vec<i32> {
        vec![]
    }
    fn parent_pid(&self, _: i32) -> Option<i32> {
        None
    }
    fn parents(&self) -> Option<HashMap<i32, i32>> {
        self.parents.clone()
    }
    fn connection_owner_pid(&self, _: &str) -> Option<i32> {
        None
    }
}

/// pid 와 크기만 아는 터미널이다. 읽기 스레드는 띄우지 않는다.
struct PidTerm {
    pid: i32,
    size: StdMutex<(u16, u16)>,
    written: StdMutex<Vec<u8>>,
    fg: Option<i32>,
}

impl PidTerm {
    fn boxed(pid: i32) -> Box<dyn Terminal> {
        Box::new(Self {
            pid,
            size: StdMutex::new((80, 24)),
            written: StdMutex::default(),
            fg: None,
        })
    }
}

impl Terminal for PidTerm {
    fn read(&self, _: &mut [u8]) -> io::Result<usize> {
        Ok(0)
    }
    fn write(&self, b: &[u8]) -> io::Result<usize> {
        self.written.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn close(&self) -> io::Result<()> {
        Ok(())
    }
    fn resize(&self, c: u16, r: u16) -> io::Result<()> {
        *self.size.lock().unwrap() = (c, r);
        Ok(())
    }
    fn size(&self) -> io::Result<(u16, u16)> {
        Ok(*self.size.lock().unwrap())
    }
    fn foreground_pgid(&self) -> Option<i32> {
        self.fg
    }
    fn pid(&self) -> i32 {
        self.pid
    }
    fn wait(&self) -> io::Result<std::process::ExitStatus> {
        Err(io::Error::other("fake"))
    }
    fn terminate(&self) -> io::Result<()> {
        Ok(())
    }
    fn kill(&self) -> io::Result<()> {
        Ok(())
    }
    fn handover(&self) -> Option<&dyn dm_shared_platform::Handover> {
        None
    }
}

fn leak(info: FakeInfo) -> &'static FakeInfo {
    Box::leak(Box::new(info))
}

fn pid_tool(id: &str, pid: i32) -> Arc<Tool> {
    Tool::on_term(
        id,
        id,
        PidTerm::boxed(pid),
        false,
        None,
        None,
        Stream::new(BUF_MAX),
    )
}

fn batch_manager(info: &'static FakeInfo, n: usize) -> ToolManager {
    let m = ToolManager::with_proc_info("", None, info);
    for i in 1..=n {
        let id = char::from(b'a' + u8::try_from(i - 1).unwrap()).to_string();
        m.adopt(pid_tool(&id, 1000 + i32::try_from(i).unwrap()));
    }
    m
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn parse_size_rules() {
    type Case<'a> = (Option<&'a str>, Option<&'a str>, (u16, u16));
    let cases: [Case; 8] = [
        (None, None, (120, 40)),
        (Some("80"), Some("24"), (80, 24)),
        (Some("0"), Some("0"), (120, 40)),
        (Some("4096"), Some("4097"), (4096, 40)),
        (Some("+80"), Some("-1"), (120, 40)),
        (Some("abc"), Some(""), (120, 40)),
        (Some("70000"), Some("030"), (120, 30)),
        (Some("80 "), Some("24"), (120, 24)),
    ];
    for (c, r, want) in cases {
        assert_eq!(parse_size(c, r), want, "{c:?} {r:?}");
    }
}

#[test]
fn wrap_paste_rules() {
    assert_eq!(wrap_paste(b"echo hi", false), b"echo hi");
    assert_eq!(wrap_paste(b"echo hi", true), b"\x1b[200~echo hi\x1b[201~");
    let text = b"a\x1b[201~rm -rf /\x1b[201~b";
    assert_eq!(wrap_paste(text, true), b"\x1b[200~arm -rf /b\x1b[201~");
    assert_eq!(wrap_paste(text, false), text);
    // 지운 자리에서 다시 생기는 끝 표시도 남기지 않는다 (FR-RSP-6).
    let nested = b"a\x1b[20\x1b[201~1~; rm -rf /";
    assert_eq!(wrap_paste(nested, true), b"\x1b[200~a; rm -rf /\x1b[201~");
    let deep = b"\x1b[2\x1b[20\x1b[201~1~01~x";
    assert_eq!(wrap_paste(deep, true), b"\x1b[200~x\x1b[201~");
}

#[test]
fn derived_and_tab_names() {
    for (raw, want) in [
        ("vim", "vim"),
        ("/usr/bin/vim", "vim"),
        ("  claude  ", "claude"),
        ("sh", ""),
        ("bash", ""),
        ("zsh", ""),
        ("fish", ""),
        ("dash", ""),
        ("/bin/zsh", ""),
        ("-zsh", ""),
        ("-someprog", "someprog"),
        ("abcdefghijklmnopqrst", "abcdefghijklmnop"),
        ("", ""),
        ("   ", ""),
        ("/", ""),
        ("-", ""),
    ] {
        assert_eq!(derived_name(raw), want, "{raw:?}");
    }
    let home = "/home/u";
    for (cwd, want) in [
        (home, "~"),
        ("/home/u/", "~"),
        ("/", "/"),
        ("/home/u/work/dongminal", "dongminal"),
        ("/home/u/work/dongminal/", "dongminal"),
        ("/x/abcdefghijklmnopqrst", "abcdefghijklmnop"),
        ("", ""),
    ] {
        assert_eq!(cwd_tab_name(cwd, home), want, "{cwd:?}");
    }
    assert_eq!(cwd_tab_name(home, ""), "u");
}

#[test]
fn errors_match_go() {
    assert_eq!(
        ManagerError::NotFound.to_string(),
        "toolhub: tool not found"
    );
    assert_eq!(
        ManagerError::ToolCap.to_string(),
        "도구 수가 상한에 이르렀다"
    );
    assert_eq!(
        ManagerError::Sealed.to_string(),
        "데몬 교체 중이라 도구를 만들 수 없다"
    );
}

#[test]
fn get_list_delete_not_found() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    assert!(m.get("x").is_none() && !m.is_live("x"));
    assert!(m.list_cached().is_empty() && m.snapshot().is_empty());
    assert!(matches!(m.delete("x"), Err(ManagerError::NotFound)));
    assert!(matches!(m.write("x", b"a"), Err(ManagerError::NotFound)));
    assert!(matches!(m.resize("x", 1, 1), Err(ManagerError::NotFound)));
    assert_eq!(m.cwd("x"), "");
    assert!(!m.busy("x"));
    assert_eq!(m.snapshot_tool("x"), ToolSnapshot::default());
    assert!(!m.set_background("x", true));

    m.adopt(pid_tool("b", 1002));
    m.adopt(pid_tool("a", 1001));
    let l = m.list_cached();
    assert_eq!(
        l.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!((l[0].pid, l[0].cols, l[0].rows), (1001, 80, 24));
    assert!(m.delete("a").is_ok());
    assert!(!m.is_live("a"));
}

#[test]
fn busy_many_and_shell_probe() {
    let info = leak(FakeInfo {
        children: [(1001, true)].into_iter().collect(),
        parents: Some([(1001, 1), (1500, 1001)].into_iter().collect()),
        ..Default::default()
    });
    let m = batch_manager(info, 2);
    let got = m.busy_many(&["a".into(), "b".into(), "zz".into()]);
    assert_eq!((got["a"], got["b"], got["zz"]), (true, false, false));
    assert_eq!(m.shell_probe("a", &[1500]), ShellState::Here);
    assert_eq!(m.shell_probe("a", &[]), ShellState::Busy);
    assert_eq!(m.shell_probe("없음", &[]), ShellState::Unknown);
}

#[test]
fn background_list_one_cwds_query_and_order() {
    let info = leak(FakeInfo::default());
    let m = batch_manager(info, 5);
    for id in ["c", "a", "e", "b", "d"] {
        assert!(m.set_background(id, true));
    }
    let before = info.cwds_calls.load(SeqCst);
    let got = m.background_list();
    assert_eq!(info.cwds_calls.load(SeqCst) - before, 1);
    assert_eq!(got.len(), 5);
    assert!(got.iter().all(|e| e.cwd == "/many"));
    assert!(got.windows(2).all(|w| w[0].since <= w[1].since));
    assert!(m.set_background("a", false));
    assert!(!m.is_background("a"));
    m.delete("b").unwrap();
    assert!(!m.is_background("b"));
}

#[test]
fn sandboxed_tool_cannot_go_background() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let p = pid_tool("s", 1001);
    p.set_sandboxed(true);
    m.adopt(p);
    assert!(!m.set_background("s", true));
    assert!(m.set_background("s", false));
}

#[test]
fn save_all_writes_tools_json_like_go() {
    let d = tmp();
    let info = leak(FakeInfo::default());
    let m = ToolManager::with_proc_info(d.path().to_str().unwrap(), None, info);
    m.adopt(pid_tool("b", 1002));
    m.adopt(pid_tool("a", 1001));
    let sbx = pid_tool("s", 1003);
    sbx.set_sandboxed(true);
    m.adopt(sbx);
    m.adopt(pid_tool("bg", 1004));
    m.save_all();
    let path = d.path().join("tools.json");
    assert!(!path.exists(), "바뀐 것이 없으면 쓰지 않는다");
    m.set_background("bg", true);
    m.save_all();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        r#"[{"id":"a","name":"a","cwd":"/many","pid":1001},{"id":"b","name":"b","cwd":"/many","pid":1002}]"#
    );
    m.set_owned_tools(Arc::new(|| ["bg".to_string()].into_iter().collect()));
    m.save_all();
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .contains(r#""id":"bg""#)
    );
}

#[test]
fn save_all_empty_and_no_data_dir() {
    let d = tmp();
    let m =
        ToolManager::with_proc_info(d.path().to_str().unwrap(), None, leak(FakeInfo::default()));
    m.mark_mutated();
    m.save_all();
    assert_eq!(
        std::fs::read_to_string(d.path().join("tools.json")).unwrap(),
        "[]"
    );
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    m.mark_mutated();
    m.save_all();
    let mut n = 0;
    m.load_all_with(
        &["t-1".to_string()].into_iter().collect(),
        |_, _, _, _, _| {
            n += 1;
            Ok::<(), String>(())
        },
    );
    assert_eq!(n, 0);
}

#[test]
fn save_all_is_serialized_and_runs_every_call() {
    let m = ToolManager::with_proc_info(
        tmp().path().to_str().unwrap(),
        None,
        leak(FakeInfo::default()),
    );
    m.mark_mutated();
    let in_flight = Arc::new(AtomicI32::new(0));
    let peak = Arc::new(AtomicI32::new(0));
    let calls = Arc::new(AtomicI32::new(0));
    let (f, p, c) = (
        Arc::clone(&in_flight),
        Arc::clone(&peak),
        Arc::clone(&calls),
    );
    m.set_owned_tools(Arc::new(move || {
        c.fetch_add(1, SeqCst);
        let n = f.fetch_add(1, SeqCst) + 1;
        p.fetch_max(n, SeqCst);
        thread::sleep(Duration::from_millis(5));
        f.fetch_sub(1, SeqCst);
        HashSet::new()
    }));
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let m = m.clone();
            thread::spawn(move || m.save_all())
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(peak.load(SeqCst), 1);
    assert_eq!(calls.load(SeqCst), 8);
}

#[test]
fn save_async_coalesces_and_stops() {
    let m = ToolManager::with_proc_info(
        tmp().path().to_str().unwrap(),
        None,
        leak(FakeInfo::default()),
    );
    m.mark_mutated();
    let calls = Arc::new(AtomicI32::new(0));
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let (rel_tx, rel_rx) = std::sync::mpsc::channel::<()>();
    let rel_rx = Arc::new(StdMutex::new(rel_rx));
    let c = Arc::clone(&calls);
    m.set_owned_tools(Arc::new(move || {
        if c.fetch_add(1, SeqCst) == 0 {
            tx.send(()).unwrap();
            rel_rx.lock().unwrap().recv().unwrap();
        }
        HashSet::new()
    }));
    m.save_async();
    rx.recv().unwrap();
    for _ in 0..10 {
        m.save_async();
    }
    rel_tx.send(()).unwrap();
    m.stop_saving();
    assert_eq!(calls.load(SeqCst), 2);
    m.save_async();
    assert_eq!(calls.load(SeqCst), 2);
}

fn seed(dir: &Path, body: &str) {
    std::fs::write(dir.join("tools.json"), body).unwrap();
}

#[test]
fn load_all_rules() {
    let d = tmp();
    seed(
        d.path(),
        r#"[{"id":"keep","name":"a","cwd":"/"},{"id":"orphan","name":"b","cwd":"/"},{"id":"bad","name":"c","cwd":"/"}]"#,
    );
    let m =
        ToolManager::with_proc_info(d.path().to_str().unwrap(), None, leak(FakeInfo::default()));
    let mut tried = Vec::new();
    m.load_all_with(
        &["keep".to_string(), "bad".to_string()]
            .into_iter()
            .collect(),
        |id, _, _, c, r| {
            tried.push((id.to_string(), c, r));
            if id == "bad" {
                Err("permission denied")
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(
        tried,
        [("keep".to_string(), 120, 40), ("bad".to_string(), 120, 40)]
    );

    for body in ["{ broken", "null"] {
        let d = tmp();
        seed(d.path(), body);
        let m = ToolManager::with_proc_info(
            d.path().to_str().unwrap(),
            None,
            leak(FakeInfo::default()),
        );
        m.load_all_with(
            &["x".to_string()].into_iter().collect(),
            |_, _, _, _, _| -> Result<(), String> { panic!("되살리면 안 된다") },
        );
    }
    let d = tmp();
    let m =
        ToolManager::with_proc_info(d.path().to_str().unwrap(), None, leak(FakeInfo::default()));
    m.load_all_with(
        &["x".to_string()].into_iter().collect(),
        |_, _, _, _, _| -> Result<(), String> { panic!("파일이 없다") },
    );
}

#[test]
fn snapshot_since_resumes_or_replays() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let p = pid_tool("a", 1001);
    p.handle_chunk(b"hello\x1b[?2004h");
    m.adopt(Arc::clone(&p));
    let full = m.snapshot_tool("a");
    assert_eq!(full.data, b"hello\x1b[?2004h");
    assert_eq!(
        (full.end, full.total_bytes_in, full.retained, full.resumed),
        (13, 13, 13, false)
    );
    assert_eq!((full.cols, full.rows), (80, 24));
    assert!(full.modes.bracketed_paste);
    let part = m.snapshot_tool_since("a", 5);
    assert_eq!(part.data, b"\x1b[?2004h");
    assert_eq!((part.end, part.retained, part.resumed), (13, 8, true));
}

#[test]
fn activity_snapshot_hides_idle_working() {
    let info = leak(FakeInfo {
        children: [(1001, true)].into_iter().collect(),
        ..Default::default()
    });
    let m = batch_manager(info, 3);
    m.get("a").unwrap().set_activity("working", "Bash", "ls");
    m.get("b").unwrap().set_activity("working", "Bash", "ls");
    m.get("c").unwrap().set_activity("waiting", "", "");
    let ids: Vec<String> = m
        .activity_snapshot()
        .into_iter()
        .map(|s| s.tool_id)
        .collect();
    assert_eq!(ids, ["a", "c"]);
}

#[test]
fn clear_all_attention_and_config() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let a = m.adopt_detached("a");
    let b = m.adopt_detached("b");
    a.signal_attention("x");
    assert!(a.attention() && !b.attention());
    assert_eq!(m.clear_all_attention(), 1);
    assert!(!a.attention());
    m.set_attention_config(Duration::from_secs(1), true);
    assert!(m.rd().allow_bell);
}

#[test]
fn hooks_follow_notifiers() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let seen = Arc::new(StdMutex::new(Vec::<String>::new()));
    let s = Arc::clone(&seen);
    m.set_attention_notifier(
        Some(Arc::new(move |id, r| {
            s.lock().unwrap().push(format!("{id}:{r}"))
        })),
        None,
    );
    let p = m.adopt_detached("a");
    p.signal_attention("codex");
    assert_eq!(*seen.lock().unwrap(), ["a:codex"]);
}

#[test]
fn foreground_cache_interval_and_notify() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    m.adopt_detached("a");
    m.adopt_detached("b");
    let calls = Arc::new(AtomicI32::new(0));
    let name = Arc::new(StdMutex::new("vim".to_string()));
    let (c, n) = (Arc::clone(&calls), Arc::clone(&name));
    m.set_foreground_probe(Some(Arc::new(move |_ids: &[String]| {
        c.fetch_add(1, SeqCst);
        let v = n.lock().unwrap().clone();
        if v.is_empty() {
            HashMap::new()
        } else {
            [("a".to_string(), v)].into_iter().collect()
        }
    })));
    let got = Arc::new(StdMutex::new(Vec::<(String, String)>::new()));
    let g = Arc::clone(&got);
    m.set_foreground_notifier(Some(Arc::new(move |id, n| {
        g.lock().unwrap().push((id.into(), n.into()))
    })));
    let t0 = Instant::now();
    for i in 0..5 {
        m.refresh_foreground_at(t0 + Duration::from_millis(100 * i));
    }
    assert_eq!(calls.load(SeqCst), 1);
    m.refresh_foreground_at(t0 + FOREGROUND_REFRESH_INTERVAL);
    assert_eq!(calls.load(SeqCst), 2);
    assert_eq!(
        m.cached_foreground_names().get("a").map(String::as_str),
        Some("vim")
    );
    assert!(!m.cached_foreground_names().contains_key("b"));
    *name.lock().unwrap() = "node".into();
    m.refresh_foreground_at(t0 + FOREGROUND_REFRESH_INTERVAL * 2);
    *name.lock().unwrap() = String::new();
    m.refresh_foreground_at(t0 + FOREGROUND_REFRESH_INTERVAL * 3);
    m.refresh_foreground_at(t0 + FOREGROUND_REFRESH_INTERVAL * 4);
    let want: Vec<(String, String)> = [("a", "vim"), ("a", "node"), ("a", "")]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    assert_eq!(*got.lock().unwrap(), want);
    m.delete("a").unwrap();
    m.refresh_foreground_at(t0 + FOREGROUND_REFRESH_INTERVAL * 5);
    assert!(!lock(&m.inner.fg).cache.contains_key("a"));
}

#[test]
fn foreground_falls_back_to_reported_cwd() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let p = m.adopt_detached("a");
    p.note_cwd_report("/x/proj");
    m.set_foreground_probe(Some(Arc::new(|_: &[String]| HashMap::new())));
    assert_eq!(
        m.foreground_names().get("a").map(String::as_str),
        Some("proj")
    );
}

#[test]
fn handover_tool_json_shape() {
    let ht = HandoverTool {
        id: "a".into(),
        name: "S".into(),
        fd: 7,
        pid: 9,
        cols: 80,
        rows: 24,
        ..Default::default()
    };
    assert_eq!(
        String::from_utf8(json::marshal(&ht).unwrap()).unwrap(),
        r#"{"id":"a","name":"S","fd":7,"pid":9,"cols":80,"rows":24,"offset":0,"agent":{"agentSeen":false,"armed":false,"attention":false,"lastOutputAt":0,"rearmLocked":false,"turn":{"inProgress":false,"waitingSignaled":false,"turnRan":false}}}"#
    );
    let full = HandoverTool {
        screen: b"hi".to_vec(),
        background: true,
        modes: 1 << 32,
        cwd: "/c".into(),
        ..ht
    };
    let s = String::from_utf8(json::marshal(&full).unwrap()).unwrap();
    assert!(
        s.contains(r#""background":true,"screen":"aGk=","offset":0,"modes":4294967296,"cwd":"/c""#),
        "{s}"
    );
    let back: HandoverTool = json::unmarshal(s.as_bytes()).unwrap();
    assert_eq!(back, full);
}

#[test]
fn export_handover_requires_frozen() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    assert!(m.export_handover().unwrap().is_empty());
    m.adopt(pid_tool("a", 1001));
    assert_eq!(
        m.export_handover().unwrap_err().to_string(),
        "[tool a] 멈추지 않은 도구가 있다 — FreezeAll 뒤에 담는다"
    );
    assert_eq!(
        m.adopt_handover(HandoverTool::default())
            .unwrap_err()
            .to_string(),
        "도구 id 가 비었다"
    );
}

#[test]
fn tool_cap_and_seal() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let next = Arc::new(AtomicI32::new(1000));
    let n = Arc::clone(&next);
    m.set_start(Arc::new(move |r: StartReq<'_>| {
        Ok(pid_tool(r.id, n.fetch_add(1, SeqCst)))
    }));
    for _ in 0..TOOL_CAP {
        m.create("", 80, 24, Placement::default()).unwrap();
    }
    assert!(matches!(
        m.create("", 80, 24, Placement::default()),
        Err(ManagerError::ToolCap)
    ));
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    m.set_start(Arc::new(|r: StartReq<'_>| Ok(pid_tool(r.id, 1))));
    m.wr().sealed = true;
    assert!(matches!(
        m.create("", 80, 24, Placement::default()),
        Err(ManagerError::Sealed)
    ));
    assert!(matches!(
        m.restore("r", "r", "", 80, 24),
        Err(ManagerError::Sealed)
    ));
    m.unseal();
    let p = m
        .create(
            "",
            80,
            24,
            Placement {
                profile: String::new(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!p.sandboxed());
}

#[test]
fn sandbox_placement_never_falls_back() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    let started = Arc::new(AtomicI32::new(0));
    let s = Arc::clone(&started);
    m.set_start(Arc::new(move |r: StartReq<'_>| {
        s.fetch_add(1, SeqCst);
        Ok(pid_tool(r.id, 1))
    }));
    let place = Placement {
        window_uuid: "w".into(),
        profile: "scratch".into(),
        ..Default::default()
    };
    let e = m.create("", 80, 24, place.clone()).unwrap_err();
    assert_eq!(
        e.to_string(),
        "샌드박스 창(scratch)이지만 컨테이너 배치가 구성되지 않았습니다"
    );
    m.set_placer(Arc::new(|_: &Placement| {
        Err(io::Error::other("컨테이너 런타임에 연결할 수 없습니다"))
    }));
    assert!(m.create("", 80, 24, place.clone()).is_err());
    assert_eq!(started.load(SeqCst), 0);
    let seen = Arc::new(StdMutex::new(Placement::default()));
    let sn = Arc::clone(&seen);
    m.set_placer(Arc::new(move |p: &Placement| {
        *sn.lock().unwrap() = p.clone();
        Ok(ProcSpec {
            path: "/bin/sh".into(),
            args: vec!["/bin/sh".into()],
            env: vec![],
            dir: String::new(),
        })
    }));
    let p = m.create("/host", 80, 24, place).unwrap();
    assert!(p.sandboxed());
    let got = seen.lock().unwrap().clone();
    assert_eq!(
        (got.host_dir.as_str(), got.tool_id.as_str()),
        ("/host", p.id.as_str())
    );
}

#[test]
fn exited_before_register_is_reaped() {
    let inv = Arc::new(StdMutex::new(Vec::<String>::new()));
    let i = Arc::clone(&inv);
    let m = ToolManager::with_proc_info(
        "",
        Some(Arc::new(move |id: &str| i.lock().unwrap().push(id.into()))),
        leak(FakeInfo::default()),
    );
    m.set_start(Arc::new(|r: StartReq<'_>| {
        let p = pid_tool(r.id, 1);
        p.kill();
        Ok(p)
    }));
    let p = m.create("", 80, 24, Placement::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while m.is_live(&p.id) || inv.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "끝난 도구가 남았다");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(*inv.lock().unwrap(), std::slice::from_ref(&p.id));
}

#[tokio::test]
async fn terminate_unknown_is_not_found_and_paste() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    assert!(matches!(
        m.terminate("nope", Duration::from_secs(1)).await,
        Err(ManagerError::NotFound)
    ));
    assert_eq!(
        m.send_paste("nope", b"x", false)
            .await
            .unwrap_err()
            .to_string(),
        "tool 없음: nope"
    );
    let term = PidTerm {
        pid: 1001,
        size: StdMutex::new((80, 24)),
        written: StdMutex::default(),
        fg: None,
    };
    let p = Tool::on_term(
        "a",
        "a",
        Box::new(term),
        false,
        None,
        None,
        Stream::new(BUF_MAX),
    );
    p.observe_modes(b"\x1b[?2004h");
    m.adopt(Arc::clone(&p));
    m.send_paste("a", b"ls", true).await.unwrap();
    m.freeze_all().await;
    m.thaw_all();
}

#[tokio::test]
async fn freeze_all_seals_creation() {
    let m = ToolManager::with_proc_info("", None, leak(FakeInfo::default()));
    m.set_start(Arc::new(|r: StartReq<'_>| Ok(pid_tool(r.id, 1))));
    assert!(m.freeze_all().await);
    assert!(matches!(
        m.create("", 80, 24, Placement::default()),
        Err(ManagerError::Sealed)
    ));
    m.thaw_all();
    let p = m.create("", 80, 24, Placement::default()).unwrap();
    m.delete(&p.id).unwrap();
    m.adopt(pid_tool("nohandover", 2));
    assert!(
        !m.freeze_all().await,
        "handover 능력이 없는 도구는 멈추지 못한다"
    );
    assert!(!m.rd().sealed, "실패하면 봉인을 푼다");
}

#[cfg(unix)]
mod pty {
    use super::*;

    fn wait_until(what: &str, cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "{what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn create_command_freeze_and_save_pid() {
        let d = tmp();
        let m = ToolManager::new(d.path().to_str().unwrap(), None);
        let cwd = tmp();
        let place = Placement {
            command: "cat".into(),
            ..Default::default()
        };
        let p = m
            .create(cwd.path().to_str().unwrap(), 80, 24, place)
            .unwrap();
        assert!(!p.sandboxed(), "명령 배치는 샌드박스가 아니다");
        m.stop_saving();
        m.save_all();
        let states: Vec<ToolState> =
            json::unmarshal(&std::fs::read(d.path().join("tools.json")).unwrap()).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].pid, i64::from(p.cmd_process_pid()));
        assert_ne!(states[0].pid, 0);

        let off = || p.stream().unwrap().offset();
        p.write(b"one\n").unwrap();
        wait_until("첫 출력", || off() > 0);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let before = off();
        assert!(m.freeze_all().await);
        let ht = m.export_handover().unwrap();
        assert_eq!(ht.len(), 1);
        assert_eq!(ht[0].id, p.id);
        assert!(m.master_fds().contains(&usize::try_from(ht[0].fd).unwrap()));
        p.write(b"two\n").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(off(), before);
        m.thaw_all();
        wait_until("푼 뒤 출력", || off() > before);
        let m2 = m.clone();
        let id = p.id.clone();
        tokio::task::spawn_blocking(move || m2.delete(&id))
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn create_exit_command_is_reaped() {
        let m = ToolManager::new("", None);
        let place = Placement {
            command: "exit 0".into(),
            ..Default::default()
        };
        let p = m.create("", 80, 24, place).unwrap();
        wait_until("끝난 명령의 도구가 남았다", || !m.is_live(&p.id));
    }
}

#[cfg(unix)]
#[test]
fn env_overlay_reaches_tool_shell() {
    let data = tmp();
    let inst = tmp();
    let inst_s = inst.path().to_str().unwrap().to_string();
    let m = ToolManager::new(data.path().to_str().unwrap(), None);
    m.set_env_overlay(vec![(
        dm_shared_dmenv::ENV_HOME.to_string(),
        inst_s.clone(),
    )]);
    let t = m
        .create(inst.path().to_str().unwrap(), 80, 24, Placement::default())
        .expect("create");
    t.write(b"echo \"M=[$DONGMINAL_HOME]\"; echo \"P=[$PATH]\"\r")
        .unwrap();
    let want_home = format!("M=[{inst_s}]");
    let want_bin = format!("{inst_s}/bin]");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut out = String::new();
    while std::time::Instant::now() < deadline {
        out = String::from_utf8_lossy(&t.stream().unwrap().snapshot().0).into_owned();
        if out.contains(&want_home) && out.contains(&want_bin) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = m.delete(&t.id);
    m.stop_saving();
    assert!(out.contains(&want_home), "{out}");
    assert!(out.contains(&want_bin), "{out}");
}
