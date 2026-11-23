use std::path::Path;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_gocompat::filepath;
use dm_shared_gittest as gittest;
use dm_webserver_domain_git_core::{self as core, Ctx, Output, Service as GitService};

use crate::manager::check_abs_path;
use crate::naming::valid_ref;
use crate::parse::parse_worktree_list;
use crate::*;

struct Env {
    _tmp: tempfile::TempDir,
    m: Manager,
}

fn real_tmp() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let p = filepath::eval_symlinks(t.path().to_str().unwrap()).unwrap();
    (t, p)
}

fn temp_manager() -> Env {
    let (t, root) = real_tmp();
    let m = Manager::new(&filepath::join(&[root, "worktrees".to_owned()]));
    Env { _tmp: t, m }
}

fn temp_repo() -> Option<gittest::Repo> {
    let r = gittest::repo()?;
    gittest::run(r.path(), &["config", "core.autocrlf", "false"]);
    Some(r)
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_owned()
}

fn git(dir: &str, args: &[&str]) -> String {
    gittest::run(Path::new(dir), args)
}

fn abs_repo() -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    filepath::join(&[root, "repo"])
}

fn ctx() -> Ctx {
    Ctx::background()
}

fn runner<F>(f: F) -> Runner
where
    F: Fn(&str, &[String]) -> Result<String, Failure> + Send + Sync + 'static,
{
    let f = Arc::new(f);
    Arc::new(move |_ctx, dir, args| {
        let f = f.clone();
        Box::pin(async move { f(&dir, &args) })
    })
}

fn ok_runner() -> Runner {
    runner(|_, _| Ok(String::new()))
}

fn fail(msg: &str) -> Failure {
    Failure::new(Error::other(msg))
}

fn spec(m: &Manager, repo: &str, leaf: &str, branch: &str, base: &str) -> Spec {
    Spec {
        repo: repo.to_owned(),
        path: m.path("run1234", leaf),
        branch: branch.to_owned(),
        base: base.to_owned(),
        ..Spec::default()
    }
}

