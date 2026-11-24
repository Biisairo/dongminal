use std::collections::HashMap;

use super::hunk_log::log_real_repo;
use super::support::*;
use crate::log::{LOG_DECORATE, LOG_FORMAT};
use crate::*;
use otter_webserver_domain_git_core::{Output, Service};

const PORCELAIN: &str = "1111111111111111111111111111111111111111 1 1 2\nauthor 김 동민\nauthor-mail <dy@example.com>\nauthor-time 1700000000\nauthor-tz +0900\nsummary 첫 커밋 · 유니코드\nfilename f.txt\n\ta\n1111111111111111111111111111111111111111 2 2\n\t\t들여쓴 줄\n2222222222222222222222222222222222222222 3 3 1\nauthor tester\nauthor-mail <t@example.com>\nauthor-time 1700000060\nauthor-tz +0900\nsummary 둘째\nprevious 1111111111111111111111111111111111111111 f.txt\nfilename f.txt\n\tc\n";

#[test]
fn parse_blame_lines_and_commits() {
    let b = parse_blame(PORCELAIN).unwrap();
    let got: Vec<(&str, i64, &str)> = b
        .lines
        .iter()
        .map(|l| (l.oid.as_str(), l.line, l.text.as_str()))
        .collect();
    let one = "1".repeat(40);
    let two = "2".repeat(40);
    assert_eq!(
        got,
        [
            (one.as_str(), 1, "a"),
            (one.as_str(), 2, "\t들여쓴 줄"),
            (two.as_str(), 3, "c")
        ]
    );
    assert_eq!(b.commits.len(), 2);
    let c = &b.commits[&one];
    assert!(
        c.author_name == "김 동민"
            && c.author_mail == "dy@example.com"
            && c.author_at == 1700000000000
    );
    assert!(c.summary == "첫 커밋 · 유니코드" && !c.uncommitted);
}

#[test]
fn parse_blame_edges() {
    let out = "0000000000000000000000000000000000000000 1 1 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\nauthor-time 1700000000\nsummary Version of f.txt from f.txt\nfilename f.txt\n\t새 줄\n";
    let b = parse_blame(out).unwrap();
    assert!(
        b.lines.len() == 1 && b.lines[0].text == "새 줄" && b.commits[&b.lines[0].oid].uncommitted
    );
    let oid = "ab".repeat(32);
    let null = "0".repeat(64);
    let out = format!(
        "{oid} 1 1 1\nauthor tester\nsummary 첫\nfilename f.txt\n\ta\n{null} 2 2 1\nauthor Not Committed Yet\nfilename f.txt\n\tb\n"
    );
    let b = parse_blame(&out).unwrap();
    assert!(b.lines[0].oid == oid && b.lines[1].oid == null);
    assert!(
        !b.commits[&oid].uncommitted
            && b.commits[&oid].author_name == "tester"
            && b.commits[&null].uncommitted
    );
    let b = parse_blame("").unwrap();
    assert!(b.lines.is_empty() && b.commits.is_empty());
    assert_eq!(
        json(&b),
        r#"{"repo":"","rev":"","path":"","lines":[],"commits":{}}"#
    );
    let e = parse_blame("\ta\n").unwrap_err();
    assert!(e.is(QueryKind::BlameParse));
    assert_eq!(e.to_string(), "blame_parse: 헤더 없는 본문 줄: \"\\ta\"");
}

