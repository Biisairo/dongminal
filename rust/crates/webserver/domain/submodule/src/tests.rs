use std::sync::{Arc, Mutex};

use dm_shared_gittest as gittest;
use dm_webserver_domain_git_core::{self as core, Ctx, Output, Service as GitService};

use super::*;

fn repo_path() -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    dm_gocompat::filepath::join(&[root, "repo"])
}

fn ctx() -> Ctx {
    Ctx::background()
}

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

fn mgr(out: &str, err: Option<Error>) -> (Manager, Calls) {
    let calls: Calls = Arc::default();
    let c2 = calls.clone();
    let out = out.to_owned();
    let m = Manager::new(Arc::new(move |_, dir, args| {
        let mut row = vec![dir];
        row.extend(args);
        c2.lock().unwrap().push(row);
        let res = match &err {
            None => Ok(out.clone()),
            Some(e) => Err(Failure {
                text: out.clone(),
                err: e.clone(),
            }),
        };
        Box::pin(async move { res })
    }));
    (m, calls)
}

fn e(oid: &str, path: &str, state: &str, describe: &str) -> Entry {
    Entry {
        path: path.into(),
        oid: oid.into(),
        state: state.into(),
        describe: describe.into(),
    }
}

#[tokio::test]
async fn list_parses_four_states() {
    let out = [
        " 8bb349bdc9845ed61fad4b60564ce257d8407e37 vendor/ok (heads/main)",
        "-1111111111111111111111111111111111111111 vendor/uninit",
        "+2222222222222222222222222222222222222222 vendor/moved (v1.0-2-gabcdef)",
        "U3333333333333333333333333333333333333333 vendor/conflicted",
    ]
    .join("\n");
    let (m, _) = mgr(&out, None);
    let got = m.list(&ctx(), &repo_path()).await.unwrap();
    assert_eq!(
        got,
        vec![
            e(
                "8bb349bdc9845ed61fad4b60564ce257d8407e37",
                "vendor/ok",
                STATE_OK,
                "heads/main"
            ),
            e(
                "1111111111111111111111111111111111111111",
                "vendor/uninit",
                STATE_UNINITIALIZED,
                ""
            ),
            e(
                "2222222222222222222222222222222222222222",
                "vendor/moved",
                STATE_MODIFIED,
                "v1.0-2-gabcdef"
            ),
            e(
                "3333333333333333333333333333333333333333",
                "vendor/conflicted",
                STATE_CONFLICT,
                ""
            ),
        ]
    );
}

#[tokio::test]
async fn list_handles_path_with_spaces() {
    let (m, _) = mgr(
        " 4444444444444444444444444444444444444444 vendor/my lib (heads/main)",
        None,
    );
    let got = m.list(&ctx(), &repo_path()).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(
        (got[0].path.as_str(), got[0].describe.as_str()),
        ("vendor/my lib", "heads/main")
    );
}

#[tokio::test]
async fn list_empty_is_not_an_error() {
    let (m, _) = mgr("", None);
    let got = m.list(&ctx(), &repo_path()).await.unwrap();
    assert!(got.is_empty());
    assert_eq!(dm_gocompat::json::marshal(&got).unwrap(), b"[]");
}

#[tokio::test]
async fn list_rejects_garbage_line() {
    let (m, _) = mgr(
        " short-oid vendor/x\n\n 5555555555555555555555555555555555555555 vendor/ok (m)\nX5555555555555555555555555555555555555555 y\n 5555555555555555555555555555555555555555",
        None,
    );
    let got = m.list(&ctx(), &repo_path()).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].path, "vendor/ok");
}

#[tokio::test]
async fn list_parses_sha256_oid() {
    let oid = "a1".repeat(32);
    let b = "b".repeat(64);
    let (m, _) = mgr(
        &format!(" {oid} vendor/ok (heads/main)\n-{b} vendor/uninit"),
        None,
    );
    let got = m.list(&ctx(), &repo_path()).await.unwrap();
    assert_eq!(
        got,
        vec![
            e(&oid, "vendor/ok", STATE_OK, "heads/main"),
            e(&b, "vendor/uninit", STATE_UNINITIALIZED, ""),
        ]
    );
}

