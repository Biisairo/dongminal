use otter_shared_platform::build_target;

use super::dispatch;
use crate::{GO_RUNTIME, VERSION, action_names, help, run_version, usage};

// FR-CLI-1/2: 무인자·-h·--help 는 help 를 내고 0 으로 끝난다.
#[test]
fn help_forms() {
    for a in [&[][..], &["-h"], &["--help"], &["help"]] {
        let (code, out, err) = dispatch(a);
        assert_eq!(code, 0, "{a:?}");
        assert!(out.contains("사용법"), "{a:?} → {out:?}");
        assert!(err.is_empty(), "{a:?} → {err:?}");
    }
}

// V-WIN-6: `window` 가 액션으로 선다.
#[test]
fn window_is_an_action() {
    let (code, out, err) = dispatch(&["window", "--help"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.contains("otterminal window"), "{out}");
}

// FR-CLI-5: 알 수 없는 액션은 rc=2.
#[test]
fn unknown_action() {
    let (code, out, err) = dispatch(&["bogus"]);
    assert_eq!(code, 2);
    assert!(err.contains("bogus"), "{err}");
    assert!(out.is_empty(), "{out}");
}

// FR-CLI-6: 액션 help 는 부수효과 없이 rc=0.
#[test]
fn action_help() {
    for a in action_names() {
        let (code, out, _) = dispatch(&[a, "--help"]);
        assert_eq!(code, 0, "{a}");
        assert!(out.contains(&format!("otterminal {a}")), "{a} → {out}");
    }
}

// FR-CLI-7: 알 수 없는 옵션은 부수효과 없이 rc=2.
#[test]
fn unknown_flag() {
    for a in action_names() {
        let (code, out, err) = dispatch(&[a, "--bogus"]);
        assert_eq!(code, 2, "{a}");
        assert!(err.contains("--bogus"), "{a} → {err}");
        assert!(out.is_empty(), "{a} → {out}");
    }
}

// FR-RVN-2: 새기지 않은 빌드는 dev 다.
#[test]
fn version_defaults_to_dev() {
    if option_env!("OTTERMINAL_BUILD_VERSION").is_none() {
        assert_eq!(VERSION, "dev");
    }
}

// FR-RVN-3: 대상과 런타임을 함께 찍는다.
#[test]
fn run_version_reports_target_and_runtime() {
    let mut out = Vec::new();
    assert_eq!(run_version(&mut out), 0);
    let out = String::from_utf8(out).unwrap();
    assert_eq!(
        out,
        format!("otterminal {VERSION} {} {GO_RUNTIME}\n", build_target())
    );
}

#[test]
fn version_actions() {
    for a in [&["version"][..], &["--version"]] {
        let (code, out, err) = dispatch(a);
        assert_eq!(code, 0, "{a:?} {err}");
        assert!(out.starts_with(&format!("otterminal {VERSION} ")), "{out}");
    }
}

#[test]
fn help_carries_version() {
    assert!(help().contains(&format!("otterminal {VERSION}")));
}

// FR-CLI-3: help 는 액션을 모두 담고, 내부 진입점 `d` 는 광고하지 않는다 (FR-CLI-8).
#[test]
fn help_lists_every_action() {
    let h = help();
    for a in action_names() {
        assert!(h.contains(a), "help 에 {a} 가 없다");
    }
    for line in h.lines() {
        assert!(!line.trim_end().starts_with("  d "), "{line}");
    }
}

#[test]
fn usage_mentions_own_action() {
    for a in action_names() {
        assert!(usage(a).contains(&format!("otterminal {a}")), "{a}");
    }
}

// 표에 없는 이름은 전체 도움말로 떨어진다.
#[test]
fn usage_of_unknown_is_help() {
    assert_eq!(usage("nope"), help());
}

// 옛 이름 `helper` 는 목록에 없지만 `otp` 로 간다.
#[test]
fn helper_alias_is_hidden() {
    assert!(!action_names().contains(&"helper"));
    assert_eq!(usage("helper"), usage("otp"));
}
