use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::*;
use crate::codec::{read_frame, write_frame};
use crate::service::{OpenError, PathsError};

#[test]
fn frames_both_ways() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
    let mut e = next_end(&ends);
    let body = r#"{"jsonrpc":"2.0","method":"x","params":"한글"}"#.as_bytes();
    tn.send(body).unwrap();
    assert_eq!(read_frame(&mut e.input).unwrap(), body);
    let back = r#"{"jsonrpc":"2.0","id":1,"result":"값"}"#.as_bytes();
    e.write_frame(back);
    assert_eq!(tn.recv().unwrap(), back);
    svc.shutdown();
}

#[test]
fn recv_splits_coalesced_frames() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
    let e = next_end(&ends);
    let (a, b) = (r#"{"a":"가"}"#, r#"{"b":2}"#);
    let raw = format!(
        "Content-Length: {}\r\n\r\n{a}Content-Length: {}\r\n\r\n{b}",
        a.len(),
        b.len()
    );
    std::io::Write::write_all(e.out.lock().unwrap().as_mut().unwrap(), raw.as_bytes()).unwrap();
    for want in [a, b] {
        assert_eq!(tn.recv().unwrap(), want.as_bytes());
    }
    svc.shutdown();
}

#[test]
fn close_stops_process() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
    let e = next_end(&ends);
    tn.close();
    tn.close();
    e.wait_stopped("Close 뒤에도 프로세스가 남았다");
    assert!(tn.recv().is_err(), "닫힌 통로의 Recv 가 오류가 아니다");
    assert!(tn.send(b"{}").is_err());
}

#[test]
fn process_exit_ends_recv() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
    next_end(&ends).close_out();
    assert_eq!(tn.recv().unwrap_err().to_string(), "EOF");
    svc.shutdown();
}

#[test]
fn limit_rejects_without_starting() {
    let (start, ends, n) = pipe_starter();
    let (_d, mut svc) = go_tunnel_svc(start);
    svc.max_sessions = 2;
    let mut open = Vec::new();
    for _ in 0..2 {
        open.push(svc.open_tunnel("/root", "gopls/gopls").unwrap());
        next_end(&ends);
    }
    let e = svc.open_tunnel("/root", "gopls/gopls").err().unwrap();
    assert_eq!(e, OpenError::Limit);
    assert_eq!(e.to_string(), "lsp: 동시 실행 상한");
    assert_eq!(*n.lock().unwrap(), 2, "거절된 통로가 프로세스를 띄웠다");
    open[0].close();
    assert!(
        svc.open_tunnel("/root", "gopls/gopls").is_ok(),
        "닫은 뒤에도 자리가 나지 않았다"
    );
    svc.shutdown();
}

fn fake_clock(svc: &mut Service) -> Arc<Mutex<SystemTime>> {
    let now = Arc::new(Mutex::new(UNIX_EPOCH + Duration::from_secs(1000)));
    let c = Arc::clone(&now);
    svc.now = Some(Arc::new(move || *c.lock().unwrap()));
    now
}

#[test]
fn idle_sweep() {
    let (start, ends, _) = pipe_starter();
    let (_d, mut svc) = go_tunnel_svc(start);
    let now = fake_clock(&mut svc);
    let advance = |d: u64| *now.lock().unwrap() += Duration::from_secs(d);
    svc.idle_after = Duration::from_secs(60);
    let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
    let mut e = next_end(&ends);
    advance(50);
    tn.send(b"{}").unwrap();
    read_frame(&mut e.input).unwrap();
    advance(50);
    e.write_frame(b"{}");
    tn.recv().unwrap();
    advance(50);
    svc.sweep();
    assert!(
        e.stopped.try_recv().is_err(),
        "프레임이 오간 통로를 Sweep 이 닫았다"
    );
    assert_eq!(tn.last_use(), UNIX_EPOCH + Duration::from_secs(1100));
    advance(120);
    svc.sweep();
    e.wait_stopped("유휴 통로를 Sweep 이 닫지 않았다");
    assert!(svc.open_tunnel("/root", "gopls/gopls").is_ok());
    svc.shutdown();
}

#[test]
fn shutdown_closes_tunnels() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    svc.open_tunnel("/root", "gopls/gopls").unwrap();
    let e = next_end(&ends);
    svc.shutdown();
    e.wait_stopped("Shutdown 뒤에도 통로 프로세스가 남았다");
}