async fn create_tree(m: &Manager, repo: &str, leaf: &str, branch: &str, base: &str) -> Spec {
    let sp = spec(m, repo, leaf, branch, base);
    m.create(&ctx(), &sp).await.expect("Create");
    sp
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn commit_in(dir: &str, name: &str) {
    std::fs::write(Path::new(dir).join(name), format!("{name}\n")).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", name]);
}

fn outside_worktree(repo: &str, branch: &str) -> (tempfile::TempDir, String) {
    let (t, parent) = real_tmp();
    let p = filepath::join(&[parent, "outside".to_owned()]);
    git(repo, &["worktree", "add", "--no-track", "-b", branch, &p]);
    (t, p)
}

fn rm(repo: &str, path: &str) -> RemoveSpec {
    RemoveSpec {
        repo: repo.to_owned(),
        path: path.to_owned(),
        ..RemoveSpec::default()
    }
}

// ---- env / exec ----

#[tokio::test]
async fn run_git_applies_env_contract() {
    if gittest::path().is_none() {
        return;
    }
    let (_t, dir) = real_tmp();
    for (name, want) in [("GIT_EDITOR", "true"), ("GIT_PAGER", "cat")] {
        let got = exec_git(&ctx(), &dir, &["var", name]).await.unwrap();
        assert_eq!(got, want, "{name}");
    }
}

#[tokio::test]
async fn run_git_keeps_stderr_on_failure() {
    if gittest::path().is_none() {
        return;
    }
    let (_t, dir) = real_tmp();
    let f = exec_git(&ctx(), &dir, &["status", "--porcelain"])
        .await
        .expect_err("저장소가 아닌 곳에서 성공했다");
    assert!(f.text.contains("not a git repository"), "{:?}", f.text);
    assert!(
        f.err.is_core(core::Kind::NotRepo),
        "core 의 사유 보존: {}",
        f.err
    );
}

#[tokio::test]
async fn is_dirty_ignores_stderr_on_success() {
    let svc = GitService::builder()
        .write_runner(Arc::new(|_, _, _, _| {
            Box::pin(async {
                Ok(Output {
                    stderr: "warning: could not open directory 'x/': Permission denied\n".into(),
                    ..Output::default()
                })
            })
        }))
        .build();
    let e = temp_manager();
    let m = e.m.clone().with_service(Arc::new(svc));
    assert!(!m.is_dirty(&ctx(), &abs_repo()).await.unwrap());
}

fn counting(m: &Manager, n: Arc<AtomicUsize>) -> Manager {
    let inner = git_runner(None);
    m.clone().with_runner(Arc::new(move |c, d, a| {
        n.fetch_add(1, Ordering::SeqCst);
        inner(c, d, a)
    }))
}

#[tokio::test]
async fn resolve_one_rev_parse() {
    let Some(r) = gittest::repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let n = Arc::new(AtomicUsize::new(0));
    let m = counting(&e.m, n.clone());

    let got = m.resolve(&ctx(), &repo, "").await.unwrap();
    assert_eq!(
        (got.root.as_str(), got.base.as_str()),
        (repo.as_str(), "main")
    );
    assert_eq!(n.swap(0, Ordering::SeqCst), 1);

    git(&repo, &["checkout", "-q", "--detach"]);
    let sha = git(&repo, &["rev-parse", "HEAD"]);
    let got = m.resolve(&ctx(), &repo, "").await.unwrap();
    assert_eq!(got.base, sha);
    assert_eq!(n.swap(0, Ordering::SeqCst), 1);

    let got = m.resolve(&ctx(), &repo, "main").await.unwrap();
    assert_eq!(
        (got.root.as_str(), got.base.as_str()),
        (repo.as_str(), "main")
    );
    assert_eq!(n.swap(0, Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resolve_failure_kinds_preserved() {
    let Some(r) = gittest::repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    let (_t, not_repo) = real_tmp();
    assert!(
        m.resolve(&ctx(), &not_repo, "")
            .await
            .unwrap_err()
            .is(Kind::NotRepo)
    );
    let unborn = gittest::init().unwrap();
    assert!(
        m.resolve(&ctx(), &s(unborn.path()), "")
            .await
            .unwrap_err()
            .is(Kind::NotRepo)
    );
    let err = m.resolve(&ctx(), &repo, "nope").await.unwrap_err();
    assert!(err.is(Kind::UnsafeArgument));
    assert_eq!(
        err.to_string(),
        "unsafe_argument: base 를 찾을 수 없다: \"nope\""
    );
    assert!(
        m.resolve(&ctx(), &not_repo, "main")
            .await
            .unwrap_err()
            .is(Kind::NotRepo)
    );
    let sub = filepath::join(&[repo.clone(), "sub".to_owned()]);
    std::fs::create_dir(&sub).unwrap();
    assert_eq!(m.resolve(&ctx(), &sub, "").await.unwrap().root, repo);
}

#[tokio::test]
async fn resolve_non_repo_fails() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    let (_t, plain) = real_tmp();
    let err = m.resolve(&ctx(), &plain, "").await.unwrap_err();
    assert!(err.is(Kind::NotRepo));
    assert_eq!(
        err.to_string(),
        format!("not_a_git_repo: {plain} 는 git 저장소가 아니다")
    );
    let err = m.resolve(&ctx(), "", "").await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "not_a_git_repo: 조정자의 cwd 를 알 수 없다"
    );
    let err = m.resolve(&ctx(), "rel", "").await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "not_a_git_repo: cwd 는 절대 경로여야 한다: \"rel\""
    );
    let got = m.resolve(&ctx(), &repo, "").await.unwrap();
    assert_eq!(
        (got.root.as_str(), got.base.as_str()),
        (repo.as_str(), "main")
    );
    assert!(
        m.resolve(&ctx(), &repo, "-x")
            .await
            .unwrap_err()
            .is(Kind::UnsafeArgument)
    );
    assert!(m.resolve(&ctx(), &repo, "없는브랜치").await.is_err());
}

#[tokio::test]
async fn resolve_tolerant_of_blank_lines() {
    for out in [
        format!("{}\n\nabc123\nmain", abs_repo()),
        format!("{}\r\nabc123\r\n\r\nmain", abs_repo()),
    ] {
        let e = temp_manager();
        let m = e.m.clone().with_runner(runner(move |_, _| Ok(out.clone())));
        let got = m.resolve(&ctx(), &abs_repo(), "").await.unwrap();
        assert_eq!((got.root, got.base.as_str()), (abs_repo(), "main"));
    }
}

#[test]
fn valid_ref_superset_of_check_ref_arg() {
    for v in [
        "", " ", "-x", "a\0b", "a..b", "x.lock", "/a", "a/", "a//b", "a b", "a~1", "a^", "a:b",
        "a;b",
    ] {
        let err = valid_ref(v).unwrap_err();
        assert!(err.is(Kind::UnsafeArgument), "{v:?}");
        assert!(!err.is_core(core::Kind::RefName), "{v:?}");
    }
    assert_eq!(
        valid_ref("-x").unwrap_err().to_string(),
        "unsafe_argument: ref_name_invalid: ref 는 - 로 시작할 수 없다: \"-x\""
    );
    assert_eq!(
        valid_ref("x.lock").unwrap_err().to_string(),
        "unsafe_argument: 잘못된 ref: \"x.lock\""
    );
    assert_eq!(
        valid_ref("a b").unwrap_err().to_string(),
        "unsafe_argument: ref 에 쓸 수 없는 문자: \"a b\""
    );
    for v in ["main", "feat/x", "v1.2", "dmn/run1234/a"] {
        valid_ref(v).unwrap();
        core::check_ref_arg("ref", v).unwrap();
    }
    check_name("main").unwrap();
}

// ---- lock ----

fn lock_key() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let k = s(&t.path().join("common"));
    (t, k)
}

