use std::cell::RefCell;

use super::fake_http::{FakeServer, dead_port};
use super::{Vars, args, temp_home, with_env};
use crate::window::run_window_in;
use crate::{Common, DEFAULT_HOST, ParseError, WindowOpts, help, parse_window, usage};

fn run(port: &str, open: &dyn Fn(&str) -> Result<(), String>) -> (i32, String, String) {
    let (_d, home) = temp_home();
    let o = WindowOpts {
        common: Common {
            port: port.to_owned(),
            home: String::new(),
        },
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(&Vars::home(&home), |env| {
        run_window_in(&o, env, open, &mut out, &mut err)
    });
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

// V-WIN-3: 준비된 서버가 있으면 그 주소로 정확히 한 번 연다.
#[test]
fn opens_running_server() {
    let srv = FakeServer::start(200, "");
    let got = RefCell::new(Vec::new());
    let (code, out, err) = run(&srv.port, &|u| {
        got.borrow_mut().push(u.to_owned());
        Ok(())
    });
    assert_eq!(code, 0, "{err}");
    let want = otter_shared_otterenv::base_url(DEFAULT_HOST, &srv.port);
    assert_eq!(*got.borrow(), vec![want.clone()]);
    assert_eq!(out, format!("✅ 창을 열었습니다 — {want}\n"));
}

// V-WIN-2: 서버가 없으면 열지 않고 실패한다.
#[test]
fn no_server() {
    let port = dead_port();
    let opened = RefCell::new(0);
    let (code, out, err) = run(&port, &|_| {
        *opened.borrow_mut() += 1;
        Ok(())
    });
    assert_eq!(code, 1);
    assert_eq!(*opened.borrow(), 0);
    assert_eq!(out, "");
    assert_eq!(
        err,
        format!(
            "❌ http://127.0.0.1:{port} 에서 응답이 없습니다 — 서버가 떠 있지 않습니다\n   먼저 띄웁니다: otterminal start\n"
        )
    );
}

// V-WIN-4: 창이 이 명령의 본체다 — 열지 못하면 실패다.
#[test]
fn open_fails() {
    let srv = FakeServer::start(200, "");
    let (code, _, err) = run(&srv.port, &|_| Err("브라우저 없음".to_owned()));
    assert_eq!(code, 1);
    assert_eq!(err, "❌ 창을 열지 못했습니다: 브라우저 없음\n");
}

// 대상을 정하지 못하면 두드리지 않는다.
#[test]
fn bad_target_fails_before_ping() {
    let (code, _, err) = run("0", &|_| panic!("열면 안 된다"));
    assert_eq!(code, 1);
    assert!(!err.is_empty());
}

// V-WIN-1
#[test]
fn parse() {
    let o = parse_window(&args(&["--port", "1234", "--home", "/tmp/x"])).unwrap();
    assert_eq!(
        (o.common.port.as_str(), o.common.home.as_str()),
        ("1234", "/tmp/x")
    );
    assert!(parse_window(&args(&["--nope"])).is_err());
    assert_eq!(parse_window(&args(&["--help"])), Err(ParseError::Help));
}

// V-WIN-7
#[test]
fn help_surfaces() {
    assert!(usage("window").contains("otterminal window"));
    assert!(help().contains("window"));
}
