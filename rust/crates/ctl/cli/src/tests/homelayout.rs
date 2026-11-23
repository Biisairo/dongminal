use std::collections::HashSet;

use crate::homelayout::{DAEMON_PID_FILE, DAEMON_SOCK_FILE, TOOL_HOME_DIR};
use crate::logcap::HOME_LOGS;
use crate::{home_layout, usage_backup, usage_uninstall};

// M5 G4-3·G3-4: 홈의 구성은 한 곳에서 선언된다.
#[test]
fn covers_known_files() {
    let mut names = HashSet::new();
    for e in home_layout() {
        assert!(names.insert(e.name), "두 번 나온다: {}", e.name);
        assert!(!e.what.is_empty(), "{} 에 설명이 없다", e.name);
    }
    for n in HOME_LOGS {
        assert!(names.contains(n), "로그 {n} 가 표에 없다");
    }
}

#[test]
fn backup_excludes_ephemeral() {
    let in_backup = |n: &str| home_layout().iter().any(|e| e.name == n && e.in_backup);
    for e in home_layout() {
        assert!(!(e.in_backup && e.ephemeral), "{}", e.name);
    }
    for n in [
        DAEMON_SOCK_FILE,
        DAEMON_PID_FILE,
        "server.log",
        "daemon.log",
    ] {
        assert!(!in_backup(n), "{n}");
    }
    for n in ["workspace.json", "settings.json", "access.json"] {
        assert!(in_backup(n), "{n}");
    }
}

// FR-STR-30: 코드에서 파생해 찾은 열하나가 표에 있다.
#[test]
fn has_derived_entries() {
    let names: HashSet<_> = home_layout().iter().map(|e| e.name).collect();
    for n in [
        "git-worktrees",
        "panes.json",
        "worktrees",
        "ext",
        "cache",
        TOOL_HOME_DIR,
        "doctor",
        "doctor-tools",
        "doctor-probe.txt",
        "verify-too-large.bin",
    ] {
        assert!(names.contains(n), "{n}");
    }
}

// FR-DSY-61: 두 물음의 답이 오늘은 같다.
#[test]
fn two_questions_agree_today() {
    let mut n = 0;
    for e in home_layout() {
        assert_eq!(e.in_backup, e.keep_on_uninstall, "{}", e.name);
        n += usize::from(e.in_backup);
    }
    assert!(n >= 5, "담는 항목이 {n}개뿐이다");
}

// 담는 것 = 다시 만들어지지 않는 것 (TC-DSY-13).
#[test]
fn backup_set_is_non_ephemeral() {
    for e in home_layout() {
        assert_eq!(e.in_backup, !e.ephemeral, "{}", e.name);
    }
}

// SHR-19: 되돌리기 대상은 백업에 담기는 파일이고, 순서도 표의 것이다.
#[test]
fn rollback_targets() {
    let got: Vec<_> = home_layout()
        .into_iter()
        .filter(|e| e.rollback)
        .inspect(|e| assert!(!e.is_dir && e.in_backup, "{}", e.name))
        .map(|e| e.name)
        .collect();
    assert_eq!(
        got,
        [
            "workspace.json",
            "settings.json",
            "access.json",
            "runs.json",
            "tools.json"
        ]
    );
}

// SHR-20: backup·uninstall 도움말의 목록은 표에서 나온다.
#[test]
fn help_lists_derive_from_layout() {
    let (backup, uninstall) = (usage_backup(), usage_uninstall());
    for e in home_layout() {
        let name = if e.is_dir {
            format!("{}/", e.name)
        } else {
            e.name.to_owned()
        };
        assert!(backup.contains(&name), "backup 에 {name} 가 없다");
        if !e.keep_on_uninstall {
            assert!(uninstall.contains(&name), "uninstall 에 {name} 가 없다");
        }
    }
}
