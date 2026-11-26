//! `otterctl issue` (ISSUE_TREE_CHAT_SRS FR-LIS-6·8, TC-ITH-15). 이슈 파일 자체의 규칙은 issuefile crate 가 잰다 —
//! 여기서는 명령의 인자·출력·종료 코드와 원본 폴더만 고치는지를 본다.

use super::*;

struct T {
    _d: tempfile::TempDir,
    dir: String,
}

fn setup() -> T {
    let d = tempfile::tempdir().unwrap();
    let dir = d
        .path()
        .join("perf")
        .join("issues")
        .to_string_lossy()
        .into_owned();
    T { _d: d, dir }
}

fn issue(t: &T, args: &[&str], stdin: &[u8]) -> (i32, String, String) {
    let mut a = vec!["issue"];
    a.extend_from_slice(args);
    a.extend_from_slice(&["--dir", &t.dir]);
    run_with(
        &Env::with_vars([("HOME", "/nonexistent")]),
        crate::otterctl::run_otterctl,
        &a,
        stdin,
    )
}

#[test]
fn issue_init_new_tree_show() {
    let t = setup();
    let (rc, _, err) = run_with(
        &Env::with_vars([("HOME", "/nonexistent")]),
        crate::otterctl::run_otterctl,
        &["issue", "init", &t.dir],
        b"",
    );
    assert_eq!(rc, 0, "{err}");
    let readme = std::fs::read_to_string(std::path::Path::new(&t.dir).join("README.md")).unwrap();
    for w in [
        "id:",
        "status:",
        "deps:",
        "todo",
        "blocked",
        "split",
        "진행 기록",
    ] {
        assert!(readme.contains(w), "안내에 {w} 가 없다");
    }
    assert_eq!(issue(&t, &["new", "1", "뿌리", "이슈"], b"").0, 0);
    let (rc, out, err) = issue(&t, &["new", "1.1", "가", "--deps", "1"], b"");
    assert_eq!(rc, 0, "{err}");
    assert!(out.trim().ends_with("1.1-가.md"), "{out}");
    let (rc, out, _) = issue(&t, &["tree"], b"");
    assert_eq!(rc, 0);
    assert_eq!(
        out,
        "1       [ready      ] 뿌리 이슈\n  1.1     [todo       ] 가  ← 1\n"
    );
    assert_eq!(
        issue(&t, &["tree", "todo"], b"").1,
        "  1.1     [todo       ] 가  ← 1\n"
    );
    let (rc, out, _) = issue(&t, &["show", "1.1"], b"");
    assert_eq!(rc, 0);
    assert!(
        out.starts_with("---\nid: \"1.1\"\ntitle: 가\nstatus: todo\n"),
        "{out}"
    );
}

#[test]
fn issue_set_and_log() {
    let t = setup();
    issue(&t, &["new", "1", "뿌리"], b"");
    let (rc, out, err) = issue(
        &t,
        &[
            "set", "1", "--status", "ready", "--owner", "tab-9", "--branch", "perf/1",
        ],
        b"",
    );
    assert_eq!(rc, 0, "{err}");
    assert_eq!(out.trim(), "1 ready");
    let (rc, _, err) = issue(&t, &["set", "1", "--status", "done"], b"");
    assert_eq!(rc, 1);
    assert!(
        err.contains("허용되지 않은 전이") && err.contains("ready → done"),
        "{err}"
    );
    let (rc, _, err) = issue(&t, &["set", "1", "--status", "blocked"], b"");
    assert_eq!(rc, 1);
    assert!(err.contains("--reason"), "{err}");
    assert_eq!(
        issue(
            &t,
            &["set", "1", "--status", "blocked", "--reason", "막힘"],
            b""
        )
        .0,
        0
    );
    let (rc, _, err) = issue(&t, &["log", "1"], "기록 한 줄\n".as_bytes());
    assert_eq!(rc, 0, "{err}");
    let show = issue(&t, &["show", "1"], b"").1;
    assert!(
        show.contains("owner: \"tab-9\"") && show.contains("branch: perf/1"),
        "{show}"
    );
    assert!(
        show.contains("blocked — 막힘") && show.contains("기록 한 줄"),
        "{show}"
    );
}