#[tokio::test]
async fn lock_repo_wait_bound_cancel_deadline() {
    let (_t, key) = lock_key();
    let mut release = lock_repo(&ctx(), &key, Duration::from_secs(1))
        .await
        .unwrap();
    let err = lock_repo(&ctx(), &key, Duration::from_millis(30))
        .await
        .unwrap_err();
    assert!(err.is(Kind::RepoBusy));
    assert!(err.to_string().starts_with("repo_busy: "), "{err}");
    assert!(
        err.to_string()
            .ends_with(" 의 worktree 조작이 30ms 안에 끝나지 않았다"),
        "{err}"
    );
    let canceled = ctx().with_cancel();
    canceled.cancel();
    let err = lock_repo(&canceled, &key, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(err.is_core(core::Kind::Canceled));
    assert_eq!(
        err.to_string(),
        "git_canceled: worktree 잠금을 기다리는 중: context canceled"
    );
    let short = ctx().with_timeout(Duration::from_millis(30));
    let err = lock_repo(&short, &key, Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(err.is_core(core::Kind::Timeout), "{err}");
    assert_eq!(
        err.to_string(),
        "git_timeout: worktree 잠금을 기다리는 중: context deadline exceeded"
    );
    release.release();
    release.release();
    let again = lock_repo(&ctx(), &key, Duration::from_millis(30)).await;
    assert!(again.is_ok(), "반납 뒤 다시 쥐지 못했다");
}

#[cfg(unix)]
#[tokio::test]
async fn lock_repo_key_is_normalized() {
    let (_a, dir) = real_tmp();
    let t = tempfile::tempdir().unwrap();
    let link = s(&t.path().join("link"));
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    let _held = lock_repo(&ctx(), &dir, Duration::from_secs(1))
        .await
        .unwrap();
    for k in [format!("{dir}{}", filepath::SEPARATOR), link] {
        let err = lock_repo(&ctx(), &k, Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(err.is(Kind::RepoBusy), "{k}: {err}");
    }
}

#[tokio::test]
async fn create_lock_key_is_common_dir() {
    let (_t, key) = lock_key();
    let _held = lock_repo(&ctx(), &key, Duration::from_secs(1))
        .await
        .unwrap();
    let adds = Arc::new(AtomicUsize::new(0));
    let a2 = adds.clone();
    let e = temp_manager();
    let m =
        e.m.clone()
            .with_lock_wait(Duration::from_millis(30))
            .with_runner(runner(move |_, args| {
                if args.len() > 1 && args[0] == "worktree" && args[1] == "add" {
                    a2.fetch_add(1, Ordering::SeqCst);
                }
                Ok(String::new())
            }));
    let mut sp = spec(&m, &abs_repo(), "a", "dmn/r/a", "main");
    sp.lock_key = key;
    assert!(m.create(&ctx(), &sp).await.unwrap_err().is(Kind::RepoBusy));
    assert_eq!(adds.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn remove_lock_wait_deadline_carries_err() {
    let (_r, root) = real_tmp();
    let wt = filepath::join(&[root.clone(), "worktrees".to_owned()]);
    let path = filepath::join(&[wt.clone(), "r".to_owned(), "a".to_owned()]);
    std::fs::create_dir_all(&path).unwrap();
    let (_t, key) = lock_key();
    let _held = lock_repo(&ctx(), &key, Duration::from_secs(1))
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    let m = Manager::new(&wt).with_runner(runner(move |_, _| {
        c2.fetch_add(1, Ordering::SeqCst);
        Ok(String::new())
    }));
    let c = ctx().with_timeout(Duration::from_millis(30));
    let mut sp = rm(&abs_repo(), &path);
    sp.lock_key = key;
    let res = m.remove(&c, &sp).await;
    assert!(!res.removed);
    assert!(
        res.err
            .as_ref()
            .is_some_and(|e| e.is_core(core::Kind::Timeout)),
        "{res:?}"
    );
    assert_eq!(res.residue, RESIDUE_REMOVE_FAILED);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn branch_exists_does_not_take_repo_lock() {
    let _held = lock_repo(&ctx(), &abs_repo(), Duration::from_secs(1))
        .await
        .unwrap();
    let e = temp_manager();
    let m =
        e.m.clone()
            .with_lock_wait(Duration::from_millis(30))
            .with_runner(ok_runner());
    assert!(m.branch_exists(&ctx(), &abs_repo(), "main").await);
}

#[tokio::test]
async fn runner_receives_caller_context() {
    let seen = Arc::new(Mutex::new(None));
    let s2 = seen.clone();
    let e = temp_manager();
    let m = e.m.clone().with_runner(Arc::new(move |c: Ctx, _, _| {
        *s2.lock().unwrap() = Some(c.err());
        Box::pin(async { Ok(String::new()) })
    }));
    let c = ctx().with_cancel();
    c.cancel();
    m.list(&c, &abs_repo()).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(Some(core::CtxError::Canceled)));
}

#[tokio::test]
async fn add_spec_argv_and_guards() {
    let e = temp_manager();
    let m =
        e.m.clone()
            .with_runner(runner(|_, _| panic!("AddSpec 이 git 을 불렀다")));
    let p = m.path("repo-x", "feat");
    let base = |branch: &str, b: &str, path: &str| Spec {
        repo: abs_repo(),
        path: path.to_owned(),
        branch: branch.to_owned(),
        base: b.to_owned(),
        ..Spec::default()
    };
    let sp = m.add_spec(&base("feat", "main", &p)).unwrap();
    assert_eq!(
        sp.argv.join(" "),
        format!("worktree add --no-track -b feat {p} main")
    );
    assert_eq!(sp.reason, UNGUARDED_REASON);
    let sp = m.add_spec(&base("", "main", &p)).unwrap();
    assert_eq!(sp.argv.join(" "), format!("worktree add {p} main"));
    assert!(
        m.add_spec(&base("", "main", "/elsewhere/x"))
            .unwrap_err()
            .is(Kind::UnsafePath)
    );
    assert!(
        m.add_spec(&base("", "-x", &p))
            .unwrap_err()
            .is(Kind::UnsafeArgument)
    );
    let mut no_repo = base("feat", "", &p);
    no_repo.repo = " ".into();
    assert_eq!(
        m.add_spec(&no_repo).unwrap_err().to_string(),
        "not_a_git_repo: repo 가 비었다"
    );
}

// ---- create / remove (실제 git) ----

#[tokio::test]
async fn create_no_track_and_records_base() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let sp = create_tree(&e.m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    assert_eq!(
        git(&sp.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        sp.branch
    );
    assert_eq!(
        git(
            &repo,
            &["config", "--get", "branch.dmn/run1234/writer.base"]
        ),
        "main"
    );
    let up = gittest::try_run(
        Path::new(&sp.path),
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{}@{{upstream}}", sp.branch),
        ],
    );
    assert!(up.is_err(), "upstream 이 붙었다");
    assert_eq!(
        git(&sp.path, &["config", "--get", "push.autoSetupRemote"]),
        "true"
    );
}

#[test]
fn path_and_branch_derive_from_identifiers() {
    let e = temp_manager();
    let a = e.m.path("run1111", "mem1111");
    assert_ne!(a, e.m.path("run2222", "mem1111"));
    assert!(a.starts_with(e.m.root()));
    assert_eq!(branch("run1111", "작가", "mem1111"), "dmn/run1111/mem1111");
    assert_eq!(
        branch("run1111", "Writer 2", "mem1111"),
        "dmn/run1111/Writer-2"
    );
    assert!(!branch("run1111", "--force", "mem1111").contains("/-"));
    assert_eq!(branch("", "", ""), "dmn/run/member");
    assert_eq!(
        e.m.path("", "-"),
        filepath::join(&[e.m.root(), "run", "member"])
    );
    let long = "a".repeat(39) + "-b";
    assert_eq!(branch("r", &long, ""), format!("dmn/r/{}", "a".repeat(39)));
}

#[tokio::test]
async fn create_rejects_dash_leading_arguments() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    let good = m.path("run1234", "mem5678");
    for (b, base) in [("-x", "main"), ("dmn/a/b", "-x"), ("", "")] {
        let sp = spec(m, &repo, "mem5678", b, base);
        assert!(
            m.create(&ctx(), &sp)
                .await
                .unwrap_err()
                .is(Kind::UnsafeArgument)
        );
    }
    let mut esc = spec(m, &repo, "x", "dmn/a/b", "main");
    esc.path = filepath::join(&[m.root(), "..", "elsewhere"]);
    assert!(
        m.create(&ctx(), &esc)
            .await
            .unwrap_err()
            .is(Kind::UnsafePath)
    );
    assert!(!exists(&good));
}

#[tokio::test]
async fn remove_clean_removes_worktree_and_merged_branch() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let sp = create_tree(&e.m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    let mut rs = rm(&repo, &sp.path);
    rs.branch = sp.branch.clone();
    let res = e.m.remove(&ctx(), &rs).await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");
    assert!(!exists(&sp.path));
    assert_eq!(git(&repo, &["branch", "--list", &sp.branch]), "");
}

#[tokio::test]
async fn remove_dirty_is_preserved_and_reported() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let sp = create_tree(&e.m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    let work = filepath::join(&[sp.path.clone(), "작업물.txt".to_owned()]);
    std::fs::write(&work, "지우면 안 된다\n").unwrap();
    let mut rs = rm(&repo, &sp.path);
    rs.branch = sp.branch.clone();
    let res = e.m.remove(&ctx(), &rs).await;
    assert!(!res.removed && res.residue == RESIDUE_DIRTY, "{res:?}");
    assert!(exists(&work));
    assert_ne!(git(&repo, &["branch", "--list", &sp.branch]), "");
    // Remove 는 force 와 무관하게 dirty 를 보존한다.
    rs.force = true;
    let res = e.m.remove(&ctx(), &rs).await;
    assert_eq!(res.residue, RESIDUE_DIRTY);
}

#[tokio::test]
async fn remove_unmerged_branch_is_residue() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let sp = create_tree(&e.m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    commit_in(&sp.path, "새파일.txt");
    let mut rs = rm(&repo, &sp.path);
    rs.branch = sp.branch.clone();
    let res = e.m.remove(&ctx(), &rs).await;
    assert!(res.removed, "{res:?}");
    assert_eq!(res.residue, RESIDUE_BRANCH_RETAINED);
    assert!(!res.detail.is_empty());
    assert_ne!(git(&repo, &["branch", "--list", &sp.branch]), "");
}

#[tokio::test]
async fn remove_rejects_risky_paths() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    let (_o, outside) = real_tmp();
    let user_area = filepath::join(&[
        filepath::dir(m.root()),
        "git-worktrees".into(),
        "repo".into(),
        "feature".into(),
    ]);
    let escape = format!("{0}{1}..{1}..{1}etc", m.root(), filepath::SEPARATOR);
    for p in [
        repo.as_str(),
        "/",
        "",
        "worktrees/run/mem",
        &escape,
        m.root(),
        &outside,
        &user_area,
    ] {
        let mut rs = rm(&repo, p);
        rs.branch = "dmn/a/b".into();
        let res = m.remove(&ctx(), &rs).await;
        assert!(
            !res.removed && res.residue == RESIDUE_UNSAFE_PATH,
            "{p}: {res:?}"
        );
    }
    assert!(exists(&filepath::join(&[repo, "README.md".to_owned()])));
    assert!(exists(&outside));
}

#[cfg(unix)]
#[tokio::test]
async fn new_resolves_symlinked_root() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let (_b, base) = real_tmp();
    let real = filepath::join(&[base.clone(), "actual".into()]);
    std::fs::create_dir_all(&real).unwrap();
    let link = filepath::join(&[base, "link".into()]);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let m = Manager::new(&filepath::join(&[link, "worktrees".into()]));
    assert_eq!(m.root(), filepath::join(&[real, "worktrees".into()]));
    let sp = create_tree(&m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    let entries = m.list(&ctx(), &repo).await.unwrap();
    let reported: Vec<_> = entries.iter().filter(|e| e.path != repo).collect();
    assert_eq!(reported[0].path, sp.path);
    assert!(!m.gone(&ctx(), &repo, &sp.path).await);
    let mut rs = rm(&repo, &sp.path);
    rs.branch = sp.branch.clone();
    let res = m.remove(&ctx(), &rs).await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");
    assert!(m.gone(&ctx(), &repo, &sp.path).await);
}

fn max_tracking(cur: Arc<AtomicI32>, max: Arc<AtomicI32>, only_worktree: bool) -> Runner {
    Arc::new(move |_, _, args: Vec<String>| {
        let cur = cur.clone();
        let max = max.clone();
        Box::pin(async move {
            if only_worktree && (args.len() < 2 || args[0] != "worktree") {
                return Ok(String::new());
            }
            let n = cur.fetch_add(1, Ordering::SeqCst) + 1;
            max.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            cur.fetch_sub(1, Ordering::SeqCst);
            Ok(String::new())
        })
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn operations_are_serialized() {
    let (cur, max) = (Arc::new(AtomicI32::new(0)), Arc::new(AtomicI32::new(0)));
    let e = temp_manager();
    let m = Arc::new(
        e.m.clone()
            .with_runner(max_tracking(cur, max.clone(), false)),
    );
    let mut hs = Vec::new();
    for i in 0..8u8 {
        let m = m.clone();
        hs.push(tokio::spawn(async move {
            let leaf = format!("mem{}", (b'a' + i) as char);
            let sp = spec(&m, &abs_repo(), &leaf, "dmn/run1234/r", "main");
            let _ = m.create(&ctx(), &sp).await;
        }));
    }
    for h in hs {
        h.await.unwrap();
    }
    assert_eq!(max.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn operations_serialize_across_managers_and_spellings() {
    let (cur, max) = (Arc::new(AtomicI32::new(0)), Arc::new(AtomicI32::new(0)));
    let r = max_tracking(cur, max.clone(), true);
    let (_a, ra) = real_tmp();
    let (_b, rb) = real_tmp();
    let m1 = Manager::new(&ra).with_runner(r.clone());
    let m2 = Manager::new(&rb).with_runner(r);
    let sep = filepath::SEPARATOR;
    let repo2 = format!("{}{sep}", abs_repo());
    let s1 = spec(&m1, &abs_repo(), "a", "dmn/run1234/a", "main");
    let s2 = spec(&m2, &abs_repo(), "b", "dmn/run1234/b", "main");
    let mut s3 = spec(&m1, &abs_repo(), "c", "dmn/run1234/c", "main");
    s3.repo = repo2;
    let c = ctx();
    let (x, y, z) = tokio::join!(m1.create(&c, &s1), m2.create(&c, &s2), m1.create(&c, &s3));
    x.unwrap();
    y.unwrap();
    z.unwrap();
    assert_eq!(max.load(Ordering::SeqCst), 1);
}

#[test]
fn repo_bucket_separates_same_basename_different_roots() {
    let a = repo_bucket("/home/x/app");
    let b = repo_bucket("/home/y/app");
    assert_ne!(a, b);
    assert!(a.starts_with("app-") && b.starts_with("app-"));
    assert_eq!(a, repo_bucket("/home/x/app/"));
    assert_eq!(a.len(), "app-".len() + 8);
}

#[tokio::test]
async fn list_includes_main_and_parses_entries() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    let sp = create_tree(m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    let (_d, dp) = real_tmp();
    let detached = filepath::join(&[dp, "detached".into()]);
    m.git(
        &ctx(),
        &repo,
        &["worktree", "add", "--detach", &detached, "main"],
    )
    .await
    .unwrap();
    let entries = m.list(&ctx(), &repo).await.unwrap();
    let by = |p: &str| entries.iter().find(|e| e.path == p).cloned().unwrap();
    assert!(by(&repo).main);
    let linked = by(&sp.path);
    assert!(linked.branch == sp.branch && !linked.detached && !linked.main);
    let det = by(&detached);
    assert!(det.detached && det.branch.is_empty() && !det.main);
    // 링크드 worktree 에서 조회해도 main 은 원래 자리다 (V162).
    for q in [&repo, &sp.path] {
        let entries = m.list(&ctx(), q).await.unwrap();
        for e in &entries {
            assert_eq!(e.main, e.path == repo, "{q}: {entries:?}");
        }
    }
}

#[tokio::test]
async fn create_checks_out_existing_ref_without_new_branch() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    git(&repo, &["branch", "other"]);
    let path = e.m.path("bucket", "existing-ref");
    let sp = Spec {
        repo: repo.clone(),
        path: path.clone(),
        base: "other".into(),
        ..Spec::default()
    };
    e.m.create(&ctx(), &sp).await.unwrap();
    assert_eq!(git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]), "other");
    assert_eq!(git(&repo, &["branch", "--list", "dmn/*"]), "");
}

#[test]
fn parse_worktree_list_normalizes_paths() {
    let raw = [
        "worktree C:/Users/x/repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /srv/repo/../repo/wt",
        "HEAD 2222222222222222222222222222222222222222",
        "detached",
        "",
    ]
    .join("\n");
    let entries = parse_worktree_list(&raw);
    assert_eq!(entries.len(), 2);
    for e in &entries {
        assert!(!e.path.is_empty());
        assert_eq!(filepath::clean(&e.path), e.path);
    }
    assert!(entries[0].main && !entries[1].main);
    assert!(entries[0].branch == "main" && entries[1].detached);
    assert!(parse_worktree_list("").is_empty());
    assert_eq!(
        parse_worktree_list("worktree /a\r\nbranch refs/heads/x")[0].branch,
        "x"
    );
}

#[tokio::test]
async fn remove_retry_stops_when_context_is_cancelled() {
    let (_r, root) = real_tmp();
    let repo = filepath::join(&[root.clone(), "repo".into()]);
    let wt = filepath::join(&[root, "worktrees".into()]);
    let path = filepath::join(&[wt.clone(), "run1234".into(), "mem5678".into()]);
    std::fs::create_dir_all(&path).unwrap();
    let removes = Arc::new(AtomicUsize::new(0));
    let c = ctx().with_cancel();
    let (r2, c2) = (removes.clone(), c.clone());
    let m = Manager::new(&wt).with_runner(runner(move |_, args| {
        if args.len() >= 2 && args[0] == "worktree" && args[1] == "remove" {
            r2.fetch_add(1, Ordering::SeqCst);
            c2.cancel();
            return Err(fail("locked"));
        }
        Ok(String::new())
    }));
    let start = Instant::now();
    let res = m.remove(&c, &rm(&repo, &path)).await;
    assert!(
        !res.removed && res.residue == RESIDUE_REMOVE_FAILED,
        "{res:?}"
    );
    assert_eq!(
        res.detail,
        "locked (요청이 끊겨 되풀이를 접었다: context canceled)"
    );
    assert_eq!(removes.load(Ordering::SeqCst), 1);
    assert!(start.elapsed() < Duration::from_millis(250));
}

#[tokio::test]
async fn remove_retry_gives_up_after_tries() {
    let (_r, root) = real_tmp();
    let wt = filepath::join(&[root.clone(), "worktrees".into()]);
    let path = filepath::join(&[wt.clone(), "r".into(), "m".into()]);
    std::fs::create_dir_all(&path).unwrap();
    let removes = Arc::new(AtomicUsize::new(0));
    let r2 = removes.clone();
    let p2 = path.clone();
    let m = Manager::new(&wt).with_runner(runner(move |_, args| {
        if args.len() >= 2 && args[0] == "worktree" && args[1] == "remove" {
            r2.fetch_add(1, Ordering::SeqCst);
            return Err(fail("busy"));
        }
        if args.len() >= 2 && args[1] == "list" {
            return Ok(format!("worktree {p2}"));
        }
        Ok(String::new())
    }));
    let res = m.remove(&ctx(), &rm(&abs_repo(), &path)).await;
    assert_eq!(
        (res.residue.as_str(), res.detail.as_str()),
        (RESIDUE_REMOVE_FAILED, "busy")
    );
    assert_eq!(removes.load(Ordering::SeqCst), 6);
}

#[test]
fn check_path_dot_dot_is_a_segment_not_a_substring() {
    let e = temp_manager();
    let m = &e.m;
    let sep = filepath::SEPARATOR;
    m.check_path(&filepath::join(&[m.root(), "run", "a..b"]))
        .unwrap();
    m.check_path(&filepath::join(&[m.root(), "run", "..."]))
        .unwrap();
    let bad = format!("{0}{1}run{1}..{1}..{1}etc", m.root(), sep);
    assert!(m.check_path(&bad).unwrap_err().is(Kind::UnsafePath));
    let inside = format!("{0}{1}run{1}..{1}run2{1}m", m.root(), sep);
    assert!(m.check_path(&inside).unwrap_err().is(Kind::UnsafePath));
    assert_eq!(
        m.check_path(m.root()).unwrap_err().to_string(),
        "unsafe_path: worktrees 루트 자신"
    );
    assert_eq!(
        check_abs_path("").unwrap_err().to_string(),
        "unsafe_path: 빈 경로"
    );
    assert_eq!(
        check_abs_path("a/b").unwrap_err().to_string(),
        "unsafe_path: 절대 경로가 아니다: \"a/b\""
    );
    if cfg!(unix) {
        assert_eq!(
            check_abs_path("/").unwrap_err().to_string(),
            "unsafe_path: 파일시스템 루트"
        );
        assert_eq!(
            m.check_path("/x").unwrap_err().to_string(),
            format!("unsafe_path: {} 아래가 아니다: \"/x\"", m.root())
        );
    }
}

// ---- remove_listed / merged / prepare ----

#[tokio::test]
async fn remove_listed_removes_registered_outside_root() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_o, p) = outside_worktree(&repo, "outside-branch");
    let res = e.m.remove_listed(&ctx(), &rm(&repo, &p)).await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");
    assert!(!exists(&p));
    assert!(e.m.gone(&ctx(), &repo, &p).await);
    assert_ne!(git(&repo, &["branch", "--list", "outside-branch"]), "");
}

#[tokio::test]
async fn remove_listed_rejects_unlisted_main_and_risky_paths() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_u, unlisted) = real_tmp();
    let escape = format!("{unlisted}{0}..{0}x", filepath::SEPARATOR);
    for p in [repo.as_str(), &unlisted, "", "a/b", &escape, "/"] {
        let res = e.m.remove_listed(&ctx(), &rm(&repo, p)).await;
        assert!(
            !res.removed && res.residue == RESIDUE_UNSAFE_PATH,
            "{p}: {res:?}"
        );
    }
    let res = e.m.remove_listed(&ctx(), &rm(&repo, &unlisted)).await;
    assert_eq!(
        res.detail,
        format!("등록된 worktree 가 아니다: \"{unlisted}\"")
    );
    assert!(exists(&filepath::join(&[repo, "README.md".into()])));
    assert!(exists(&unlisted));
}

#[tokio::test]
async fn remove_listed_rejects_main_queried_from_linked() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_o, linked) = outside_worktree(&repo, "linked");
    let res = e.m.remove_listed(&ctx(), &rm(&linked, &repo)).await;
    assert!(
        !res.removed && res.residue == RESIDUE_UNSAFE_PATH,
        "{res:?}"
    );
    assert_eq!(res.detail, "main worktree 는 제거하지 않는다");
    assert!(exists(&filepath::join(&[repo, "README.md".into()])));
}