#[tokio::test]
async fn blame_argv_and_rejects() {
    for (rev, path, want) in [
        ("", "d ir/한글.txt", "blame --porcelain -- d ir/한글.txt"),
        ("HEAD~1", "f.txt", "blame --porcelain HEAD~1 -- f.txt"),
    ] {
        let (s, seen) = fake(Output::default());
        blame(
            &s,
            &bg(),
            &BlameQuery {
                repo: abs_repo(),
                rev: rev.into(),
                path: path.into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(seen.lock().unwrap()[0].join(" "), want);
    }
    let (s, seen) = fake(Output::default());
    let q = BlameQuery {
        repo: abs_repo(),
        rev: "--all".into(),
        path: "f.txt".into(),
    };
    assert!(
        blame(&s, &bg(), &q)
            .await
            .unwrap_err()
            .is(QueryKind::UnsafeRev)
    );
    let q = BlameQuery {
        repo: abs_repo(),
        rev: String::new(),
        path: "../etc/passwd".into(),
    };
    assert!(blame(&s, &bg(), &q).await.is_err());
    assert!(seen.lock().unwrap().is_empty());
    let (s, _) = fake(Output {
        stdout_truncated: true,
        ..out(PORCELAIN, "", 0)
    });
    let q = BlameQuery {
        repo: abs_repo(),
        rev: String::new(),
        path: "f.txt".into(),
    };
    assert!(
        blame(&s, &bg(), &q)
            .await
            .unwrap_err()
            .is(QueryKind::BlameTruncated)
    );
}

#[tokio::test]
async fn blame_real_git() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let commit = |body: &str, msg: &str| {
        write_file(p, "f.txt", body);
        git_run(p, &["add", "-A"]);
        git_run(p, &["commit", "-q", "-m", msg]);
    };
    commit("a\nb\n", "첫 줄들");
    commit("a\nBB\n", "둘째 줄 고침");
    write_file(p, "f.txt", "a\nBB\n아직 커밋 안 함\n");
    let s = Service::new();
    let q = |rev: &str, path: &str| BlameQuery {
        repo: p.into(),
        rev: rev.into(),
        path: path.into(),
    };
    let b = blame(&s, &bg(), &q("", "f.txt")).await.unwrap();
    assert_eq!(b.lines.len(), 3);
    assert_ne!(b.lines[0].oid, b.lines[1].oid);
    assert_eq!(b.commits[&b.lines[0].oid].summary, "첫 줄들");
    assert_eq!(b.commits[&b.lines[1].oid].summary, "둘째 줄 고침");
    assert!(b.commits[&b.lines[2].oid].uncommitted && b.lines[2].text == "아직 커밋 안 함");
    let b = blame(&s, &bg(), &q("HEAD~1", "f.txt")).await.unwrap();
    assert!(b.lines.len() == 2 && b.lines[1].text == "b");
    let e = blame(&s, &bg(), &q("", "없는파일.txt")).await.unwrap_err();
    assert!(e.is(QueryKind::BlamePathNotFound));
    assert_eq!(e.to_string(), "blame_path_not_found: 없는파일.txt");
}

#[test]
fn parse_name_status() {
    let out = "M\0a.txt\0R100\0old name.txt\0d ir/한글 파일.txt\0A\0b.txt\0C75\0src.txt\0copy.txt\0D\0gone.txt\0T\0link\0";
    let f = |s: &str, p: &str, o: &str, sc: i64| CommitFile {
        status: s.into(),
        path: p.into(),
        orig_path: o.into(),
        score: sc,
    };
    assert_eq!(
        parse_name_status_z(out).unwrap(),
        [
            f("M", "a.txt", "", 0),
            f("R", "d ir/한글 파일.txt", "old name.txt", 100),
            f("A", "b.txt", "", 0),
            f("C", "copy.txt", "src.txt", 75),
            f("D", "gone.txt", "", 0),
            f("T", "link", "", 0),
        ]
    );
    assert!(parse_name_status_z("").unwrap().is_empty());
    for bad in ["M\0", "R100\0old.txt\0", "\0a.txt\0"] {
        assert!(parse_name_status_z(bad).is_err(), "{bad:?}");
    }
}

const OID: &str = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

fn detail_rec(parents: &str, dec: &str, subject: &str, body: &str) -> String {
    [
        OID,
        &OID[..4],
        parents,
        "김 동민",
        "dy@example.com",
        "1700000000",
        "1700000060",
        dec,
        subject,
        "커미터",
        "c@example.com",
        body,
    ]
    .join("\0")
}

fn detail_svc(
    log: String,
    tree: &'static str,
) -> (Service, std::sync::Arc<std::sync::Mutex<Vec<Vec<String>>>>) {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let s = Service::builder()
        .runner(runner(move |_, _, a| {
            let o = if a[0] == "log" {
                out(&log, "", 0)
            } else {
                out(tree, "", 0)
            };
            s2.lock().unwrap().push(a);
            Ok(o)
        }))
        .build();
    (s, seen)
}

#[tokio::test]
async fn commit_detail_argv_and_fields() {
    let log_call = format!("log -z {LOG_FORMAT}%x00%cn%x00%ce%x00%B {LOG_DECORATE} -n 1 {OID}");
    let tree = "diff-tree --no-commit-id --name-status -r -z -M ";
    for (parents, idx, want_tree, want_idx) in [
        ("p1", 0, format!("{tree}{OID}^1 {OID}"), 0),
        ("p1 p2", 1, format!("{tree}{OID}^2 {OID}"), 1),
        ("", 0, format!("{tree}--root {OID}"), COMMIT_NO_PARENT),
    ] {
        let (s, seen) = detail_svc(detail_rec(parents, "", "s", "s\n"), "M\0a.txt\0");
        let d = commit_detail_of(&s, &bg(), &abs_repo(), OID, idx)
            .await
            .unwrap();
        let calls: Vec<String> = seen.lock().unwrap().iter().map(|a| a.join(" ")).collect();
        assert_eq!(calls, [log_call.clone(), want_tree]);
        assert_eq!(d.parent_index, want_idx);
    }
    let body = "제목 줄\n\n본문 첫 줄\n본문 둘째 줄\n";
    let (s, _) = detail_svc(
        detail_rec("p1 p2", "HEAD -> refs/heads/main", "제목 줄", body),
        "A\0new.txt\0",
    );
    let d = commit_detail_of(&s, &bg(), &abs_repo(), OID, 0)
        .await
        .unwrap();
    assert!(d.commit.oid == OID && d.commit.subject == "제목 줄" && d.body == body);
    assert!(d.committer_name == "커미터" && d.committer_mail == "c@example.com");
    assert!(d.commit.parents.len() == 2 && d.commit.is_head && d.files[0].path == "new.txt");
    let j = json(&d);
    assert!(
        j.starts_with(&format!(
            "{{\"oid\":\"{OID}\",\"abbrev\":\"a1b2\",\"parents\":[\"p1\",\"p2\"]"
        )),
        "{j}"
    );
    assert!(j.ends_with(r#""isHead":true,"committerName":"커미터","committerMail":"c@example.com","body":"제목 줄\n\n본문 첫 줄\n본문 둘째 줄\n","files":[{"status":"A","path":"new.txt"}],"parentIndex":0}"#), "{j}");
}

#[tokio::test]
async fn commit_detail_rejects() {
    for (parents, idx) in [("p1", -1), ("p1", 1), ("p1 p2", 2), ("", 1)] {
        let (s, seen) = detail_svc(detail_rec(parents, "", "s", "s\n"), "");
        let e = commit_detail_of(&s, &bg(), &abs_repo(), OID, idx)
            .await
            .unwrap_err();
        assert!(e.is(QueryKind::CommitParent), "{parents} {idx}");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    let (s, seen) = detail_svc(String::new(), "");
    assert!(
        commit_detail_of(&s, &bg(), &abs_repo(), "--all", 0)
            .await
            .unwrap_err()
            .is(QueryKind::UnsafeRev)
    );
    assert!(seen.lock().unwrap().is_empty());
    let (s, _) = fake(out("", "fatal: bad object deadbeef\n", 128));
    assert!(
        commit_detail_of(&s, &bg(), &abs_repo(), "deadbeef", 0)
            .await
            .unwrap_err()
            .is(QueryKind::RevNotFound)
    );
    let (s, _) = detail_svc(String::new(), "");
    assert!(
        commit_detail_of(&s, &bg(), &abs_repo(), "a1b2c3d4", 0)
            .await
            .unwrap_err()
            .is(QueryKind::RevNotFound)
    );
}

#[tokio::test]
async fn commit_detail_real_git() {
    let Some(repo) = log_real_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    let cs = log(
        &s,
        &bg(),
        &LogQuery {
            repo: p.into(),
            order: LOG_ORDER_TOPO.into(),
            ..LogQuery::default()
        },
    )
    .await
    .unwrap();
    let by: HashMap<String, Commit> = cs.into_iter().map(|c| (c.subject.clone(), c)).collect();
    let merge = &by["merge side"];
    let d0 = commit_detail_of(&s, &bg(), p, &merge.oid, 0).await.unwrap();
    assert!(
        d0.files.len() == 1
            && d0.files[0].path == "d ir/한글 파일.txt"
            && d0.files[0].status == "A"
    );
    assert!(d0.parent_index == 0 && !d0.body.is_empty() && !d0.committer_name.is_empty());
    let d1 = commit_detail_of(&s, &bg(), p, &merge.oid, 1).await.unwrap();
    assert!(d1.files.iter().any(|f| f.path == "RE ADME.md") && d1.parent_index == 1);
    let ren = commit_detail_of(&s, &bg(), p, &by["rename with space"].oid, 0)
        .await
        .unwrap();
    let f = &ren.files[0];
    assert!(
        ren.files.len() == 1
            && f.status == "R"
            && f.path == "RE ADME.md"
            && f.orig_path == "README.md"
            && f.score == 100
    );
    let root = commit_detail_of(&s, &bg(), p, &by["init"].oid, 0)
        .await
        .unwrap();
    assert!(root.parent_index == COMMIT_NO_PARENT && root.commit.parents.is_empty());
    assert!(
        root.files.len() == 1 && root.files[0].path == "README.md" && root.files[0].status == "A"
    );
    let second = commit_detail_of(&s, &bg(), p, &by["두 번째 · 유니코드"].oid, 0)
        .await
        .unwrap();
    assert!(second.body.contains("본문 둘째 줄"));
}
