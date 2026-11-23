//! Go `remote_live_test.go`. 원격은 로컬 bare 저장소다 — 네트워크가 필요 없다.

use dm_webserver_domain_git_core::Service;

use super::support::*;
use crate::*;

/// bare 원격 하나와 그것을 origin 으로 둔 클론 둘(ours·theirs).
struct Live {
    svc: Service,
    ours: String,
    theirs: String,
    bare: String,
    _seed: Fx,
    _base: Fx,
}

fn live_remote() -> Option<Live> {
    let seed = temp_repo()?;
    let base = temp_fx();
    let bare = base.join("origin.git").to_string_lossy().into_owned();
    git_run(base.dir(), &["init", "-q", "--bare", "-b", "main", &bare]);
    git_run(seed.dir(), &["remote", "add", "origin", &bare]);
    git_run(seed.dir(), &["push", "-q", "-u", "origin", "main"]);
    let ours = base.join("ours").to_string_lossy().into_owned();
    let theirs = base.join("theirs").to_string_lossy().into_owned();
    git_run(base.dir(), &["clone", "-q", &bare, &ours]);
    git_run(base.dir(), &["clone", "-q", &bare, &theirs]);
    for d in [&ours, &theirs] {
        let d = std::path::Path::new(d);
        git_run(d, &["config", "user.email", "t@example.com"]);
        git_run(d, &["config", "user.name", "tester"]);
        git_run(d, &["config", "commit.gpgsign", "false"]);
    }
    Some(Live {
        svc: Service::new(),
        ours,
        theirs,
        bare,
        _seed: seed,
        _base: base,
    })
}

fn commit_file(dir: &str, name: &str, body: &str) {
    let d = std::path::Path::new(dir);
    write_file(d, name, body);
    git_run(d, &["add", name]);
    git_run(d, &["commit", "-q", "-m", &format!("add {name}")]);
}

async fn rev_list(dir: &str, r: &str) -> u64 {
    let o = Service::new()
        .exec(&bg(), dir, &["rev-list", "--count", r])
        .await
        .unwrap();
    let s = o.stdout_str();
    s.trim()
        .parse()
        .unwrap_or_else(|_| panic!("rev-list 가 숫자가 아닌 것을 답했다: {s:?}"))
}

#[tokio::test]
async fn live_push_reaches_remote() {
    let Some(l) = live_remote() else { return };
    commit_file(&l.ours, "ours.txt", "1\n");
    let before = rev_list(&l.bare, "main").await;
    let (res, _) = push_spec(&l.svc, &bg(), &l.ours, &PushOpts::default()).await;
    let spec = res.unwrap();
    l.svc.exec_write(&bg(), &l.ours, &spec).await.unwrap();
    assert_eq!(rev_list(&l.bare, "main").await, before + 1);
}

#[tokio::test]
async fn live_fetch_sees_their_commit() {
    let Some(l) = live_remote() else { return };
    commit_file(&l.theirs, "theirs.txt", "1\n");
    git_run(
        std::path::Path::new(&l.theirs),
        &["push", "-q", "origin", "main"],
    );
    let before = rev_list(&l.ours, "origin/main").await;
    l.svc
        .exec_write(&bg(), &l.ours, &fetch_spec(&FetchOpts::default()))
        .await
        .unwrap();
    assert_eq!(rev_list(&l.ours, "origin/main").await, before + 1);
    assert_eq!(
        rev_list(&l.ours, "HEAD").await,
        before,
        "fetch 가 HEAD 를 옮겼다"
    );
}

#[tokio::test]
async fn live_pull_merges_their_commit() {
    let Some(l) = live_remote() else { return };
    commit_file(&l.theirs, "theirs.txt", "1\n");
    git_run(
        std::path::Path::new(&l.theirs),
        &["push", "-q", "origin", "main"],
    );
    let before = rev_list(&l.ours, "HEAD").await;
    let spec = pull_spec(&PullOpts {
        mode: PULL_FF_ONLY.into(),
    })
    .unwrap();
    l.svc.exec_write(&bg(), &l.ours, &spec).await.unwrap();
    assert_eq!(rev_list(&l.ours, "HEAD").await, before + 1);
    assert!(std::path::Path::new(&l.ours).join("theirs.txt").exists());
}

#[tokio::test]
async fn live_pull_ff_only_refuses_divergence() {
    let Some(l) = live_remote() else { return };
    commit_file(&l.theirs, "theirs.txt", "1\n");
    git_run(
        std::path::Path::new(&l.theirs),
        &["push", "-q", "origin", "main"],
    );
    commit_file(&l.ours, "ours.txt", "1\n");
    let spec = pull_spec(&PullOpts {
        mode: PULL_FF_ONLY.into(),
    })
    .unwrap();
    assert!(
        l.svc.exec_write(&bg(), &l.ours, &spec).await.is_err(),
        "갈라진 히스토리에서 --ff-only 가 통과했다"
    );
}

#[tokio::test]
async fn live_publish_sets_upstream() {
    let Some(l) = live_remote() else { return };
    git_run(
        std::path::Path::new(&l.ours),
        &["checkout", "-q", "-b", "feature"],
    );
    commit_file(&l.ours, "feature.txt", "1\n");
    let ctx = bg();
    let (res, plan) = push_spec(&l.svc, &ctx, &l.ours, &PushOpts::default()).await;
    assert!(res.is_err(), "확인 없이 통과했다 (plan={plan:?})");
    let (res, _) = push_spec(
        &l.svc,
        &ctx,
        &l.ours,
        &PushOpts {
            publish: true,
            ..PushOpts::default()
        },
    )
    .await;
    let spec = res.unwrap();
    l.svc.exec_write(&ctx, &l.ours, &spec).await.unwrap();
    assert_ne!(rev_list(&l.bare, "feature").await, 0);
    let (res, _) = push_spec(&l.svc, &ctx, &l.ours, &PushOpts::default()).await;
    res.unwrap();
}
