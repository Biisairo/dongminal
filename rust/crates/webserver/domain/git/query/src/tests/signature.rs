use super::support::*;
use crate::*;
use otter_webserver_domain_git_core::Service;

#[tokio::test]
async fn signature_tracks_index_and_refs() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    let first = signature_of(&s, &bg(), p).await.unwrap();
    assert!(!first.head.is_empty() && first.ref_name == "refs/heads/main");
    assert!(
        first.index_mtime_ns != 0
            && first.index_size != 0
            && first.ref_mtime_ns != 0
            && !first.value.is_empty()
    );
    assert_eq!(signature_of(&s, &bg(), p).await.unwrap().value, first.value);
    write_file(p, "new.txt", "y\n");
    git_run(p, &["add", "new.txt"]);
    let after = signature_of(&s, &bg(), p).await.unwrap();
    assert_ne!(after.value, first.value);
    git_run(p, &["branch", "sig-probe"]);
    let added = signature_of(&s, &bg(), p).await.unwrap();
    assert_ne!(added.value, after.value);
    git_run(p, &["branch", "-D", "sig-probe"]);
    let removed = signature_of(&s, &bg(), p).await.unwrap();
    assert_ne!(removed.value, added.value);
    git_run(p, &["branch", "packed-probe"]);
    let before = signature_of(&s, &bg(), p).await.unwrap();
    git_run(p, &["pack-refs", "--all"]);
    assert_ne!(
        signature_of(&s, &bg(), p).await.unwrap().value,
        before.value
    );
}

#[tokio::test]
async fn signature_packed_refs_only() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    git_run(p, &["pack-refs", "--all"]);
    let s = Service::new();
    let (git_dir, common) = s.git_dirs(&bg(), p).await.unwrap();
    if std::fs::metadata(format!("{git_dir}/refs/heads/main")).is_ok()
        || std::fs::metadata(format!("{common}/packed-refs")).is_err()
    {
        return;
    }
    let sig = signature_of(&s, &bg(), p).await.unwrap();
    assert!(sig.ref_name == "refs/heads/main" && sig.ref_mtime_ns != 0);
}

#[tokio::test]
async fn signature_missing_index_and_detached() {
    let dir = temp_dir();
    write_file(&dir.path, "HEAD", "ref: refs/heads/main\n");
    let d = dir.path.clone();
    let s = fake_by(move |_| out(&format!("{d}\n{d}\n"), "", 0));
    let sig = signature_of(&s, &bg(), &abs_r()).await.unwrap();
    assert!(sig.index_mtime_ns == 0 && sig.index_size == 0 && sig.ref_mtime_ns == 0);
    assert!(sig.head == "ref: refs/heads/main" && sig.ref_name == "refs/heads/main");
    let oid = "1".repeat(40);
    write_file(&dir.path, "HEAD", &format!("{oid}\n"));
    let sig = signature_of(&s, &bg(), &abs_r()).await.unwrap();
    assert!(sig.head == oid && sig.ref_name.is_empty());
    assert!(
        sig.value.starts_with(&format!("{oid}|0|0||0|")),
        "{}",
        sig.value
    );
    let empty = temp_dir();
    let e = read_signature(&empty.path, &empty.path).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("open {}/HEAD: no such file or directory", empty.path)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn signature_ref_add_survives_stale_dir_mtime() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    // git 판에 따라(예: 2.39) 느슨한 ref 를 지울 때 packed-refs 를 새로 쓴다. 미리 만들어 두고 그
    // mtime 도 함께 고정해, 전제(mtime 근거가 그대로다)가 git 판과 무관하게 서게 한다.
    git_run(p, &["pack-refs", "--all"]);
    let dirs = [
        format!("{p}/.git/refs"),
        format!("{p}/.git/refs/heads"),
        format!("{p}/.git/packed-refs"),
    ];
    let pin = || {
        let mts: Vec<std::time::SystemTime> = dirs
            .iter()
            .map(|d| std::fs::metadata(d).unwrap().modified().unwrap())
            .collect();
        let dirs = dirs.clone();
        move || {
            for (d, mt) in dirs.iter().zip(&mts) {
                let f = std::fs::File::open(d).unwrap();
                f.set_times(
                    std::fs::FileTimes::new()
                        .set_modified(*mt)
                        .set_accessed(*mt),
                )
                .unwrap();
            }
        }
    };
    let first = signature_of(&s, &bg(), p).await.unwrap();
    let restore = pin();
    git_run(p, &["branch", "sig-probe"]);
    restore();
    let added = signature_of(&s, &bg(), p).await.unwrap();
    assert_eq!(added.refs_mtime_ns, first.refs_mtime_ns);
    assert_ne!(added.refs_shape, first.refs_shape);
    assert_ne!(added.value, first.value);
    let restore = pin();
    git_run(p, &["branch", "-D", "sig-probe"]);
    restore();
    let removed = signature_of(&s, &bg(), p).await.unwrap();
    assert_eq!(removed.refs_mtime_ns, added.refs_mtime_ns);
    assert_ne!(removed.value, added.value);
    assert_eq!(removed.refs_shape, first.refs_shape);
}

// preflight 는 git 두 번이다 (FR-OPT-7-3). 실행 기록으로 센다.
#[tokio::test]
async fn preflight_two_processes_and_config_semantics() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    git_run(p, &["config", "commit.gpgsign", "yes"]);
    git_run(p, &["config", "commit.template", "tmpl.txt"]);
    write_file(p, "tmpl.txt", "subject\n");
    let s = Service::new();
    let pf = preflight_of(&s, &bg(), p).await.unwrap();
    assert_eq!(s.records(0).len(), 2);
    assert!(
        pf.blocks.is_empty() && pf.warnings.is_empty() && pf.gpg_sign && pf.template == "subject\n"
    );

    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    git_run(p, &["config", "--unset", "user.name"]);
    git_run(p, &["config", "--add", "commit.gpgSign", "true"]);
    git_run(p, &["config", "--add", "commit.gpgSign", "false"]);
    git_run(p, &["config", "commit.template", "x\nuser.name=spoof"]);
    let pf = preflight_of(&Service::new(), &bg(), p).await.unwrap();
    assert!(!pf.gpg_sign);
    if pf.blocks.is_empty() {
        return; // 전역 user.name 이 있는 환경
    }
    assert!(
        pf.blocks.len() == 1
            && pf.blocks[0].code == BLOCK_IDENTITY_MISSING
            && pf.blocks[0].reason.contains("user.name")
    );
}

#[tokio::test]
async fn preflight_detached_from_head_file() {
    let Some(repo) = git_repo() else { return };
    git_run(&repo.path, &["checkout", "-q", "--detach"]);
    let pf = preflight_of(&Service::new(), &bg(), &repo.path)
        .await
        .unwrap();
    assert!(pf.warnings.len() == 1 && pf.warnings[0].code == WARN_DETACHED_HEAD);
    let unborn = git_init();
    let pf = preflight_of(&Service::new(), &bg(), &unborn.path)
        .await
        .unwrap();
    assert!(pf.warnings.is_empty());
}
