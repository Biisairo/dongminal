use super::fake_http::FakeServer;
use super::{Vars, args, temp_home, with_env};
use crate::migrate::run_migrate_in;
use crate::parse_migrate;

fn run(v: &Vars, a: &[&str]) -> (i32, String, String) {
    let o = parse_migrate(&args(a)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(v, |env| run_migrate_in(&o, env, &mut out, &mut err));
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[test]
fn empty_home_has_nothing() {
    let (_d, home) = temp_home();
    let (code, out, err) = run(&Vars::home(&home), &["--port", "60201"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out,
        format!("마이그레이션 대상 없음 ({})\n", home.display())
    );
}

// 서버가 응답하면 변환을 거부하고, 겨냥한 서버를 정지하는 명령을 그대로 알린다.
#[test]
fn refuses_while_server_answers() {
    let (_d, home) = temp_home();
    let srv = FakeServer::start(200, "");
    let (code, out, err) = run(&Vars::home(&home), &["--port", &srv.port]);
    assert_eq!(code, 1);
    assert_eq!(out, "");
    assert_eq!(
        err,
        format!(
            "❌ otterminal 이 포트 {p} 에서 실행 중입니다 — 변환하지 않았습니다.\n   서버와 데몬을 완전히 정지한 뒤 다시 실행하세요:\n     otterminal stop --all --port {p} --home {h}\n",
            p = srv.port,
            h = home.display()
        )
    );
}

// --dry-run 은 서버가 떠 있어도 돈다 — 파일을 건드리지 않으므로.
#[test]
fn dry_run_ignores_running_server() {
    let (_d, home) = temp_home();
    let srv = FakeServer::start(200, "");
    let (code, out, _) = run(&Vars::home(&home), &["--dry-run", "--port", &srv.port]);
    assert_eq!(code, 0);
    assert!(out.starts_with("마이그레이션 대상 없음"));
}
