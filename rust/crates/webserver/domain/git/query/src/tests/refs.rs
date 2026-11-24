use std::collections::HashMap;

use super::hunk_log::log_real_repo;
use super::support::*;
use crate::*;
use otter_webserver_domain_git_core::{Kind, Service};

fn rr(f: [&str; 7]) -> String {
    f.join("\0")
}

fn stream(recs: &[String]) -> String {
    recs.join("\n") + "\n"
}

#[test]
fn parse_refs_kinds() {
    let rs = parse_refs(&stream(&[
        rr([
            "refs/heads/main",
            "aa",
            "origin/main",
            "[ahead 2, behind 1]",
            "*",
            "머지 side",
            "1700000000",
        ]),
        rr([
            "refs/heads/feature/a b",
            "bb",
            "",
            "",
            " ",
            "기능 작업",
            "1700000001",
        ]),
        rr([
            "refs/remotes/origin/main",
            "cc",
            "",
            "",
            " ",
            "머지 side",
            "1700000002",
        ]),
        rr([
            "refs/tags/v1.0",
            "dd",
            "",
            "",
            " ",
            "태그가 가리키는 제목",
            "1700000003",
        ]),
    ]))
    .unwrap();
    let r = |n: &str, s: &str, k: &str, o: &str, sub: &str, at: i64| Ref {
        name: n.into(),
        short: s.into(),
        kind: k.into(),
        oid: o.into(),
        subject: sub.into(),
        at_unix_ms: at,
        ..Ref::default()
    };
    let main = Ref {
        upstream: "origin/main".into(),
        ahead: 2,
        behind: 1,
        is_head: true,
        ..r(
            "refs/heads/main",
            "main",
            REF_KIND_LOCAL,
            "aa",
            "머지 side",
            1700000000000,
        )
    };
    assert_eq!(
        rs,
        [
            main,
            r(
                "refs/heads/feature/a b",
                "feature/a b",
                REF_KIND_LOCAL,
                "bb",
                "기능 작업",
                1700000001000
            ),
            r(
                "refs/remotes/origin/main",
                "origin/main",
                REF_KIND_REMOTE,
                "cc",
                "머지 side",
                1700000002000
            ),
            r(
                "refs/tags/v1.0",
                "v1.0",
                REF_KIND_TAG,
                "dd",
                "태그가 가리키는 제목",
                1700000003000
            ),
        ]
    );
    assert_eq!(
        json(&rs[3]),
        r#"{"name":"refs/tags/v1.0","short":"v1.0","kind":"tag","oid":"dd","ahead":0,"behind":0,"isHead":false,"subject":"태그가 가리키는 제목","atUnixMs":1700000003000}"#
    );
}

#[test]
fn parse_refs_track_and_edges() {
    for (track, a, b, g) in [
        ("", 0, 0, false),
        ("[ahead 2]", 2, 0, false),
        ("[behind 3]", 0, 3, false),
        ("[ahead 2, behind 1]", 2, 1, false),
        ("[gone]", 0, 0, true),
    ] {
        let rs = parse_refs(&stream(&[rr([
            "refs/heads/main",
            "aa",
            "origin/main",
            track,
            " ",
            "s",
            "1",
        ])]))
        .unwrap();
        assert_eq!(
            (rs[0].ahead, rs[0].behind, rs[0].gone),
            (a, b, g),
            "{track}"
        );
    }
    let bad = stream(&[
        rr(["refs/heads/main", "aa", "", "", "*", "s", "1"]),
        "refs/heads/side\0bb\0".into(),
    ]);
    assert!(parse_refs(&bad).is_err());
    let rs = parse_refs(&stream(&[rr([
        "refs/tags/v2.0",
        "dd",
        "",
        "",
        " ",
        "annotated",
        "",
    ])]))
    .unwrap();
    assert!(rs[0].at_unix_ms == 0 && rs[0].kind == REF_KIND_TAG);
    assert!(parse_refs("").unwrap().is_empty());
}

#[test]
fn parse_refs_tag_order() {
    let shorts = |rs: Vec<Ref>| rs.into_iter().map(|r| r.short).collect::<Vec<_>>();
    let rs = parse_refs(&stream(&[
        rr(["refs/tags/v1.10", "aa", "", "", " ", "십", "1700000010"]),
        rr(["refs/tags/v1.2", "bb", "", "", " ", "이", "1700000002"]),
        rr(["refs/tags/v1.9", "cc", "", "", " ", "구", "1700000009"]),
    ]))
    .unwrap();
    assert_eq!(shorts(rs), ["v1.10", "v1.9", "v1.2"]);
    let rs = parse_refs(&stream(&[
        rr(["refs/heads/main", "aa", "", "", "*", "메인", "1700000001"]),
        rr(["refs/tags/v1.0", "bb", "", "", " ", "일", "1700000002"]),
        rr(["refs/heads/zzz", "cc", "", "", " ", "제트", "1700000003"]),
        rr(["refs/tags/v2.0", "dd", "", "", " ", "이", "1700000009"]),
    ]))
    .unwrap();
    assert_eq!(shorts(rs), ["main", "v2.0", "zzz", "v1.0"]);
    let rs = parse_refs(&stream(&[
        rr(["refs/tags/a", "aa", "", "", " ", "", "1700000000"]),
        rr(["refs/tags/b", "bb", "", "", " ", "", "1700000000"]),
    ]))
    .unwrap();
    assert_eq!(shorts(rs), ["b", "a"]);
}

