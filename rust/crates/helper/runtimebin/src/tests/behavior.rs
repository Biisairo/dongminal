//! 개별 동작 시험 — Go `*_test.go` 의 관측 기대값을 옮겼다.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::detach::run_detach;
use crate::download::run_download;
use crate::edit::run_edit;
use crate::helptext::OTTERCTL_HELP;
use crate::http::server_addr;
use crate::openurl::run_open_url;
use crate::otterctl::notify::sanitize_notify_label;
use crate::otterctl::rows::{match_fold, window_positions};
use crate::otterctl::status::limit_reset_text;
use crate::{helper, helper_name};

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn commands_only(srv: &TestServer) -> Vec<Value> {
    srv.requests()
        .iter()
        .filter(|r| r.path() == "/api/commands")
        .inspect(|r| {
            assert_eq!(
                (r.method.as_str(), r.content_type.as_str()),
                ("POST", "application/json")
            )
        })
        .map(Req::json)
        .collect()
}

const DELIVERED: &str = r#"{"ok":true,"delivered":1}"#;

// ── 분기·주소 ─────────────────────────────────────────

#[test]
fn helper_name_strips_executable_extension_only() {
    for (arg0, want) in [
        ("/usr/bin/otterctl", "otterctl"),
        ("otterctl.exe", "otterctl"),
        ("OTTERCTL.EXE", "OTTERCTL"),
        ("edit.Cmd", "edit"),
        ("x.bat", "x"),
        ("y.com", "y"),
        ("open-url.sh", "open-url.sh"),
        ("a.b.exe", "a.b"),
    ] {
        assert_eq!(helper_name(arg0), want, "{arg0}");
    }
    for name in ["otterctl", "edit", "download", "detach", "open-url"] {
        assert!(helper(name).is_some(), "{name}");
    }
    for name in otter_shared_agentadapter::shim_commands() {
        assert!(helper(name).is_some(), "shim {name}");
    }
    assert!(helper("otterminal").is_none());
    assert!(crate::dispatch(Vec::new()).is_none());
    assert!(crate::dispatch(vec!["/x/otterminal".into(), "version".into()]).is_none());
}

#[test]
fn server_addr_prefers_addr_file_and_rereads() {
    let home = tmp();
    let mut env = Env::with_vars([(
        otter_shared_otterenv::ENV_HOME,
        home.path().to_str().unwrap(),
    )]);
    env.fallback_home = None;
    otter_shared_serverconf::write_addr(home.path(), "127.0.0.1:60200").unwrap();
    assert_eq!(server_addr(&env), ("127.0.0.1".into(), "60200".into()));
    otter_shared_serverconf::write_addr(home.path(), "127.0.0.1:60201").unwrap();
    assert_eq!(server_addr(&env).1, "60201");
    // 주소 파일이 없으면 server.json → 기본값이다. 셸의 OTTERMINAL_PORT 는 읽지 않는다.
    let empty = tmp();
    let env = Env::with_vars([
        (
            otter_shared_otterenv::ENV_HOME,
            empty.path().to_str().unwrap(),
        ),
        (otter_shared_otterenv::ENV_PORT, "60999"),
    ]);
    let (h, p) = server_addr(&env);
    assert_eq!((h.as_str(), p.as_str()), ("127.0.0.1", "58146"));
}

#[test]
fn server_addr_in_container() {
    let dir = tmp();
    let file = dir.path().join("server.addr");
    let mut env = Env::with_vars([
        (
            otter_shared_otterenv::ENV_HOST,
            otter_shared_otterenv::CONTAINER_HOST,
        ),
        (otter_shared_otterenv::ENV_PORT, "60301"),
    ]);
    env.container_addr_file = Some(file.clone());
    assert_eq!(
        server_addr(&env),
        ("host.docker.internal".into(), "60301".into())
    );
    std::fs::write(&file, "0.0.0.0:60302\n").unwrap();
    assert_eq!(
        server_addr(&env),
        ("host.docker.internal".into(), "60302".into())
    );
    let mut env = Env::with_vars([(
        otter_shared_otterenv::ENV_HOST,
        otter_shared_otterenv::CONTAINER_HOST,
    )]);
    env.container_addr_file = Some(dir.path().join("none"));
    assert_eq!(server_addr(&env).1, "58146");
}

// ── 차분 시나리오 (helper-otterctl·helper-otterctl-sub·helper-misc) ─────────

/// testdata/helper_scenarios.jsonl 은 Go 참조 바이너리(go1.27.2)를 hermetic.sh 아래에서 돌려
/// 기록한 것이다. 현재 폴더는 `CWD` 로 지웠다.
#[test]
fn helper_scenarios_match_go() {
    let home = tmp();
    let port = closed_port();
    let mut env = env_at(home.path(), port);
    env.set(
        otter_shared_otterenv::ENV_HOME,
        home.path().to_str().unwrap(),
    );
    let cwd = std::env::current_dir().unwrap();
    let cwd = cwd.to_string_lossy();
    let mut checked = 0;
    for line in read_testdata("helper_scenarios.jsonl").lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let argv0 = row["argv0"].as_str().unwrap();
        let args: Vec<&str> = row["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let (code, out, err) = run_with(&env, helper(argv0).unwrap(), &args, b"");
        let what = format!("{argv0} {args:?}");
        assert_eq!(i64::from(code), row["code"].as_i64().unwrap(), "{what}");
        assert_eq!(
            out.replace(&*cwd, "CWD"),
            row["stdout"].as_str().unwrap(),
            "{what} stdout"
        );
        assert_eq!(
            err.replace(&*cwd, "CWD"),
            row["stderr"].as_str().unwrap(),
            "{what} stderr"
        );
        checked += 1;
    }
    assert_eq!(checked, 53);
}