#[tokio::test]
async fn remove_listed_dirty_needs_force() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_o, p) = outside_worktree(&repo, "dirty-branch");
    let work = filepath::join(&[p.clone(), "작업물.txt".into()]);
    std::fs::write(&work, "x\n").unwrap();
    let res = e.m.remove_listed(&ctx(), &rm(&repo, &p)).await;
    assert!(!res.removed && res.residue == RESIDUE_DIRTY, "{res:?}");
    assert!(exists(&work));
    let mut rs = rm(&repo, &p);
    rs.force = true;
    let res = e.m.remove_listed(&ctx(), &rs).await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");
    assert!(!exists(&p));
}

#[tokio::test]
async fn remove_listed_locked_is_reported_as_failure() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_o, p) = outside_worktree(&repo, "locked-branch");
    git(&repo, &["worktree", "lock", &p]);
    let mut rs = rm(&repo, &p);
    rs.force = true;
    let res = e.m.remove_listed(&ctx(), &rs).await;
    assert!(
        !res.removed && res.residue == RESIDUE_REMOVE_FAILED && !res.detail.is_empty(),
        "{res:?}"
    );
    assert!(exists(&p));
}

fn merged(repo: &str, sp: &Spec, into: &str) -> RemoveSpec {
    RemoveSpec {
        repo: repo.to_owned(),
        path: sp.path.clone(),
        branch: sp.branch.clone(),
        merge_into: into.to_owned(),
        require_merged: true,
        ..RemoveSpec::default()
    }
}