#[tokio::test]
async fn refs_argv_and_real_git() {
    let (s, seen) = fake(out("", "", 0));
    refs(&s, &bg(), &abs_repo()).await.unwrap();
    assert!(
        seen.lock().unwrap()[0]
            .join(" ")
            .ends_with(" refs/heads refs/remotes refs/tags")
    );
    assert!(seen.lock().unwrap()[0][1].starts_with("--format=%(refname)%00%(objectname)"));

    let Some(repo) = log_real_repo() else { return };
    let p = repo.path.as_str();
    let remote = temp_dir();
    git_run(&remote.path, &["init", "-q", "--bare", &remote.path]);
    git_run(p, &["remote", "add", "origin", &remote.path]);
    git_run(p, &["push", "-q", "-u", "origin", "main"]);
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "ahead 1"]);
    git_run(p, &["tag", "-a", "v2.0", "-m", "annotated 태그 메시지"]);
    let rs = refs(&Service::new(), &bg(), p).await.unwrap();
    let by: HashMap<&str, &Ref> = rs.iter().map(|r| (r.name.as_str(), r)).collect();
    let main = by["refs/heads/main"];
    assert!(
        main.short == "main"
            && main.kind == REF_KIND_LOCAL
            && main.is_head
            && main.oid.len() == 40
            && main.at_unix_ms != 0
    );
    assert!(main.upstream == "origin/main" && main.ahead == 1 && main.behind == 0);
    let side = by["refs/heads/side"];
    assert!(!side.is_head && side.upstream.is_empty());
    let r = by["refs/remotes/origin/main"];
    assert!(r.kind == REF_KIND_REMOTE && r.short == "origin/main");
    for t in ["refs/tags/v1.0", "refs/tags/v2.0"] {
        assert!(by[t].kind == REF_KIND_TAG && by[t].at_unix_ms != 0);
    }
}

#[tokio::test]
async fn branch_name_and_oid() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    git_run(p, &["branch", "feat"]);
    let s = Service::new();
    for n in ["feat", "feat/a-b", "릴리스/1.0"] {
        valid_branch_name(&s, &bg(), p, n).await.unwrap();
    }
    for n in [
        "bad name",
        "x..y",
        "a.lock",
        "-lead",
        "he@{ad",
        "back\\slash",
        "@{-1}",
    ] {
        let e = valid_branch_name(&s, &bg(), p, n).await.unwrap_err();
        assert!(e.is_core(Kind::RefName), "{n}: {e}");
    }
    let e = valid_branch_name(&s, &bg(), p, "bad name")
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "ref_name_invalid: \"bad name\" 는 git 의 브랜치 이름 규칙을 어긴다"
    );
    assert_eq!(branch_oid(&s, &bg(), p, "feat").await.unwrap().len(), 40);
    assert!(branch_oid(&s, &bg(), p, "nope").await.is_err());
    assert!(local_branch_exists(&s, &bg(), p, "feat").await.unwrap());
    assert!(!local_branch_exists(&s, &bg(), p, "nope").await.unwrap());
    assert!(has_head(&s, &bg(), p).await.unwrap());
    let empty = git_init();
    assert!(!has_head(&s, &bg(), &empty.path).await.unwrap());
    assert_eq!(branch_upstream(&s, &bg(), p, "feat").await.unwrap(), "");
    assert_eq!(
        branch_upstream_target(&s, &bg(), p, "feat").await.unwrap(),
        UpstreamTarget::default()
    );
}

#[tokio::test]
async fn tag_name_and_oid() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    valid_tag_name(&s, &bg(), p, "v1.0").await.unwrap();
    for n in ["bad name", "a..b", "-x", "a.lock"] {
        assert!(
            valid_tag_name(&s, &bg(), p, n)
                .await
                .unwrap_err()
                .is_core(Kind::RefName),
            "{n}"
        );
    }
    let e = valid_tag_name(&s, &bg(), p, "a//b").await.unwrap_err();
    assert_eq!(
        e.to_string(),
        "ref_name_invalid: \"a//b\" 는 git 이 \"a/b\" 로 고쳐 읽는 이름이다"
    );
    git_run(p, &["tag", "v1"]);
    assert!(
        tag_exists(&s, &bg(), p, "v1").await.unwrap()
            && !tag_exists(&s, &bg(), p, "v9").await.unwrap()
    );
    assert_eq!(tag_oid(&s, &bg(), p, "v1").await.unwrap().len(), 40);
}

