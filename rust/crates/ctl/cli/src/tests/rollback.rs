//! rollback_test.go·homefiles_test.go — 되돌릴 길이 있다 (G3-2·G4-4).

use std::path::Path;

use otter_shared_otterenv as otterenv;

#[cfg(unix)]
use super::proc::live_socket;
use super::{Vars, with_env};
use crate::homelayout::home_layout;
use crate::rollback::{DEFAULT_ROLLBACK_TARGET, RollbackOpts, rollback_targets, run_rollback_in};

fn seed(home: &Path, name: &str, body: &str) {
    std::fs::write(home.join(name), body).unwrap();
}

fn run(home: &Path, o: &RollbackOpts) -> (i32, String, String) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = with_env(&Vars::home(home), |env| {
        run_rollback_in(o, env, &mut out, &mut err)
    });
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn gen_opts(file: &str, n: i64) -> RollbackOpts {
    RollbackOpts {
        gen_no: n,
        file: file.to_owned(),
        ..RollbackOpts::default()
    }
}

#[test]
fn list_shows_generations() {
    let d = tempfile::tempdir().unwrap();
    seed(
        d.path(),
        "workspace.json",
        r#"{"schemaVersion":2,"windows":[]}"#,
    );
    seed(
        d.path(),
        "workspace.json.bak.1",
        r#"{"schemaVersion":2,"windows":[{"id":"a"}]}"#,
    );
    let (code, out, _) = run(d.path(), &RollbackOpts::default());
    assert_eq!(code, 0, "{out}");
    assert!(
        out.starts_with(
            "되돌릴 수 있는 세대 (workspace.json):\n  1  workspace.json.bak.1  42 bytes  "
        ),
        "{out}"
    );
    assert!(!out.contains(".bak.2"), "{out}");
    assert!(
        out.ends_with("\n\n되돌리려면: otterminal rollback --gen <번호>\n"),
        "{out}"
    );
}

#[test]
fn list_empty() {
    let d = tempfile::tempdir().unwrap();
    let (code, out, _) = run(d.path(), &RollbackOpts::default());
    assert_eq!(code, 0);
    assert_eq!(
        out,
        "되돌릴 수 있는 세대 (workspace.json):\n  (없음 — 아직 덮어쓴 적이 없거나 세대가 지워졌습니다)\n"
    );
}

// 되돌리면 그 세대가 현재 판이 되고, 직전 현재 판은 옆에 남는다.
#[test]
fn restores_generation() {
    let d = tempfile::tempdir().unwrap();
    let want = r#"{"schemaVersion":2,"windows":[{"id":"a"}]}"#;
    seed(
        d.path(),
        "workspace.json",
        r#"{"schemaVersion":2,"windows":[]}"#,
    );
    seed(d.path(), "workspace.json.bak.1", want);
    let (code, out, err) = run(d.path(), &gen_opts("", 1));
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        std::fs::read_to_string(d.path().join("workspace.json")).unwrap(),
        want
    );
    let kept: Vec<String> = std::fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("workspace.json.before-rollback-"))
        .collect();
    assert_eq!(kept.len(), 1, "되돌리기 전의 판이 남지 않았다");
    // 20060102T150405Z
    let stamp = kept[0].trim_start_matches("workspace.json.before-rollback-");
    assert_eq!(stamp.len(), 16, "{stamp}");
    assert!(
        stamp.ends_with('Z') && stamp.as_bytes()[8] == b'T',
        "{stamp}"
    );
    assert_eq!(
        out,
        format!(
            "지금 판을 {} 로 남겼습니다\n✅ workspace.json 를 세대 1 로 되돌렸습니다\n",
            kept[0]
        )
    );
}

// 서버가 돌고 있으면 거부한다.
#[cfg(unix)]
#[test]
fn refuses_while_server_runs() {
    let d = tempfile::tempdir().unwrap();
    seed(d.path(), "workspace.json", "{}");
    seed(d.path(), "workspace.json.bak.1", "{}");
    let _s = live_socket(d.path());
    let (code, out, err) = run(d.path(), &gen_opts("", 1));
    assert_eq!(code, 1, "{out}");
    assert_eq!(
        err,
        "이 홈에서 otterminald 가 돌고 있습니다.\n되돌리기 전에 `otterminal stop --all` 로 내려 주세요 (터미널 세션을 잃습니다).\n"
    );
}

#[cfg(unix)]
#[test]
fn rejects_missing_generation() {
    let d = tempfile::tempdir().unwrap();
    seed(d.path(), "workspace.json", "{}");
    let (code, _, err) = run(d.path(), &gen_opts("", 2));
    assert_eq!(code, 1);
    assert_eq!(
        err,
        format!(
            "세대 2 를 읽을 수 없습니다: open {}/workspace.json.bak.2: no such file or directory\n",
            d.path().display()
        )
    );
}

#[test]
fn covers_settings() {
    let d = tempfile::tempdir().unwrap();
    let want = r#"{"themeName":"dark"}"#;
    seed(d.path(), "settings.json", r#"{"themeName":"imported"}"#);
    seed(d.path(), "settings.json.bak.1", want);
    let (code, out, err) = run(d.path(), &gen_opts("settings.json", 1));
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(
        std::fs::read_to_string(d.path().join("settings.json")).unwrap(),
        want
    );
}

// 임의 경로는 받지 않는다.
#[test]
fn rejects_arbitrary_file() {
    let d = tempfile::tempdir().unwrap();
    let (code, _, err) = run(d.path(), &gen_opts("../../etc/passwd", 1));
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "되돌릴 수 있는 대상이 아닙니다: \"../../etc/passwd\" (가능: [workspace.json settings.json access.json runs.json tools.json])\n"
    );
}

// FR-OPT-10-2 (SHR-19): 목록은 표에서 파생한다.
#[test]
fn targets_from_layout() {
    let mut want = Vec::new();
    for e in home_layout() {
        if e.rollback {
            assert!(
                !e.is_dir && e.in_backup,
                "{}: 되돌리기 대상은 백업에 담기는 파일이어야 한다",
                e.name
            );
            want.push(e.name);
        }
    }
    assert_eq!(rollback_targets(), want);
    assert_eq!(
        want,
        [
            "workspace.json",
            "settings.json",
            "access.json",
            "runs.json",
            "tools.json"
        ]
    );
    assert_eq!(DEFAULT_ROLLBACK_TARGET, otterenv::WORKSPACE_FILE);
}