#[tokio::test]
async fn remove_require_merged_cases() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;

    let parent = create_tree(m, &repo, "parent", "dmn/run1234/parent", "main").await;
    let child = create_tree(m, &repo, "child", "dmn/run1234/child", "dmn/run1234/parent").await;
    commit_in(&child.path, "가지.txt");
    git(&parent.path, &["merge", "--ff-only", &child.branch]);
    let res = m
        .remove(&ctx(), &merged(&repo, &child, &parent.branch))
        .await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");
    assert_eq!(git(&repo, &["branch", "--list", &child.branch]), "");

    let sp = create_tree(m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    let res = m.remove(&ctx(), &merged(&repo, &sp, "")).await;
    assert_eq!(
        (res.residue.as_str(), res.detail.as_str()),
        (RESIDUE_UNMERGED, "병합 대상을 모른다")
    );
    let res = m.remove(&ctx(), &merged(&repo, &sp, "없는-브랜치")).await;
    assert_eq!(res.residue, RESIDUE_UNMERGED);
    commit_in(&sp.path, "새파일.txt");
    let res = m.remove(&ctx(), &merged(&repo, &sp, "main")).await;
    assert_eq!(
        (res.residue.as_str(), res.detail.as_str()),
        (
            RESIDUE_UNMERGED,
            "dmn/run1234/writer 가 main 에 병합되지 않았다"
        )
    );
    assert!(exists(&sp.path));
    assert_ne!(git(&repo, &["branch", "--list", &sp.branch]), "");
    let res = m.remove(&ctx(), &merged(&repo, &sp, "-x")).await;
    assert_eq!(
        res.detail,
        "병합을 판정할 수 없는 이름: \"dmn/run1234/writer\" → \"-x\""
    );

    let d = create_tree(m, &repo, "dirty", "dmn/run1234/dirty", "main").await;
    std::fs::write(
        filepath::join(&[d.path.clone(), "작업물.txt".into()]),
        "a\n",
    )
    .unwrap();
    let res = m.remove(&ctx(), &merged(&repo, &d, "main")).await;
    assert!(!res.removed && res.residue == RESIDUE_DIRTY, "{res:?}");

    let g = create_tree(m, &repo, "gone", "dmn/run1234/gone", "main").await;
    git(&repo, &["worktree", "remove", "--force", &g.path]);
    git(&repo, &["branch", "-D", &g.branch]);
    let res = m.remove(&ctx(), &merged(&repo, &g, "main")).await;
    assert!(res.removed && res.residue.is_empty(), "{res:?}");

    let h = create_tree(m, &repo, "half", "dmn/run1234/half", "main").await;
    commit_in(&h.path, "남은커밋.txt");
    git(&repo, &["worktree", "remove", "--force", &h.path]);
    let res = m.remove(&ctx(), &merged(&repo, &h, "main")).await;
    assert!(!res.removed && res.residue == RESIDUE_UNMERGED, "{res:?}");
    assert_ne!(git(&repo, &["branch", "--list", &h.branch]), "");
}