#[test]
fn unknown_or_missing_server() {
    let (start, _ends, n) = pipe_starter();
    let (_d, svc) = svc_with(Some(start), &[]);
    let msg = |id: &str| svc.open_tunnel("/root", id).err().unwrap().to_string();
    assert_eq!(msg("nope/nope"), r#"모르는 언어 서버입니다: "nope/nope""#);
    assert_eq!(
        msg("gopls/gopls"),
        "gopls 가 없어 코드 탐색을 할 수 없습니다 — go 가 이 기계에 없어 받을 수 없습니다 — go 를 먼저 설치하세요 (설정 ▸ Code)"
    );
    assert_eq!(msg(""), r#"모르는 언어 서버입니다: """#);
    assert_eq!(*n.lock().unwrap(), 0);
    assert_eq!(
        svc.open_tunnel("", "gopls/gopls")
            .err()
            .unwrap()
            .to_string(),
        "루트가 없습니다"
    );
    let bare = Service::new(None);
    assert_eq!(
        bare.open_tunnel("/r", "a/b").err().unwrap().to_string(),
        "플러그인 계층이 배선되지 않았습니다"
    );
}

#[test]
fn start_failure_text() {
    let (_d, mut svc) = go_tunnel_svc(Arc::new(|_, _, _| Err(std::io::Error::other("boom"))));
    svc.max_sessions = 1;
    let e = svc.open_tunnel("/root", "gopls/gopls").err().unwrap();
    assert_eq!(e.to_string(), "lsp: gopls/gopls 를 띄우지 못했습니다: boom");
    assert!(
        svc.open_tunnel("/root", "gopls/gopls")
            .is_err_and(|e| e != OpenError::Limit),
        "실패한 열기가 자리를 쥐었다"
    );
}

#[test]
fn set_paths_closes_tunnels_of_changed_desc() {
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let (_t, base) = tmp();
    let gotn = svc.open_tunnel(&base, "gopls/gopls").unwrap();
    let ge = next_end(&ends);
    let p = |n: &str| filepath::join(&[base.as_str(), n]);
    svc.set_paths(&HashMap::from([(
        "typescript/typescript-language-server".to_owned(),
        p("tsls"),
    )]))
    .unwrap();
    assert!(
        ge.stopped.recv_timeout(Duration::from_millis(100)).is_err(),
        "바뀌지 않은 서술자의 통로가 닫혔다"
    );
    svc.set_paths(&HashMap::from([("gopls/gopls".to_owned(), p("gopls"))]))
        .unwrap();
    ge.wait_stopped("경로가 바뀐 서술자의 통로가 닫히지 않았다");
    assert!(gotn.recv().is_err());
}

/// NFR-CMR-5: 열기 + initialize 왕복의 통로 몫 중앙값이 25ms 안이다.
#[test]
fn nfr5_tunnel_overhead() {
    const RUNS: usize = 20;
    let init = br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#;
    let reply = br#"{"jsonrpc":"2.0","id":0,"result":{"capabilities":{}}}"#;
    let (start, ends, _) = pipe_starter();
    let (_d, svc) = go_tunnel_svc(start);
    let ends = Arc::new(Mutex::new(ends));
    let mut took = Vec::new();
    for _ in 0..RUNS {
        let ends = Arc::clone(&ends);
        let srv = thread::spawn(move || {
            let mut e = ends.lock().unwrap().recv().unwrap();
            if read_frame(&mut e.input).is_ok_and(|b| b == init) {
                e.write_frame(reply);
            }
            e
        });
        let t0 = Instant::now();
        let tn = svc.open_tunnel("/root", "gopls/gopls").unwrap();
        tn.send(init).unwrap();
        assert_eq!(tn.recv().unwrap(), reply);
        took.push(t0.elapsed());
        tn.close();
        drop(srv.join());
    }
    took.sort();
    assert!(
        took[RUNS / 2] <= Duration::from_millis(25),
        "중앙값 {:?}",
        took[RUNS / 2]
    );
}

#[test]
fn paths_set_validates_persists_and_status_uses_it() {
    let (_d, svc) = svc_with(
        None,
        &[
            ("gopls", "/fake/gopls"),
            ("typescript-language-server", "/fake/tsls"),
        ],
    );
    let (_t, dir) = tmp();
    let file = filepath::join(&[dir.as_str(), "lsp-paths.json"]);
    svc.load_paths(&file).unwrap();
    let set = |k: &str, v: &str| svc.set_paths(&HashMap::from([(k.to_owned(), v.to_owned())]));
    assert!(set("nope/nope", "/x").unwrap().is_empty());
    assert_eq!(
        set("gopls/gopls", "rel/gopls").unwrap_err(),
        PathsError::NotAbsolute("rel/gopls".to_owned())
    );
    assert_eq!(
        PathsError::NotAbsolute("rel".into()).to_string(),
        r#"lsp: 절대경로가 아니다: "rel""#
    );
    let abs = filepath::join(&[dir.as_str(), "my-gopls"]);
    std::fs::write(&abs, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&abs, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert_eq!(set("gopls/gopls", &abs).unwrap()["gopls/gopls"], abs);
    let raw = std::fs::read_to_string(&file).unwrap();
    let want = format!(
        "{{\n  \"paths\": {{\n    \"gopls/gopls\": {}\n  }}\n}}",
        otter_gocompat::strconv::quote(&abs)
    );
    assert_eq!(raw, want, "파일 모양이 Go MarshalIndent 와 다르다");
    let (sts, _) = svc.status();
    assert!(
        sts.iter().any(|s| s.id == "gopls" && s.exe == abs),
        "상태가 경로 표를 쓰지 않았다"
    );
    let (_d2, svc2) = svc_with(None, &[]);
    svc2.load_paths(&file).unwrap();
    assert_eq!(svc2.paths()["gopls/gopls"], abs);
    assert!(set("gopls/gopls", "").unwrap().is_empty());
}

#[test]
fn load_paths_ignores_non_absolute_and_bad_json() {
    let (_t, dir) = tmp();
    let abs = filepath::join(&[dir.as_str(), "my-gopls"]);
    let file = filepath::join(&[dir.as_str(), "lsp-paths.json"]);
    let body = format!(
        r#"{{"paths":{{"gopls/gopls":{},"typescript/typescript-language-server":"rel/tsls"}}}}"#,
        otter_gocompat::strconv::quote(&abs)
    );
    std::fs::write(&file, body).unwrap();
    let (_d, svc) = svc_with(None, &[]);
    svc.load_paths(&file).unwrap();
    assert_eq!(
        svc.paths(),
        HashMap::from([("gopls/gopls".to_owned(), abs)])
    );
    std::fs::write(&file, "{").unwrap();
    assert!(
        svc.load_paths(&file)
            .unwrap_err()
            .starts_with(&format!("{file}: "))
    );
}

#[test]
fn set_paths_drops_unknown_keys() {
    let (_d, svc) = svc_with(None, &[]);
    let (_t, dir) = tmp();
    let file = filepath::join(&[dir.as_str(), "lsp-paths.json"]);
    svc.load_paths(&file).unwrap();
    let abs = filepath::join(&[dir.as_str(), "my-gopls"]);
    let got = svc
        .set_paths(&HashMap::from([
            ("gopls/gopls".to_owned(), abs.clone()),
            ("gone/gone".to_owned(), "/x".to_owned()),
        ]))
        .unwrap();
    assert_eq!(got, HashMap::from([("gopls/gopls".to_owned(), abs)]));
    assert!(
        !std::fs::read_to_string(&file)
            .unwrap()
            .contains("gone/gone")
    );
}

#[test]
fn set_paths_concurrent_put_persists_same_as_memory() {
    let (_d, svc) = svc_with(None, &[]);
    let (_t, dir) = tmp();
    let file = filepath::join(&[dir.as_str(), "lsp-paths.json"]);
    svc.load_paths(&file).unwrap();
    let svc = Arc::new(svc);
    for round in 0..30 {
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let svc = Arc::clone(&svc);
                let p = filepath::join(&[dir.as_str(), &format!("gopls-{round}-{i}")]);
                thread::spawn(move || {
                    svc.set_paths(&HashMap::from([("gopls/gopls".to_owned(), p)]))
                        .unwrap()
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let raw = std::fs::read_to_string(&file).unwrap();
        let mem = svc.paths()["gopls/gopls"].clone();
        assert!(
            raw.contains(&otter_gocompat::strconv::quote(&mem)),
            "round {round}: 디스크 {raw} ≠ 메모리 {mem}"
        );
    }
}

#[test]
fn paths_set_does_not_locate() {
    let (_d, root) = tmp();
    let dir = ext::plugin_dir(&root, "gopls");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(filepath::join(&[dir.as_str(), ext::MANIFEST_NAME]), GO_PACK).unwrap();
    let looks = Arc::new(Mutex::new(0));
    let l = Arc::clone(&looks);
    let e = ext::Service::with(
        &root,
        Arc::new(move |_| {
            *l.lock().unwrap() += 1;
            None
        }),
        Arc::new(ext::HttpFetch),
        Arc::new(ext::HostExec),
    );
    let svc = Service::new(Some(Arc::new(e)));
    let abs = if cfg!(windows) {
        r"C:\opt\gopls"
    } else {
        "/opt/gopls"
    };
    svc.set_paths(&HashMap::from([("gopls/gopls".to_owned(), abs.to_owned())]))
        .unwrap();
    assert_eq!(*looks.lock().unwrap(), 0, "경로를 고치는 데 탐색했다");
}

#[cfg(unix)]
#[test]
fn start_process_stop_kills_process_group() {
    let (_t, dir) = tmp();
    let args = ["-c".to_owned(), "sleep 30 & echo $!; wait".to_owned()];
    let conn = crate::process::start_process("sh", &args, &dir).unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut BufReader::new(conn.reader), &mut line).unwrap();
    let child: i32 = line.trim().parse().unwrap();
    let p = otter_shared_platform::current().process;
    (conn.stop)();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !p.alive(child) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = p.kill(child);
    panic!("정지 뒤에도 자식 {child} 가 살아 있다");
}

#[test]
fn write_frame_to_tunnel_reader_roundtrip() {
    let mut buf = Vec::new();
    write_frame(
        &mut buf,
        br#"{"jsonrpc":"2.0","id":7,"method":"textDocument/definition"}"#,
    )
    .unwrap();
    let got = read_frame(&mut BufReader::new(std::io::Cursor::new(buf))).unwrap();
    assert_eq!(
        got,
        br#"{"jsonrpc":"2.0","id":7,"method":"textDocument/definition"}"#
    );
}