// ── 레이아웃 명령 ─────────────────────────────────────

#[test]
fn layout_commands_send_expected_payloads() {
    let srv = TestServer::fixed(200, DELIVERED);
    let home = tmp();
    let env = srv.env(home.path());
    let cases: &[(&[&str], Value)] = &[
        (
            &["split-h", "3"],
            json!({"action":"splitH","args":{"count":3}}),
        ),
        (&["split-v"], json!({"action":"splitV","args":{}})),
        (
            &["new-window", "--name", "w", "-n"],
            json!({"action":"newWindow","args":{"name":"w","keepFocus":true}}),
        ),
        (
            &["new-window", "--cwd=/tmp/x"],
            json!({"action":"newWindow","args":{"cwd":"/tmp/x"}}),
        ),
        (
            &["new-tab", "--name", "t", "--at", "u-1", "-n"],
            json!({"action":"newTab","args":{"location":"u-1","name":"t","keepFocus":true}}),
        ),
        (
            &["new-tab", "--after", "u-2", "--index", "3"],
            json!({"action":"newTab","args":{"after":"u-2","index":3}}),
        ),
        (
            &["focus", "u-3"],
            json!({"action":"focus","args":{"location":"u-3","sourcePane":"self-tool"}}),
        ),
        (
            &["close-tab", "--at", "u"],
            json!({"action":"closeTab","args":{"location":"u"}}),
        ),
        (
            &["close-tab", "--force"],
            json!({"action":"closeTab","args":{"force":true}}),
        ),
        (
            &["close-window", "--background"],
            json!({"action":"closeWindow","args":{"force":true,"keepTool":true}}),
        ),
        (&["tool-left"], json!({"action":"paneLeft","args":{}})),
        (
            &["send", "x", r#"{"a":[1,2]}"#],
            json!({"action":"x","args":{"a":[1,2]}}),
        ),
        (&["send", "y"], json!({"action":"y","args":{}})),
        (
            &["open-editor", "--at", "u", "/a/b.txt"],
            json!({"action":"openEditorTab","args":{"location":"u","filePath":"/a/b.txt","name":"b.txt"}}),
        ),
    ];
    for (args, want) in cases {
        let before = commands_only(&srv).len();
        let (code, out, err) = ctl(&env, args);
        assert_eq!(code, 0, "{args:?} {err}");
        assert_eq!(out, format!("{DELIVERED}\n"), "{args:?}");
        let sent = commands_only(&srv);
        assert_eq!(sent.len(), before + 1, "{args:?}");
        assert_eq!(&sent[before], want, "{args:?}");
    }
}

#[test]
fn layout_usage_errors_never_post() {
    let srv = TestServer::fixed(200, DELIVERED);
    let home = tmp();
    let env = srv.env(home.path());
    let cases: &[(&[&str], i32, &str)] = &[
        (&["split-h", "1"], 2, "split count must be >= 2\n"),
        (
            &["split-h", "x"],
            2,
            "split count must be a positive integer: x\n",
        ),
        (
            &["focus"],
            2,
            "usage: otterctl focus <uuid>  (list-workspace 의 uuid 컬럼 값)\n",
        ),
        (
            &["close-tab", "--force", "--background"],
            2,
            "--force 와 --background 는 함께 쓸 수 없다 (닫기의 답은 하나다)\n",
        ),
        (
            &["new-tab", "--force"],
            2,
            "--force·--background 는 close-tab·close-window 에만 쓴다 (new-tab)\n",
        ),
        (
            &["rename-tab", "--at", "u"],
            2,
            "usage: otterctl rename-tab --at <uuid> <name>  (또는 --name <name>)\n",
        ),
        (
            &["rename-window", "--at", "u", "--auto"],
            2,
            "--auto 는 rename-tab 에만 쓴다 (창 이름에는 출처가 없다)\n",
        ),
        (
            &["rename-tab", "--at", "u", "--auto", "x"],
            2,
            "--auto 와 이름은 함께 쓸 수 없다\n",
        ),
        (&["send"], 2, "usage: otterctl send <action> [json-args]\n"),
        (
            &["open-editor", "--at", "u"],
            2,
            "usage: otterctl open-editor --at <uuid> [--name <이름>] <파일 절대경로>\n",
        ),
    ];
    for (args, code, err) in cases {
        let got = ctl(&env, args);
        assert_eq!((got.0, got.2.as_str()), (*code, *err), "{args:?}");
    }
    let (code, _, err) = ctl(&env, &["send", "x", "{bad"]);
    assert_eq!(code, 2);
    assert!(
        err.starts_with("otterctl: invalid json args: invalid character 'b'"),
        "{err}"
    );
    // NFR-ORD-1: 도움말을 청한 레이아웃 명령은 서버에 아무것도 보내지 않는다.
    for args in [
        &["close-tab", "--help"][..],
        &["new-tab", "-h"],
        &["split-v", "--at", "u", "--help"],
    ] {
        let (code, out, _) = ctl(&env, args);
        assert_eq!((code, out.as_str()), (0, OTTERCTL_HELP));
    }
    let (code, out, _) = ctl(&env, &["open-editor", "--help"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("otterctl open-editor — 편집기 탭 열기"));
    assert!(commands_only(&srv).is_empty());
}

#[test]
fn delivery_fields_decide_exit_code() {
    for (body, code, err) in [
        (
            r#"{"delivered":0}"#,
            1,
            "otterctl: 구독 중인 브라우저가 없습니다 — 페이지를 새로고침하세요\n",
        ),
        (
            r#"{"delivered":2,"timedOut":true}"#,
            1,
            "otterctl: 브라우저가 결과를 답하지 않았습니다 — 만들어지지 않았을 수 있습니다. list-workspace 로 확인하세요\n",
        ),
        (r#"{"delivered":1}"#, 0, ""),
        (r#"{"ok":true}"#, 0, ""),
    ] {
        let srv = TestServer::fixed(200, body);
        let home = tmp();
        let got = ctl(&srv.env(home.path()), &["new-tab"]);
        assert_eq!(
            (got.0, got.1.as_str(), got.2.as_str()),
            (code, format!("{body}\n").as_str(), err),
            "{body}"
        );
    }
}

// ── rename 확인 ───────────────────────────────────────

/// rename 을 받으면 lose 번째 전송까지는 반영하지 않는 서버.
fn rename_server(lose: usize, auto_tab: bool, with_ws: bool) -> TestServer {
    let sends = AtomicUsize::new(0);
    TestServer::new(move |r| {
        if r.path() == "/api/commands" {
            sends.fetch_add(1, Ordering::SeqCst);
            return (200, DELIVERED.as_bytes().to_vec());
        }
        if !with_ws {
            return (200, br#"{"tools":[]}"#.to_vec());
        }
        let applied = sends.load(Ordering::SeqCst) > lose;
        let (name, src) = match (applied, auto_tab) {
            (true, false) => ("새이름", "manual"),
            (true, true) => ("Shell", "auto"),
            (false, _) => ("옛이름", "manual"),
        };
        let wname = if applied { "새창" } else { "옛창" };
        let body = json!({"workspace": {"windows": [{"id":"w1","name":wname,"layout":{"type":"pane","id":"p1","tabs":[
            {"id":"t1","name":name,"nameSource":src}]}}]}});
        (200, serde_json::to_vec(&body).unwrap())
    })
}

fn rename_env(srv: &TestServer, home: &Path) -> Env {
    let mut env = srv.env(home);
    env.rename_window = Some(Duration::from_millis(60));
    env.rename_interval = Some(Duration::from_millis(5));
    env
}

#[test]
fn rename_confirms_and_resends() {
    let home = tmp();
    let srv = rename_server(0, false, true);
    let (code, out, err) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-tab", "--at", "t1", "새이름"],
    );
    assert_eq!(
        (code, out.as_str(), err.as_str()),
        (0, "{\"ok\":true,\"delivered\":1}\n", "")
    );
    assert_eq!(commands_only(&srv).len(), 1);
    assert_eq!(
        commands_only(&srv)[0],
        json!({"action":"renameTab","args":{"location":"t1","name":"새이름"}})
    );

    let srv = rename_server(1, false, true);
    let (code, out, _) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-tab", "--at", "t1", "--name", "새이름"],
    );
    assert_eq!(code, 0);
    assert_eq!(out.matches("delivered").count(), 1, "stdout 은 응답 하나다");
    assert_eq!(commands_only(&srv).len(), 2);

    let srv = rename_server(9, false, true);
    let (code, _, err) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-tab", "--at", "t1", "새이름"],
    );
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "otterctl: 이름 \"새이름\" 이 반영되지 않았습니다 (탭 t1, 3번 보냄) — 다른 화면의 저장과 겹쳤을 수 있습니다\n"
    );
    assert_eq!(commands_only(&srv).len(), 3);

    let srv = rename_server(0, true, true);
    let (code, _, _) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-tab", "--at", "t1", "--auto"],
    );
    assert_eq!(code, 0);
    assert_eq!(
        commands_only(&srv)[0],
        json!({"action":"renameTab","args":{"location":"t1","auto":true}})
    );

    let srv = rename_server(0, false, true);
    let (code, _, _) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-window", "--at", "t1", "새창"],
    );
    assert_eq!(code, 0);
    assert_eq!(commands_only(&srv).len(), 1);

    // 워크스페이스를 모르는 서버는 판정하지 않는다 (FR-TND-14).
    let srv = rename_server(9, false, false);
    let (code, _, _) = ctl(
        &rename_env(&srv, home.path()),
        &["rename-tab", "--at", "t1", "x"],
    );
    assert_eq!(code, 0);
    assert_eq!(commands_only(&srv).len(), 1);
}