#[tokio::test]
async fn current_branch_and_main_root() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let m = &e.m;
    assert_eq!(m.current_branch(&ctx(), &repo).await, "main");
    let want = m.resolve(&ctx(), &repo, "").await.unwrap();
    let sp = create_tree(m, &repo, "mem5678", "dmn/run1234/writer", "main").await;
    for dir in [&repo, &sp.path] {
        assert_eq!(m.main_root(&ctx(), dir).await.unwrap(), want.root);
    }
    let (_t, plain) = real_tmp();
    assert!(m.main_root(&ctx(), &plain).await.is_err());
    git(&repo, &["checkout", "--detach", "HEAD"]);
    assert_eq!(m.current_branch(&ctx(), &repo).await, "");
}

#[tokio::test]
async fn prepare_remove_cases() {
    let e = temp_manager();
    let m = e.m.clone().with_runner(ok_runner());
    let repo = abs_repo();
    let inside = filepath::join(&[m.root(), "w"]);
    let res = m
        .remove(
            &ctx(),
            &rm(&repo, &format!("{repo}{}", filepath::SEPARATOR)),
        )
        .await;
    assert_eq!(res.residue, RESIDUE_UNSAFE_PATH);
    let res = m
        .remove_listed(
            &ctx(),
            &rm(&repo, &format!("{repo}{}", filepath::SEPARATOR)),
        )
        .await;
    assert_eq!(
        (res.residue.as_str(), res.detail.as_str()),
        (RESIDUE_UNSAFE_PATH, "저장소 자신은 제거하지 않는다")
    );
    let mut keep = rm(&repo, &inside);
    keep.keep = true;
    let res = m.remove(&ctx(), &keep).await;
    assert!(res.residue == RESIDUE_KEPT && res.detail.is_empty() && res.path == inside);
    // remove_listed 는 keep 을 보지 않는다 — 등록 확인으로 넘어간다.
    let res = m.remove_listed(&ctx(), &keep).await;
    assert_eq!(res.residue, RESIDUE_UNSAFE_PATH);
    assert!(res.detail.starts_with("등록된 worktree 가 아니다"));
}