#[tokio::test]
async fn branch_merged_criteria() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    git_run(p, &["branch", "merged"]);
    assert!(branch_merged(&s, &bg(), p, "merged").await.unwrap());
    git_run(p, &["checkout", "-q", "-b", "unmerged"]);
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "only-here"]);
    git_run(p, &["checkout", "-q", "main"]);
    assert!(!branch_merged(&s, &bg(), p, "unmerged").await.unwrap());

    git_run(p, &["remote", "add", "origin", p]);
    git_run(p, &["branch", "test"]);
    git_run(p, &["config", "branch.test.remote", "origin"]);
    git_run(p, &["config", "branch.test.merge", "refs/heads/test"]);
    assert!(branch_merged(&s, &bg(), p, "test").await.unwrap());
    git_run(p, &["checkout", "-q", "test"]);
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "only-here"]);
    git_run(p, &["checkout", "-q", "main"]);
    assert!(!branch_merged(&s, &bg(), p, "test").await.unwrap());
}

#[tokio::test]
async fn merge_preview_counts() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    git_run(p, &["checkout", "-q", "-b", "side"]);
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "s1"]);
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "s2"]);
    git_run(p, &["checkout", "-q", "main"]);
    let im = merge_preview(&s, &bg(), p, "side").await.unwrap();
    assert!(im.fast_forward && im.incoming == 2 && im.diverged == 0 && !im.up_to_date);
    assert_eq!(
        json(&im),
        r#"{"ref":"side","ff":true,"incoming":2,"diverged":0,"upToDate":false}"#
    );
    git_run(p, &["commit", "-q", "--allow-empty", "-m", "m1"]);
    let im = merge_preview(&s, &bg(), p, "side").await.unwrap();
    assert!(!im.fast_forward && im.incoming == 2 && im.diverged == 1);
    git_run(p, &["merge", "-q", "--no-edit", "side"]);
    let im = merge_preview(&s, &bg(), p, "side").await.unwrap();
    assert!(im.up_to_date && im.incoming == 0);
    assert!(
        merge_preview(&s, &bg(), p, "-x")
            .await
            .unwrap_err()
            .is_core(Kind::RefName)
    );
}

fn remotes_svc(config: &'static str) -> Service {
    fake_by(move |a| {
        if a[0] == "config" {
            out(config, "", 0)
        } else {
            out("", "", 0)
        }
    })
}

#[tokio::test]
async fn remotes_cases() {
    let s = remotes_svc(
        "core.bare=false\nremote.origin.url=https://example.test/a.git\nremote.origin.fetch=+refs/heads/*:refs/remotes/origin/*\nremote.upstream.url=git@example.test:b/c.git\nremote.upstream.pushurl=git@example.test:b/c-push.git\nremote.pushdefault=origin\n",
    );
    let got = remotes(&s, &bg(), &abs_repo()).await.unwrap();
    assert_eq!(got.len(), 2);
    assert!(got[0].name == "origin" && got[0].url == "https://example.test/a.git");
    assert!(got[1].name == "upstream" && got[1].push_url == "git@example.test:b/c-push.git");
    assert_eq!(
        json(&got[0]),
        r#"{"name":"origin","url":"https://example.test/a.git"}"#
    );
    assert_eq!(
        default_remote(&s, &bg(), &abs_repo()).await.unwrap(),
        "origin"
    );

    let s = remotes_svc(
        "remote.origin.url=https://user:abc123@example.test/a.git\nremote.origin.pushurl=https://ghp_zzzz@example.test/a.git\n",
    );
    let got = remotes(&s, &bg(), &abs_repo()).await.unwrap();
    assert!(
        got.len() == 1
            && !got[0].url.contains("abc123")
            && !got[0].push_url.contains("ghp_zzzz")
            && got[0].url.contains("example.test")
    );

    let s = remotes_svc("remote.my.fork.url=/tmp/f.git\n");
    assert_eq!(
        remotes(&s, &bg(), &abs_repo()).await.unwrap()[0].name,
        "my.fork"
    );
    assert_eq!(
        default_remote(&s, &bg(), &abs_repo()).await.unwrap(),
        "my.fork"
    );

    let s = remotes_svc("core.bare=false\n");
    assert!(remotes(&s, &bg(), &abs_repo()).await.unwrap().is_empty());
    let e = default_remote(&s, &bg(), &abs_repo()).await.unwrap_err();
    assert!(e.is(QueryKind::NoRemote) && e.to_string() == "no_remote: 원격이 없다");
    let s = remotes_svc("remote.b.url=x\nremote.a.url=y\n");
    let e = default_remote(&s, &bg(), &abs_repo()).await.unwrap_err();
    assert_eq!(
        e.to_string(),
        "no_remote: 원격이 2 개이고 origin 이 없다: [a b]"
    );
}

const MSG: &str = "제목 줄\n\n본문 첫 줄\n본문 둘째 줄";

#[tokio::test]
async fn last_and_head_commit() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    git_run(
        p,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "--cleanup=strip",
            "-m",
            MSG,
        ],
    );
    let s = Service::new();
    assert_eq!(last_commit_message(&s, &bg(), p).await.unwrap(), MSG);
    let recs = s.records(0);
    assert!(recs.len() == 1 && recs[0].argv()[0] == "log");
    let want = git_run(p, &["rev-parse", "HEAD"]);
    assert_eq!(
        head_commit(&s, &bg(), p).await.unwrap(),
        (want, MSG.to_owned())
    );
}