#[tokio::test]
async fn list_uses_status_subcommand() {
    let (m, calls) = mgr("", None);
    m.list(&ctx(), &repo_path()).await.unwrap();
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0],
        vec![repo_path(), "submodule".into(), "status".into()]
    );
}

#[tokio::test]
async fn list_propagates_failure() {
    let (m, _) = mgr(
        "fatal: not a git repository",
        Some(Error::other("exit status 128")),
    );
    let err = m.list(&ctx(), &repo_path()).await.unwrap_err();
    assert!(err.is(Kind::Failed));
    assert_eq!(
        err.to_string(),
        "submodule_failed: fatal: not a git repository"
    );
    let (m, _) = mgr("  ", Some(Error::other("exit status 128")));
    let err = m.list(&ctx(), &repo_path()).await.unwrap_err();
    assert_eq!(err.to_string(), "submodule_failed: exit status 128");
}

#[tokio::test]
async fn update_argv() {
    for (init, recursive, path, want) in [
        (false, false, "vendor/x", "submodule update -- vendor/x"),
        (
            true,
            false,
            "vendor/x",
            "submodule update --init -- vendor/x",
        ),
        (
            true,
            true,
            "vendor/x",
            "submodule update --init --recursive -- vendor/x",
        ),
        (true, false, "", "submodule update --init"),
    ] {
        let (m, calls) = mgr("", None);
        m.update(&ctx(), &repo_path(), path, init, recursive)
            .await
            .unwrap();
        assert_eq!(calls.lock().unwrap()[0][1..].join(" "), want);
    }
}

#[tokio::test]
async fn sync_argv() {
    let (m, calls) = mgr("", None);
    m.sync(&ctx(), &repo_path(), "vendor/x").await.unwrap();
    assert_eq!(
        calls.lock().unwrap()[0][1..].join(" "),
        "submodule sync -- vendor/x"
    );
}

#[tokio::test]
async fn path_guard_rejects_escape() {
    for bad in [
        "/etc",
        "../outside",
        "vendor/../../etc",
        "C:\\win",
        "-rf",
        "--force",
    ] {
        let (m, calls) = mgr("", None);
        let err = m
            .update(&ctx(), &repo_path(), bad, false, false)
            .await
            .unwrap_err();
        assert!(err.is(Kind::UnsafePath), "{bad}");
        assert!(calls.lock().unwrap().is_empty(), "{bad}");
    }
}

#[tokio::test]
async fn path_guard_allows_normal() {
    for ok in ["vendor/inner", "a", "a/b/c", "my lib"] {
        let (m, _) = mgr("", None);
        m.update(&ctx(), &repo_path(), ok, false, false)
            .await
            .unwrap();
    }
}

#[test]
fn check_path_strongest_rules() {
    for p in [
        "",
        "  ",
        "/abs",
        "../x",
        "a/../../x",
        "a\0b",
        "a/./b",
        "a//b",
        "a/",
        "-flag",
        "C:\\x",
        "C:x",
    ] {
        assert!(check_path(p).unwrap_err().is(Kind::UnsafePath), "{p:?}");
    }
    for p in ["sub", "vendor/my lib", "a/b-c", "x.y"] {
        check_path(p).unwrap();
    }
    assert_eq!(
        check_path("").unwrap_err().to_string(),
        "unsafe_path: 경로가 비었다"
    );
    assert_eq!(
        check_path("C:x").unwrap_err().to_string(),
        "unsafe_path: 드라이브 경로: \"C:x\""
    );
    assert_eq!(
        check_path("-flag").unwrap_err().to_string(),
        "unsafe_path: 플래그로 읽힌다: \"-flag\""
    );
}