#[tokio::test]
async fn prune_and_check_gone() {
    let Some(r) = temp_repo() else { return };
    let repo = s(r.path());
    let e = temp_manager();
    let (_o, p) = outside_worktree(&repo, "prune-branch");
    assert!(!e.m.prune_and_check_gone(&ctx(), &repo, &p).await);
    std::fs::remove_dir_all(&p).unwrap();
    assert!(e.m.prune_and_check_gone(&ctx(), &repo, &p).await);
    let out = git(&repo, &["worktree", "list", "--porcelain"]);
    assert!(!out.split('\n').any(|l| l == format!("worktree {p}")));
}

#[test]
fn result_json_shape() {
    let r = RemoveResult {
        path: "/p".into(),
        removed: true,
        ..RemoveResult::default()
    };
    assert_eq!(
        dm_gocompat::json::marshal(&r).unwrap(),
        br#"{"path":"/p","removed":true}"#
    );
    let r = RemoveResult {
        path: "/p".into(),
        branch: "b".into(),
        residue: RESIDUE_DIRTY.into(),
        detail: "d".into(),
        err: Some(Error::other("x")),
        ..RemoveResult::default()
    };
    assert_eq!(
        dm_gocompat::json::marshal(&r).unwrap(),
        br#"{"path":"/p","branch":"b","removed":false,"residue":"dirty","detail":"d"}"#
    );
    let sp = Spec {
        repo: "r".into(),
        lock_key: "k".into(),
        ..Spec::default()
    };
    assert_eq!(
        dm_gocompat::json::marshal(&sp).unwrap(),
        br#"{"repo":"r","path":"","branch":"","base":""}"#
    );
}