#[test]
fn issue_usage_errors() {
    let t = setup();
    issue(&t, &["new", "1", "뿌리"], b"");
    for (args, code) in [
        (&["tree", "doing"][..], 2),
        (&["new", "2"][..], 2),
        (&["new", "1.1.1", "고아"][..], 1),
        (&["set", "1", "--status", "nope"][..], 2),
        (&["set", "1"][..], 2),
        (&["show", "9"][..], 1),
        (&["log", "1"][..], 2),
        (&["bogus"][..], 2),
    ] {
        let (rc, _, err) = issue(&t, args, b"");
        assert_eq!(rc, code, "{args:?}: {err}");
        assert!(!err.is_empty(), "{args:?}");
    }
    let (rc, _, err) = run_with(
        &Env::with_vars([("HOME", "/nonexistent")]),
        crate::otterctl::run_otterctl,
        &["issue", "tree"],
        b"",
    );
    // --dir 이 없으면 Run 에 묻는다 — 서버가 없으면 그 실패다(1).
    assert_eq!(rc, 1, "{err}");
    assert!(!err.is_empty());
    let (rc, out, _) = run_with(
        &Env::with_vars([("HOME", "/nonexistent")]),
        crate::otterctl::run_otterctl,
        &["issue", "--help"],
        b"",
    );
    assert_eq!(rc, 0);
    assert!(out.contains("otterctl issue tree"), "{out}");
}

/// FR-LIS-7: 명령은 받은 원본 폴더만 고친다 — worktree 안의 사본은 그대로다.
#[test]
fn issue_touches_only_the_source_dir() {
    let t = setup();
    issue(&t, &["new", "1", "뿌리"], b"");
    let copy = tempfile::tempdir().unwrap();
    let src = std::path::Path::new(&t.dir).join("1-뿌리.md");
    let dst = copy.path().join("1-뿌리.md");
    std::fs::copy(&src, &dst).unwrap();
    let before = std::fs::read(&dst).unwrap();
    issue(&t, &["set", "1", "--status", "ready"], b"");
    assert_eq!(std::fs::read(&dst).unwrap(), before);
    assert_ne!(std::fs::read(&src).unwrap(), before);
}

/// FR-LIS-2: 인자 꼴 판정을 명령으로 낸다 — 로컬이면 폴더·ID·트리 이름, 아니면 github.
#[test]
fn issue_resolve() {
    let t = setup();
    std::fs::create_dir_all(&t.dir).unwrap();
    let env = Env::with_vars([("HOME", "/nonexistent")]);
    let arg = format!("{}#2.1", t.dir);
    let (rc, out, err) = run_with(
        &env,
        crate::otterctl::run_otterctl,
        &["issue", "resolve", &arg],
        b"",
    );
    assert_eq!(rc, 0, "{err}");
    assert_eq!(out, format!("local\t{}\t2.1\tperf:2.1\n", t.dir));
    let (rc, out, _) = run_with(
        &env,
        crate::otterctl::run_otterctl,
        &["issue", "resolve", "o/r#5"],
        b"",
    );
    assert_eq!((rc, out.as_str()), (0, "github\to/r#5\n"));
    let (rc, _, _) = run_with(
        &env,
        crate::otterctl::run_otterctl,
        &["issue", "resolve"],
        b"",
    );
    assert_eq!(rc, 2);
}

/// FR-LIS-7: --dir 이 없으면 부르는 탭의 Run 이 기록한 원본 폴더를 쓴다.
#[test]
fn issue_dir_from_run() {
    let t = setup();
    issue(&t, &["new", "1", "뿌리"], b"");
    let home = tempfile::tempdir().unwrap();
    let srv = TestServer::fixed(
        200,
        &format!(
            r#"{{"runId":"r1","tree":"perf:1","storage":"local","issueDir":"{}"}}"#,
            t.dir
        ),
    );
    let mut env = srv.env(home.path());
    env.set("OTTERMINAL_TOOL_ID", "tool-x");
    let (rc, out, err) = ctl(&env, &["issue", "tree"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(out, "1       [ready      ] 뿌리\n");
    let reqs = srv.requests();
    assert_eq!(reqs[0].path(), "/api/runs/issues");
    assert!(
        reqs[0].target.contains("toolId=tool-x"),
        "{}",
        reqs[0].target
    );
    let gh = TestServer::fixed(200, r#"{"runId":"r1","tree":"o/r#1","storage":"github"}"#);
    let (rc, _, err) = ctl(&gh.env(home.path()), &["issue", "tree"]);
    assert_eq!(rc, 2);
    assert!(err.contains("로컬 이슈 트리가 아니다"), "{err}");
}