#[tokio::test]
async fn repo_guard() {
    let (m, calls) = mgr("", None);
    let err = m.list(&ctx(), "relative/path").await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "unsafe_path: repo 는 절대경로여야 한다: \"relative/path\""
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn update_spec_guards_path_and_builds_argv() {
    let spec = update_spec(&repo_path(), "vendor/x", true, true).unwrap();
    assert_eq!(
        spec.argv,
        [
            "submodule",
            "update",
            "--init",
            "--recursive",
            "--",
            "vendor/x"
        ]
    );
    assert_eq!(spec.reason, UNGUARDED_REASON);
    assert_eq!(
        update_spec(&repo_path(), "", false, false).unwrap().argv,
        ["submodule", "update"]
    );
    assert!(
        update_spec(&repo_path(), "../x", true, false)
            .unwrap_err()
            .is(Kind::UnsafePath)
    );
    assert!(
        update_spec("relative", "", true, false)
            .unwrap_err()
            .is(Kind::UnsafePath)
    );
}

#[tokio::test]
async fn runner_receives_caller_context() {
    let seen = Arc::new(Mutex::new(None));
    let s2 = seen.clone();
    let m = Manager::new(Arc::new(move |c: Ctx, _, _| {
        *s2.lock().unwrap() = Some(c.err());
        Box::pin(async { Ok(String::new()) })
    }));
    let c = ctx().with_cancel();
    c.cancel();
    m.sync(&c, &repo_path(), "").await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(Some(core::CtxError::Canceled)));
}

#[tokio::test]
async fn sync_failure_preserves_core_sentinel() {
    let cause =
        Error::from(core::Error::new(core::Kind::IndexLocked, "x").wrap("git submodule sync"));
    let (m, _) = mgr(
        "fatal: Unable to create '.git/index.lock': File exists.",
        Some(cause),
    );
    let err = m.sync(&ctx(), &repo_path(), "").await.unwrap_err();
    assert!(
        err.is(Kind::Failed) && err.is_core(core::Kind::IndexLocked),
        "{err}"
    );
}

#[tokio::test]
async fn runner_for_success_is_stdout_only() {
    let svc = GitService::builder()
        .write_runner(Arc::new(|_, _, _, _| {
            Box::pin(async {
                Ok(Output {
                    stdout: b" abc sub (heads/main)\n".to_vec(),
                    stderr: "warning: x\n".into(),
                    ..Output::default()
                })
            })
        }))
        .build();
    let out = runner_for(Some(Arc::new(svc)))(
        ctx(),
        repo_path(),
        vec!["submodule".into(), "status".into()],
    )
    .await
    .unwrap();
    assert_eq!(out, " abc sub (heads/main)");
}

fn tmp() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().to_str().unwrap().to_owned();
    (t, p)
}

#[tokio::test]
async fn run_git_preserves_core_sentinel_and_stderr() {
    if gittest::path().is_none() {
        return;
    }
    let (_t, dir) = tmp();
    let f = exec_git(&ctx(), &dir, &["status"]).await.unwrap_err();
    assert!(f.err.is_core(core::Kind::NotRepo), "{}", f.err);
    let f = exec_git(&ctx(), &dir, &["submodule", "status"])
        .await
        .unwrap_err();
    assert!(f.text.contains("not a git repository"), "{:?}", f.text);
}

#[tokio::test]
async fn run_git_applies_env_contract() {
    if gittest::path().is_none() {
        return;
    }
    let (_t, dir) = tmp();
    for (name, want) in [("GIT_EDITOR", "true"), ("GIT_PAGER", "cat")] {
        assert_eq!(exec_git(&ctx(), &dir, &["var", name]).await.unwrap(), want);
    }
}

#[tokio::test]
async fn exec_git_keeps_leading_space() {
    if gittest::path().is_none() {
        return;
    }
    let (_t, dir) = tmp();
    let out = exec_git(&ctx(), &dir, &["-c", "alias.e=!printf ' leading\\n'", "e"])
        .await
        .unwrap();
    assert_eq!(out, " leading");
}

#[test]
fn entry_json_shape() {
    let v = vec![e("o", "p", STATE_OK, ""), e("o", "p", STATE_OK, "d")];
    assert_eq!(
        dm_gocompat::json::marshal(&v).unwrap(),
        br#"[{"path":"p","oid":"o","state":"ok"},{"path":"p","oid":"o","state":"ok","describe":"d"}]"#
    );
}