// ── open-url · detach · download · edit ─────────────────

#[test]
fn open_url_decides_where() {
    let home = tmp();
    for (status, body, code, out, err) in [
        (200, r#"{"where":"local"}"#, 0, "OPEN https://x\n", ""),
        (200, r#"{"where":"viewer"}"#, 0, "", ""),
        (200, "{}", 0, "OPEN https://x\n", ""),
        (500, "boom", 0, "OPEN https://x\n", ""),
        (400, "url 거절\n", 1, "", "open-url: url 거절\n"),
    ] {
        let srv = TestServer::fixed(status, body);
        let env = srv.env(home.path());
        let got = run_with(&env, run_open_url, &["https://x"], b"");
        assert_eq!(
            (got.0, got.1.as_str(), got.2.as_str()),
            (code, out, err),
            "{status} {body}"
        );
        assert_eq!(
            commands_only(&srv),
            vec![json!({"action":"openUrl","args":{"url":"https://x"}})]
        );
    }
    let env = env_at(home.path(), closed_port());
    assert_eq!(
        run_with(&env, run_open_url, &["https://y"], b"").1,
        "OPEN https://y\n"
    );
    let mut failing = env.clone();
    failing.open_local = Some(|_, _| Err("no browser".into()));
    let got = run_with(&failing, run_open_url, &["https://y"], b"");
    assert_eq!((got.0, got.2.as_str()), (1, "open-url: no browser\n"));
}

#[test]
fn detach_payloads() {
    let srv = TestServer::fixed(200, DELIVERED);
    let home = tmp();
    let env = srv.env(home.path());
    for (args, want) in [
        (
            &[][..],
            json!({"action":"detachTab","args":{"toolId":"self-tool"}}),
        ),
        (
            &["--restore", "b1"],
            json!({"action":"restoreTool","args":{"toolId":"b1"}}),
        ),
        (
            &["--at", "u", "--restore=b2"],
            json!({"action":"restoreTool","args":{"toolId":"b2","location":"u"}}),
        ),
    ] {
        let before = commands_only(&srv).len();
        assert_eq!(run_with(&env, run_detach, args, b"").0, 0, "{args:?}");
        assert_eq!(commands_only(&srv)[before], want);
    }
    let no_tool = {
        let mut e = Env::with_vars([("X", "y")]);
        e.fallback_home = env.fallback_home.clone();
        e
    };
    let got = run_with(&no_tool, run_detach, &[], b"");
    assert_eq!(
        (got.0, got.2.as_str()),
        (
            1,
            "detach: OTTERMINAL_TOOL_ID 미설정 (otterminal 터미널 안에서 실행해야 합니다)\n"
        )
    );

    let srv = TestServer::fixed(200, r#"{"toolId":"bg-1"}"#);
    let env = srv.env(home.path());
    let got = run_with(&env, run_detach, &["--run", "npm test", "--cwd", "/w"], b"");
    assert_eq!(got.0, 0);
    assert_eq!(
        got.1,
        "background  toolId=bg-1  cmd=npm test\n  명령이 끝나면 이 도구는 스스로 사라진다 — detach --list 로 확인\n"
    );
    let r = &srv.requests()[0];
    assert_eq!(
        (r.path(), r.json()),
        (
            "/api/tools/headless",
            json!({"command":"npm test","cwd":"/w"})
        )
    );

    let srv = TestServer::fixed(
        200,
        r#"{"background":[{"toolId":"b1","name":"빌드 \"1\"","cwd":"/w","since":1}]}"#,
    );
    let got = run_with(&srv.env(home.path()), run_detach, &["-l"], b"");
    assert_eq!(got.1, "  toolId=b1  name=\"빌드 \\\"1\\\"\"  cwd=/w\n");
    let srv = TestServer::fixed(200, r#"{"background":[]}"#);
    assert_eq!(
        run_with(&srv.env(home.path()), run_detach, &["--list"], b"").1,
        "백그라운드 도구 없음\n"
    );
}

#[test]
fn download_and_edit() {
    let env = Env::with_vars([("X", "y")]);
    let got = run_with(&env, run_download, &[], b"");
    assert_eq!(got.1, "\x1b]777;Download;\x07");
    let got = run_with(&env, run_download, &["/abs/./x"], b"");
    assert_eq!(got.1, "\x1b]777;Download;/abs/x\x07");

    let dir = tmp();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "x").unwrap();
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let env = srv.env(dir.path());
    let got = run_with(&env, run_edit, &[file.to_str().unwrap()], b"");
    assert_eq!((got.0, got.1.as_str()), (0, "{\"ok\":true}\n"));
    let sent = commands_only(&srv);
    let abs = otter_gocompat::filepath::abs(file.to_str().unwrap()).unwrap();
    assert_eq!(
        sent[0],
        json!({"action":"openEditorTab","args":{"name":"a.txt","filePath":abs}})
    );
    let got = run_with(&env, run_edit, &[dir.path().to_str().unwrap()], b"");
    assert_eq!(
        (got.0, got.2),
        (1, format!("edit: 파일 없음: {}\n", dir.path().display()))
    );
    let env = env_at(dir.path(), 60999);
    let got = run_with(&env, run_edit, &[file.to_str().unwrap()], b"");
    assert_eq!(
        (got.0, got.2.as_str()),
        (1, "edit: 서버 연결 실패 (port=60999)\n")
    );
}

// ── 순서·그룹 ─────────────────────────────────────────

#[test]
fn order_commands() {
    let srv = TestServer::fixed(200, DELIVERED);
    let home = tmp();
    let env = srv.env(home.path());
    for (args, want) in [
        (
            &["move-window", "--at", "w-1", "--index", "2"][..],
            json!({"action":"moveWindow","args":{"window":"w-1","index":2}}),
        ),
        (
            &["move-window", "--at", "w-1", "--ungroup"],
            json!({"action":"moveWindow","args":{"window":"w-1","to":"top"}}),
        ),
        (
            &["move-tab", "--at", "t-1", "--before", "t-2"],
            json!({"action":"moveTab","args":{"tab":"t-1","before":"t-2"}}),
        ),
        (
            &["move-group", "--at", "g-1", "--prev"],
            json!({"action":"moveGroup","args":{"group":"g-1","prev":true}}),
        ),
        (
            &["new-group", "--name", "이슈", "--tree", "o/r#32"],
            json!({"action":"newGroup","args":{"name":"이슈","tree":{"repo":"o/r","root":32}}}),
        ),
        (
            &["rename-group", "--at", "g-1", "새", "이름"],
            json!({"action":"renameGroup","args":{"group":"g-1","name":"새 이름"}}),
        ),
        (
            &["delete-group", "-l", "g-1"],
            json!({"action":"deleteGroup","args":{"group":"g-1"}}),
        ),
    ] {
        let before = commands_only(&srv).len();
        let (code, _, err) = ctl(&env, args);
        assert_eq!(code, 0, "{args:?} {err}");
        assert_eq!(commands_only(&srv)[before], want);
    }
    for (args, err) in [
        (
            &["move-tab", "--at", "W1.P1.T1", "--next"][..],
            "move-tab: uuid 만 받는다 — 좌표·라벨은 거부한다 (list-workspace 의 uuid 컬럼 값을 쓴다)\n",
        ),
        (
            &["move-tab", "--at", "t"],
            "move-tab: 위치 지정이 정확히 하나 필요하다: --index · --prev · --next · --before · --after\n",
        ),
        (
            &["move-tab", "--at", "t", "--next", "--prev"],
            "move-tab: 위치 지정이 정확히 하나 필요하다: --index · --prev · --next · --before · --after\n",
        ),
        (
            &["move-tab", "--at", "t", "--ungroup"],
            "move-tab: --ungroup 은 move-window 의 것이다\n",
        ),
        (
            &["move-window", "--at", "w", "--to", "g", "--ungroup"],
            "move-window: --to 와 --ungroup 은 함께 쓸 수 없다\n",
        ),
        (
            &["move-group", "--at", "g", "--to", "x"],
            "move-group: 이 명령은 --to·--ungroup 을 받지 않는다\n",
        ),
        (
            &["move-window", "--at", "w", "--to", "g", "--next"],
            "move-window: --to 와 함께 쓰는 위치는 --index 하나뿐이다\n",
        ),
        (
            &["move-tab", "--at", "t", "--index", "x"],
            "move-tab: --index 는 정수다: x\n",
        ),
        (
            &["new-group", "--name", "n", "--tree", "bad"],
            "new-group: --tree 는 owner/repo#N 꼴이다: bad\n",
        ),
        (
            &["new-group"],
            "usage: otterctl new-group --name <이름> [--tree <owner/repo#N>]\n",
        ),
    ] {
        let got = ctl(&env, args);
        assert_eq!((got.0, got.2.as_str()), (2, err), "{args:?}");
    }
    let srv = TestServer::fixed(200, r#"{"delivered":1,"error":"범위 밖"}"#);
    let got = ctl(
        &srv.env(home.path()),
        &["move-tab", "--at", "t", "--index", "9"],
    );
    assert_eq!(
        (got.0, got.2.as_str()),
        (1, "otterctl: moveTab 실패: 범위 밖\n")
    );
}

#[test]
fn window_order_shared_vectors() {
    let vec: Value = serde_json::from_str(&read_testdata("window_order_vectors.json")).unwrap();
    let cases = vec["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let windows: Vec<otter_shared_workspace::WsWindow> =
            otter_gocompat::json::unmarshal(serde_json::to_vec(&c["windows"]).unwrap().as_slice())
                .unwrap();
        let got = window_positions(&windows);
        let want = c["want"].as_object().unwrap();
        assert_eq!(got.len(), want.len(), "{}", c["name"]);
        for (id, w) in want {
            let p = &got[id];
            assert_eq!(
                (p.container.as_str(), p.index, p.count),
                (
                    w[0].as_str().unwrap(),
                    w[1].as_i64().unwrap(),
                    w[2].as_i64().unwrap()
                ),
                "{} {id}",
                c["name"]
            );
        }
    }
}

// ── list-workspace 의 이름 규칙 ─────────────────────────

#[test]
fn list_workspace_fg_names_one_trip_or_settings() {
    let state = |with_setting: Option<bool>| {
        let mut s = json!({"tools":[{"id":"p1","pid":1,"fgName":"vim"}],
            "workspace":{"windows":[{"id":"w","name":"W","layout":{"type":"pane","id":"r","tabs":[{"id":"t","name":"Shell","toolId":"p1"}]}}]}});
        if let Some(v) = with_setting {
            s["fgTabNames"] = json!(v);
        }
        serde_json::to_vec(&s).unwrap()
    };
    let home = tmp();
    for (setting, settings_body, want_tab, want_reqs) in [
        (Some(true), "{}", "vim", 1),
        (Some(false), "{}", "Shell", 1),
        (None, r#"{"fgTabNames":false}"#, "Shell", 2),
        (None, r#"{"fgTabNames":null}"#, "vim", 2),
        (None, "bad", "vim", 2),
    ] {
        let body = state(setting);
        let sb = settings_body.as_bytes().to_vec();
        let srv = TestServer::new(move |r| {
            if r.path() == "/api/settings" {
                (200, sb.clone())
            } else {
                (200, body.clone())
            }
        });
        let (code, out, _) = ctl(&srv.env(home.path()), &["list-workspace"]);
        assert_eq!(code, 0);
        assert!(
            out.contains(&format!("tab=\"{want_tab}\"")),
            "{setting:?} {settings_body}: {out}"
        );
        assert_eq!(
            srv.requests().len(),
            want_reqs,
            "{setting:?} {settings_body}"
        );
    }
    assert!(match_fold("Hello World", "WORLD"));
    assert!(match_fold("x", ""));
    assert!(!match_fold("x", "y"));
}

#[test]
fn list_workspace_empty_and_filters() {
    let home = tmp();
    let srv = TestServer::fixed(200, r#"{"tools":[],"workspace":{"windows":[]}}"#);
    let env = srv.env(home.path());
    assert_eq!(
        ctl(&env, &["list-workspace"]),
        (0, "(no tools)\n".into(), String::new())
    );
    assert_eq!(
        ctl(&env, &["list-workspace", "--json"]),
        (0, "[]\n".into(), String::new())
    );
    assert_eq!(
        ctl(&env, &["list-workspace", "--tab", "x"]),
        (1, String::new(), "(no match)\n".into())
    );
    assert_eq!(
        ctl(&env, &["list-groups"]),
        (0, "(no groups)\n".into(), String::new())
    );
    assert_eq!(
        ctl(&env, &["list-groups", "--json"]),
        (0, "[]\n".into(), String::new())
    );
    let srv = TestServer::fixed(500, "boom");
    let got = ctl(&srv.env(home.path()), &["list-workspace"]);
    assert_eq!(
        (got.0, got.2.as_str()),
        (1, "otterctl: /api/state returned status 500: boom\n")
    );
}

// ── status · wait ────────────────────────────────────

#[test]
fn status_text_lines() {
    let home = tmp();
    let srv = TestServer::fixed(
        200,
        r#"{"toolId":"t1","live":true,"state":"idle","tool":"Bash","detail":"go test","quietMs":5,
"context":{"usedPct":57.25,"windowTokens":200000,"tokens":114000.5,"source":"statusline"},
"usage":{"model":{"id":"claude-x","displayName":"Opus"},"effort":"high","cost":{"totalCostUsd":1.235},
"rateLimits":{"seven_day":{"usedPct":40},"five_hour":{"usedPct":12.5},"x":{}}},
"member":{"id":"m1","state":"waiting-children"},
"limits":[{"agent":"claude","windows":[{"name":"five_hour","usedPct":34,"resetsInSec":7200},
{"name":"seven_day","usedPct":21.4,"resetsInSec":368000},{"name":"opus_week","usedPct":5},{"name":"none"}]}]}"#,
    );
    let (code, out, err) = ctl(&srv.env(home.path()), &["status", "--at", "t1"]);
    assert_eq!((code, err.as_str()), (0, ""));
    let mut want = String::new();
    want += "toolId=t1  live=true  state=idle  run_state=waiting-children  tool=Bash  detail=go test  quietMs=5\n";
    want += "context=57.2%  tokens=114000/200000  source=statusline\n";
    want += "model=Opus  effort=high  cost=$1.24  rate=five_hour:12%,seven_day:40%\n";
    want +=
        "claude 5h 34% (resets in 2h 0m)\nclaude 7d 21% (resets in 4d 6h)\nclaude opus_week 5%\n";
    assert_eq!(out, want);
    assert_eq!(srv.requests()[0].query("id").as_deref(), Some("t1"));

    let srv = TestServer::fixed(
        200,
        r#"{"toolId":"t","live":false,"liveUnknown":true,"state":"unknown","quietMs":-1}"#,
    );
    let (_, out, _) = ctl(&srv.env(home.path()), &["status"]);
    assert_eq!(out, "toolId=t  live=unknown  state=unknown  quietMs=-1\n");
    assert_eq!(srv.requests()[0].query("id").as_deref(), Some("self-tool"));
    let srv = TestServer::fixed(200, "{\"a\":1}\n\n");
    assert_eq!(
        ctl(&srv.env(home.path()), &["status", "--json"]).1,
        "{\"a\":1}\n"
    );

    for (sec, want) in [
        (368000.0, "4d 6h"),
        (7800.0, "2h 10m"),
        (2100.0, "35m"),
        (59.0, "0m"),
        (0.0, "soon"),
    ] {
        assert_eq!(limit_reset_text(sec), want);
    }
}

#[test]
fn wait_exit_codes_and_one_request() {
    let home = tmp();
    for (status, code, err) in [
        ("ready", 0, ""),
        ("done", 0, ""),
        (
            "timeout",
            4,
            "wait: 타임아웃 — 실패가 아니라 체크포인트다. 마지막 상태 state=working quietMs=7. 계속 기다리려면 다시 호출하라.\n",
        ),
        (
            "blocked",
            5,
            "wait: blocked — 에이전트가 입력을 기다린다(state=working). 시간이 지나도 풀리지 않으니 개입이 필요하다.\n",
        ),
        ("gone", 1, "wait: 대상 도구가 사라졌다 (toolId=t)\n"),
        ("odd", 1, "otterctl: unknown wait status: \"odd\"\n"),
    ] {
        let body = format!(
            r#"{{"toolId":"t","status":"{status}","state":"working","quietMs":7,"waitedMs":3}}"#
        );
        let srv = TestServer::fixed(200, &body);
        let got = ctl(
            &srv.env(home.path()),
            &["wait", "--at", "t", "--for", "done", "--timeout-ms", "50"],
        );
        assert_eq!((got.0, got.2.as_str()), (code, err), "{status}");
        assert_eq!(
            got.1,
            format!("status={status}  toolId=t  state=working  waitedMs=3\n")
        );
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path(), "/api/tools/activity/wait");
        assert_eq!(
            (reqs[0].query("for"), reqs[0].query("timeoutMs")),
            (Some("done".into()), Some("50".into()))
        );
    }
    // --member 는 preamble 로 도구 id 를 구한 뒤 같은 경로다.
    let srv = TestServer::new(|r| match r.path() {
        "/api/runs/preamble" => (200, br#"{"toolId":"tm","role":"dev"}"#.to_vec()),
        _ => (
            200,
            br#"{"toolId":"tm","status":"ready","reason":"turn","state":"idle","waitedMs":0}"#
                .to_vec(),
        ),
    });
    let got = ctl(
        &srv.env(home.path()),
        &["wait", "--member", "m1", "--for", "ready"],
    );
    assert_eq!(
        got.1,
        "status=ready  reason=turn  toolId=tm  state=idle  waitedMs=0\n"
    );
    assert_eq!(srv.requests()[0].query("member").as_deref(), Some("m1"));
    assert_eq!(srv.requests()[1].query("id").as_deref(), Some("tm"));
    let srv = TestServer::fixed(200, r#"{"role":"dev"}"#);
    let got = ctl(&srv.env(home.path()), &["status", "--member", "m1"]);
    assert_eq!(
        (got.0, got.2.as_str()),
        (1, "otterctl: 멤버 m1 (role=dev) 에 도구가 없다\n")
    );
}

// ── who-am-i · toolio · notify ────────────────────────

#[test]
fn who_am_i_text_and_json() {
    let home = tmp();
    let body = r#"{"toolId":"p1","shellPid":12,"label":"W1.P1.T1","uuid":"u-1","short":"u-1","sizeCols":80,"sizeRows":24,"window":"w","tab":"t","windowUuid":"wu","paneUuid":"pu","focused":true,"member":{"id":"m9","runId":"r"}}"#;
    let srv = TestServer::fixed(200, &format!("{body}\n"));
    let env = srv.env(home.path());
    let (code, out, _) = ctl(&env, &["who-am-i"]);
    assert_eq!(code, 0);
    assert_eq!(
        out,
        "▶ label=W1.P1.T1  uuid=u-1  short=u-1  toolId=p1  shellPid=12  size=80x24  window=\"w\"  tab=\"t\"  window_uuid=wu  pane_uuid=pu  member=m9\n"
    );
    assert_eq!(srv.requests()[0].target, "/api/whoami?toolId=self-tool");
    assert_eq!(ctl(&env, &["who-am-i", "--json"]).1, format!("{body}\n"));
}

#[test]
fn toolio_requests_and_output() {
    let home = tmp();
    let srv = TestServer::fixed(200, r#"{"text":"","dropped":0}"#);
    let env = srv.env(home.path());
    assert_eq!(ctl(&env, &["read-screen"]).1, "(출력 없음)\n");
    assert_eq!(ctl(&env, &["read-output", "-l", "x", "--bytes=0"]).1, "");
    let reqs = srv.requests();
    assert_eq!(
        reqs[0].target,
        "/api/tools/output?bytes=16384&id=self-tool&strip=1"
    );
    assert_eq!(reqs[1].target, "/api/tools/output?bytes=0&id=x");
    let srv = TestServer::fixed(200, r#"{"text":"a\nb","dropped":5}"#);
    assert_eq!(
        ctl(&srv.env(home.path()), &["read-screen"]).1,
        "dropped_bytes: 5\na\nb\n"
    );
    let got = ctl(&env, &["read-screen", "--bytes", "-1"]);
    assert_eq!(
        (got.0, got.2.as_str()),
        (2, "read-screen: --bytes 는 0 이상의 정수여야 한다: -1\n")
    );

    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let env = srv.env(home.path());
    let got = run_with(
        &env,
        crate::otterctl::run_otterctl,
        &["send-input", "--at", "t", "-x", "-"],
        "ls -la\n".as_bytes(),
    );
    assert_eq!(
        got.1,
        "입력 주입 완료: target=t textLen=7 모드=paste + 자동 엔터\n"
    );
    assert_eq!(
        srv.requests()[0].json(),
        json!({"id":"t","text":"ls -la\n","execute":true})
    );
    let got = ctl(&env, &["send-input", "a", "b"]);
    assert_eq!(
        got.1,
        "입력 주입 완료: target=self-tool textLen=3 모드=타이핑만 (엔터 대기)\n"
    );
    let got = run_with(&env, crate::otterctl::run_otterctl, &["send-input"], b"");
    assert_eq!(
        (got.0, got.2.as_str()),
        (
            2,
            "send-input: 본문이 비었다 — 인자로 주거나 stdin 으로 넘겨라\n"
        )
    );

    let srv = TestServer::fixed(
        200,
        r#"{"toolId":"x","from":"self-tool","to":"u2","len":5}"#,
    );
    let env = srv.env(home.path());
    let got = ctl(&env, &["msg", "--to", "u2", "안녕"]);
    assert_eq!(
        got.1,
        "에이전트 메시지 전송 완료: from=self-tool → to=u2, 본문 5 자\n"
    );
    assert_eq!(
        srv.requests()[0].json(),
        json!({"to":"u2","from":"self-tool","message":"안녕"})
    );
    let got = ctl(&env, &["msg", "hi"]);
    assert_eq!(
        (got.0, got.2.as_str()),
        (
            2,
            "usage: otterctl msg --to <uuid> [--from <uuid>] <메시지>\n"
        )
    );
    let srv = TestServer::fixed(404, r#"{"error":"tool not found"}"#);
    let got = ctl(&srv.env(home.path()), &["msg", "--to", "u2", "x"]);
    assert_eq!((got.0, got.2.as_str()), (1, "otterctl: tool not found\n"));
}

#[test]
fn notify_posts_and_sanitizes() {
    let home = tmp();
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let env = srv.env(home.path());
    assert_eq!(
        ctl(&env, &["notify", "done"]),
        (0, String::new(), String::new())
    );
    assert_eq!(ctl(&env, &["notify"]).0, 0);
    let reqs = srv.requests();
    assert_eq!(
        (reqs[0].path(), reqs[0].json()),
        (
            "/api/tools/attention/set",
            json!({"toolId":"self-tool","reason":"done"})
        )
    );
    assert_eq!(reqs[1].json()["reason"], "attention");
    let mut no_tool = Env::with_vars([("X", "y")]);
    no_tool.fallback_home = env.fallback_home.clone();
    let got = ctl(&no_tool, &["notify"]);
    assert_eq!(
        (got.0, got.2.as_str()),
        (
            1,
            "otterctl notify: OTTERMINAL_TOOL_ID 미설정 (otterminal tool 안에서 실행해야 함)\n"
        )
    );
    assert_eq!(sanitize_notify_label("a\x01b\x7fc"), "abc");
    assert_eq!(sanitize_notify_label("\x01"), "attention");
    assert_eq!(sanitize_notify_label(&"x".repeat(80)), "x".repeat(64));
    assert_eq!(
        sanitize_notify_label(&format!("{}가", "x".repeat(63))),
        format!("{}\u{FFFD}", "x".repeat(63))
    );
}

#[test]
fn notify_goes_to_report_socket_first() {
    let home = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
    let sock = otter_shared_agentrec::socket_path(home.path());
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let ln = otter_shared_platform::current().ipc.listen(&sock).unwrap();
    let got = std::thread::spawn(move || {
        let mut c = ln.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&mut c).read_line(&mut line).unwrap();
        let _ = c.write_all(b"{\"ok\":true}\n");
        line
    });
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let mut env = srv.env(home.path());
    env.set(
        otter_shared_otterenv::ENV_HOME,
        home.path().to_str().unwrap(),
    );
    assert_eq!(ctl(&env, &["notify", "waiting"]).0, 0);
    assert_eq!(
        got.join().unwrap(),
        "{\"method\":\"report.notify\",\"body\":{\"reason\":\"waiting\",\"toolId\":\"self-tool\"}}\n"
    );
    assert!(
        srv.requests().is_empty(),
        "소켓이 받았으면 HTTP 로 보내지 않는다"
    );
}
