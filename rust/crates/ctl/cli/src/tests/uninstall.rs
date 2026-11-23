use std::collections::HashSet;
use std::path::Path;

use super::{Vars, args, with_env};
use crate::home_layout;
use crate::parse_uninstall;
use crate::uninstall::{run_uninstall_in, uninstall_plan};

fn run(home: &Path, a: &[&str]) -> (i32, String, String) {
    let o = parse_uninstall(&args(a)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(&Vars::home(home), |env| {
        run_uninstall_in(&o, env, &mut out, &mut err)
    });
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn touch(home: &Path, names: &[&str]) {
    for n in names {
        std::fs::write(home.join(n), "x").unwrap();
    }
}

// --dry-run 은 지우지 않는다. 목록만 낸다.
#[test]
fn dry_run_touches_nothing() {
    let d = tempfile::tempdir().unwrap();
    let names = ["workspace.json", "settings.json", "server.log"];
    touch(d.path(), &names);
    let (code, out, err) = run(d.path(), &["--dry-run"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out,
        format!(
            "홈: {}\n\n지울 항목 1개:\n   {:<24} 웹 서버 로그\n\n남기는 항목 2개 (되살릴 수 있는 상태):\n  workspace.json · settings.json\n  전부 지우려면: --purge\n\n(--dry-run — 아무것도 지우지 않았습니다)\n",
            d.path().display(),
            "server.log"
        )
    );
    for n in names {
        assert!(d.path().join(n).exists(), "{n}");
    }
}

// --yes 없이 부르면 확인을 요구한다.
#[test]
fn requires_confirmation() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), &["workspace.json", "server.log"]);
    let (code, _, err) = run(d.path(), &[]);
    assert_eq!(code, 1);
    assert!(d.path().join("server.log").exists());
    assert!(err.contains("--yes"));
}

#[test]
fn yes_removes_plan_and_keeps_state() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), &["workspace.json", "server.log"]);
    std::fs::create_dir_all(d.path().join("bin").join("x")).unwrap();
    let (code, out, _) = run(d.path(), &["--yes"]);
    assert_eq!(code, 0);
    assert!(out.ends_with("\n✅ 2개를 지웠습니다.\n   설정과 배치는 남아 있습니다 — 다시 설치하면 그대로 돌아옵니다.\n"), "{out}");
    assert!(d.path().join("workspace.json").exists());
    assert!(!d.path().join("server.log").exists());
    assert!(!d.path().join("bin").exists());
}

#[test]
fn empty_home_has_nothing_to_remove() {
    let d = tempfile::tempdir().unwrap();
    let (code, out, _) = run(d.path(), &["--yes"]);
    assert_eq!(code, 0);
    assert!(out.ends_with("지울 것이 없습니다 — 홈이 비었거나 이미 제거됐습니다.\n"));
}

// D-STR-4: 사용자 worktree 는 맨 uninstall 이 남기고, --purge 는 지운다.
#[test]
fn user_worktrees_survive_plain_uninstall() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("git-worktrees").join("feature-x")).unwrap();
    std::fs::write(d.path().join("ext"), "x").unwrap();
    let home = d.path().to_str().unwrap();
    let plain: HashSet<_> = uninstall_plan(home, false)
        .iter()
        .map(|i| i.entry.name)
        .collect();
    assert!(!plain.contains("git-worktrees"));
    assert!(plain.contains("ext"));
    assert!(
        uninstall_plan(home, true)
            .iter()
            .any(|i| i.entry.name == "git-worktrees")
    );
}

// TC-DSY-14: 맨 uninstall 은 보존하기로 한 것만 남기고, --purge 는 전부 가져간다.
#[test]
fn keep_set_matches_layout() {
    let d = tempfile::tempdir().unwrap();
    for e in home_layout() {
        let p = d.path().join(e.name);
        if e.is_dir {
            std::fs::create_dir_all(p).unwrap();
        } else {
            std::fs::write(p, "x").unwrap();
        }
    }
    let home = d.path().to_str().unwrap();
    let planned: HashSet<_> = uninstall_plan(home, false)
        .iter()
        .map(|i| i.entry.name)
        .collect();
    let all: HashSet<_> = uninstall_plan(home, true)
        .iter()
        .map(|i| i.entry.name)
        .collect();
    for e in home_layout() {
        assert_ne!(planned.contains(e.name), e.keep_on_uninstall, "{}", e.name);
        assert!(all.contains(e.name), "{}", e.name);
    }
}
