use super::*;

#[test]
fn repo_has_one_commit_on_main() {
    let Some(r) = repo() else { return };
    let dir = r.path();
    assert_eq!(run(dir, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    let log = run(dir, &["log", "--oneline"]);
    assert!(!log.is_empty() && !log.contains('\n'), "log={log:?}");
    // git 은 toplevel 을 언제나 슬래시로 답한다. 재는 것은 심볼릭 링크가 풀렸는가다.
    let top = run(dir, &["rev-parse", "--show-toplevel"]);
    assert_eq!(top, dir.to_string_lossy().replace('\\', "/"));
}

#[test]
fn repo_is_removed_on_drop() {
    let Some(r) = init() else { return };
    let p = r.path().to_path_buf();
    assert!(p.join(".git").is_dir());
    drop(r);
    assert!(!p.exists());
}

#[test]
fn global_config_is_blocked() {
    let Some(r) = init() else { return };
    let out = run(r.path(), &["config", "--show-origin", "--list"]);
    // 전역(~/.gitconfig) 항목이 없다. Apple git 의 내장 기본값은 GIT_CONFIG_SYSTEM 으로 막히지 않는다(Go 도 같다).
    assert!(!out.contains(".gitconfig"), "{out}");
    assert!(out.contains("file:.git/config\tuser.name=tester"), "{out}");
}

#[cfg(unix)]
#[test]
fn counter_counts_git_processes() {
    let Some(r) = repo() else { return };
    let c = Counter::install().unwrap();
    c.reset();
    assert_eq!(c.n(), 0);
    run_env(r.path(), &["status", "--short"], c.envs());
    run_env(r.path(), &["rev-parse", "HEAD"], c.envs());
    assert_eq!(c.calls(), ["status --short", "rev-parse HEAD"]);
    c.reset();
    assert_eq!(c.n(), 0);
    run(r.path(), &["status"]);
    assert_eq!(c.n(), 0, "계수기를 심지 않은 git 은 세지 않는다");
    let c2 = Counter::install().unwrap();
    run_env(r.path(), &["status"], c2.envs());
    assert_eq!((c.n(), c2.n()), (0, 1), "기록 파일은 계수기마다 다르다");
}

#[test]
#[should_panic(expected = "git definitely-not-a-command")]
fn run_failure_panics() {
    let Some(r) = init() else {
        panic!("git definitely-not-a-command (git 없음)");
    };
    run(r.path(), &["definitely-not-a-command"]);
}
