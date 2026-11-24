use std::collections::HashMap;

use super::support::*;
use crate::log::{LOG_DECORATE, LOG_FORMAT};
use crate::*;
use otter_webserver_domain_git_core::{DEFAULT_MAX_OUTPUT, Output, Service};

fn hunk_file(dir: &str, name: &str, n: usize, edit: &HashMap<usize, &str>) {
    let lines: Vec<String> = (1..=n)
        .map(|i| edit.get(&i).map_or(format!("line{i}"), |v| v.to_string()))
        .collect();
    write_file(dir, name, &(lines.join("\n") + "\n"));
}

fn hunk_repo() -> Option<Temp> {
    let dir = git_repo()?;
    hunk_file(&dir.path, "f.txt", 30, &HashMap::new());
    git_run(&dir.path, &["add", "f.txt"]);
    git_run(&dir.path, &["commit", "-q", "-m", "f"]);
    Some(dir)
}

fn side_count(lines: &[String], sign: u8) -> i64 {
    lines
        .iter()
        .filter(|l| !l.is_empty() && (l.as_bytes()[0] == b' ' || l.as_bytes()[0] == sign))
        .count() as i64
}

#[tokio::test]
async fn hunks_parse_boundaries_and_ids() {
    let Some(dir) = hunk_repo() else { return };
    let s = Service::new();
    let d = dir.path.as_str();
    hunk_file(
        d,
        "f.txt",
        30,
        &HashMap::from([(5, "FIVE"), (15, "FIFTEEN"), (25, "TWENTYFIVE")]),
    );
    let fd = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 3);
    for (i, h) in fd.hunks.iter().enumerate() {
        assert!(h.index == i as i64 && h.header.starts_with("@@"));
        assert_eq!(
            (h.old_lines, h.new_lines),
            (side_count(&h.lines, b'-'), side_count(&h.lines, b'+'))
        );
    }
    assert_eq!(fd.hunks[0].old_start, 2);
    assert!(!fd.diff_id.is_empty() && !fd.preamble.is_empty());

    hunk_file(d, "f.txt", 30, &HashMap::from([(5, "FIVE")]));
    let a = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    let same = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_eq!(a.diff_id, same.diff_id);
    hunk_file(d, "f.txt", 30, &HashMap::from([(5, "FIVE!")]));
    let b = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_ne!(a.diff_id, b.diff_id);
}

#[tokio::test]
async fn hunks_cached_axis_and_rejects() {
    let Some(dir) = hunk_repo() else { return };
    let s = Service::new();
    let d = dir.path.as_str();
    let fd = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert!(fd.hunks.is_empty() && fd.note.is_empty());
    hunk_file(d, "f.txt", 30, &HashMap::from([(5, "FIVE")]));
    git_run(d, &["add", "f.txt"]);
    hunk_file(
        d,
        "f.txt",
        30,
        &HashMap::from([(5, "FIVE"), (25, "TWENTYFIVE")]),
    );
    let staged = hunks_of(&s, &bg(), d, AXIS_INDEX_HEAD, "f.txt")
        .await
        .unwrap();
    let unstaged = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert!(
        staged.hunks.len() == 1 && unstaged.hunks.len() == 1 && staged.diff_id != unstaged.diff_id
    );
    assert!(
        hunks_of(&s, &bg(), d, AXIS_WORKTREE_HEAD, "f.txt")
            .await
            .unwrap_err()
            .is(QueryKind::DiffAxis)
    );
    assert!(
        hunks_of(&s, &bg(), d, "nope", "f.txt")
            .await
            .unwrap_err()
            .is(QueryKind::DiffAxis)
    );
    assert!(
        hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "../etc/passwd")
            .await
            .unwrap_err()
            .is(QueryKind::DiffPath)
    );
}

#[tokio::test]
async fn hunks_large_file_under_editor_limit() {
    let Some(dir) = git_repo() else { return };
    let d = dir.path.as_str();
    let line = "x".repeat(63) + "\n";
    let n = (2 << 20) / line.len();
    write_file(d, "big.txt", &line.repeat(n));
    git_run(d, &["add", "big.txt"]);
    git_run(d, &["commit", "-q", "-m", "big"]);
    write_file(d, "big.txt", &line.to_uppercase().repeat(n));
    let s = Service::new();
    let fd = hunks_of(&s, &bg(), d, AXIS_WORKTREE_INDEX, "big.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 1);
    assert_eq!(s.max_output(), DEFAULT_MAX_OUTPUT);
}

#[test]
fn parse_hunks_edges_and_wire() {
    let body = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@ ctx\n-a\n+b\n+c\n\\ No newline at end of file\n@@ bad @@\n x\n@@ -5,0 +7 @@\n+z\n";
    let (pre, hunks) = parse_hunks(body);
    assert_eq!(pre.len(), 4);
    assert_eq!(hunks.len(), 2);
    assert_eq!(
        (
            hunks[0].old_start,
            hunks[0].old_lines,
            hunks[0].new_start,
            hunks[0].new_lines
        ),
        (1, 1, 1, 2)
    );
    assert_eq!(hunks[0].lines.len(), 4);
    assert_eq!(
        (hunks[1].index, hunks[1].old_lines, hunks[1].new_lines),
        (1, 0, 1)
    );
    let fd = FileDiff {
        repo: "/r".into(),
        axis: "a".into(),
        path: "p".into(),
        diff_id: "d".into(),
        ..FileDiff::default()
    };
    assert_eq!(
        json(&fd),
        r#"{"repo":"/r","axis":"a","path":"p","diffId":"d","hunks":null}"#
    );
}

fn rec(f: [&str; 9]) -> String {
    f.join("\0")
}

#[test]
fn parse_log_fields() {
    let out = [
        rec([
            "a1",
            "a1s",
            "p1 p2",
            "김 동민",
            "dy@example.com",
            "1700000000",
            "1700000060",
            "HEAD -> refs/heads/main, tag: refs/tags/v1.0",
            "머지 · 유니코드  제목",
        ]),
        rec([
            "b2",
            "b2s",
            "p1",
            "tester",
            "t@example.com",
            "1700000001",
            "1700000001",
            "",
            "두 번째",
        ]),
        rec([
            "c3",
            "c3s",
            "",
            "tester",
            "t@example.com",
            "1700000002",
            "1700000002",
            "",
            "root",
        ]),
    ]
    .join("\0");
    let cs = parse_log(&out).unwrap();
    assert_eq!(cs.len(), 3);
    assert!(cs[0].oid == "a1" && cs[0].abbrev == "a1s" && cs[0].subject == "머지 · 유니코드  제목");
    assert!(cs[0].author_name == "김 동민" && cs[0].author_mail == "dy@example.com");
    assert_eq!(
        (cs[0].author_at, cs[0].commit_at),
        (1700000000000, 1700000060000)
    );
    assert_eq!(cs[0].parents, ["p1", "p2"]);
    assert_eq!(cs[1].parents.len(), 1);
    assert!(cs[2].parents.is_empty());
    assert!(json(&cs[2]).contains(r#""parents":[]"#) && json(&cs[2]).contains(r#""refs":[]"#));
}

#[test]
fn parse_log_decorations() {
    let r = |n: &str, k: &str, h: bool| CommitRef {
        name: n.into(),
        kind: k.into(),
        is_head: h,
    };
    let cases = [
        ("", false, vec![]),
        (
            "HEAD -> refs/heads/main, tag: refs/tags/v2.0, refs/remotes/origin/main",
            true,
            vec![
                r("main", REF_KIND_LOCAL, true),
                r("v2.0", REF_KIND_TAG, false),
                r("origin/main", REF_KIND_REMOTE, false),
            ],
        ),
        ("HEAD", true, vec![]),
        (
            "HEAD, refs/heads/side",
            true,
            vec![r("side", REF_KIND_LOCAL, false)],
        ),
        (
            "refs/heads/feature/a-b",
            false,
            vec![r("feature/a-b", REF_KIND_LOCAL, false)],
        ),
        ("refs/stash", false, vec![r("refs/stash", "", false)]),
    ];
    for (dec, is_head, want) in cases {
        let cs = parse_log(&rec(["a", "a", "", "n", "m", "1", "1", dec, "s"])).unwrap();
        assert_eq!(cs[0].is_head, is_head, "{dec}");
        assert_eq!(cs[0].refs, want, "{dec}");
    }
}

#[test]
fn parse_log_short_empty_trailing() {
    let full = rec(["a", "a", "", "n", "m", "1", "1", "", "s"]);
    assert!(parse_log("a\0a\0\0n").is_err());
    let e = parse_log(&(full.clone() + "\0b\0b\0\0n\0m")).unwrap_err();
    assert_eq!(
        e.to_string(),
        "git log: 마지막 레코드의 필드가 5개다 (want 9): [\"b\" \"b\" \"\" \"n\" \"m\"]"
    );
    assert!(parse_log("").unwrap().is_empty());
    let out = [full, rec(["b", "b", "a", "n", "m", "2", "2", "", ""])].join("\0");
    let cs = parse_log(&out).unwrap();
    assert!(cs.len() == 2 && cs[1].oid == "b" && cs[1].subject.is_empty());
}

#[tokio::test]
async fn log_argv() {
    let base = format!("log -z {LOG_FORMAT} {LOG_DECORATE}");
    let q = |f: fn(&mut LogQuery)| {
        let mut q = LogQuery {
            repo: abs_repo(),
            ..LogQuery::default()
        };
        f(&mut q);
        q
    };
    let cases: Vec<(LogQuery, String)> = vec![
        (q(|_| {}), format!("{base} -n 300 --all")),
        (
            q(|q| q.r#ref = "refs/heads/main".into()),
            format!("{base} -n 300 refs/heads/main"),
        ),
        (
            q(|q| q.order = LOG_ORDER_AUTHOR_DATE.into()),
            format!("{base} --author-date-order -n 300 --all"),
        ),
        (
            q(|q| q.order = LOG_ORDER_TOPO.into()),
            format!("{base} --topo-order -n 300 --all"),
        ),
        (
            q(|q| q.order = LOG_ORDER_DATE.into()),
            format!("{base} -n 300 --all"),
        ),
        (
            q(|q| {
                q.skip = 300;
                q.limit = 100
            }),
            format!("{base} --skip=300 -n 100 --all"),
        ),
        (
            q(|q| {
                q.author = "김".into();
                q.since = "2024-01-01".into();
                q.until = "2024-02-01".into();
                q.grep = "fix me".into()
            }),
            format!(
                "{base} -n 300 --author=김 --since=2024-01-01 --until=2024-02-01 --grep=fix me --all"
            ),
        ),
        (
            q(|q| q.path = "d ir/한글.txt".into()),
            format!("{base} -n 300 --all -- d ir/한글.txt"),
        ),
        (
            q(|q| q.reflog = true),
            format!("{base} -n 300 --reflog --all"),
        ),
        (
            q(|q| {
                q.reflog = true;
                q.r#ref = "refs/heads/main".into()
            }),
            format!("{base} -n 300 --reflog refs/heads/main"),
        ),
    ];
    for (query, want) in cases {
        let (s, seen) = fake(Output::default());
        log(&s, &bg(), &query).await.unwrap();
        assert_eq!(seen.lock().unwrap()[0].join(" "), want);
    }
}

#[tokio::test]
async fn log_rejects_and_errors() {
    let (s, seen) = fake(Output::default());
    let bad = LogQuery {
        repo: abs_repo(),
        order: "reverse".into(),
        ..LogQuery::default()
    };
    assert!(
        log(&s, &bg(), &bad)
            .await
            .unwrap_err()
            .is(QueryKind::LogOrder)
    );
    let bad = LogQuery {
        repo: abs_repo(),
        r#ref: "--all".into(),
        ..LogQuery::default()
    };
    let e = log(&s, &bg(), &bad).await.unwrap_err();
    assert!(e.is(QueryKind::UnsafeRev));
    assert_eq!(
        e.to_string(),
        "unsafe_rev: ref 는 - 로 시작할 수 없다: \"--all\""
    );
    assert!(seen.lock().unwrap().is_empty());
    for (n, want) in [
        (0, LOG_INITIAL_LIMIT),
        (-5, LOG_INITIAL_LIMIT),
        (1, 1),
        (LOG_PAGE_LIMIT, LOG_PAGE_LIMIT),
        (LOG_MAX_LIMIT, LOG_MAX_LIMIT),
        (LOG_MAX_LIMIT + 1, LOG_MAX_LIMIT),
        (1 << 20, LOG_MAX_LIMIT),
    ] {
        assert_eq!(log_limit(n), want);
    }
    let (s, _) = fake(Output {
        stdout_truncated: true,
        ..out(&rec(["a", "a", "", "n", "m", "1", "1", "", "s"]), "", 0)
    });
    assert!(
        log(
            &s,
            &bg(),
            &LogQuery {
                repo: abs_repo(),
                ..LogQuery::default()
            }
        )
        .await
        .is_err()
    );
    let (s, _) = fake(out(
        "",
        "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.\n",
        128,
    ));
    let e = log(
        &s,
        &bg(),
        &LogQuery {
            repo: abs_repo(),
            r#ref: "nope".into(),
            ..LogQuery::default()
        },
    )
    .await
    .unwrap_err();
    assert!(e.is(QueryKind::RevNotFound));
    assert!(e.to_string().starts_with("rev_not_found: git log "), "{e}");
}

pub(crate) fn log_real_repo() -> Option<Temp> {
    let repo = git_repo()?;
    let p = repo.path.as_str();
    write_file(p, "b.txt", "b\n");
    git_run(p, &["add", "-A"]);
    git_run(
        p,
        &[
            "commit",
            "-q",
            "-m",
            "두 번째 · 유니코드\n\n본문 첫 줄\n본문 둘째 줄\n",
        ],
    );
    git_run(p, &["checkout", "-q", "-b", "side"]);
    write_file(p, "d ir/한글 파일.txt", "s\n");
    git_run(p, &["add", "-A"]);
    git_run(p, &["commit", "-q", "-m", "side 쪽 변경"]);
    git_run(p, &["checkout", "-q", "main"]);
    git_run(p, &["mv", "README.md", "RE ADME.md"]);
    git_run(p, &["commit", "-q", "-m", "rename with space"]);
    git_run(p, &["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    git_run(p, &["tag", "v1.0"]);
    Some(repo)
}

#[tokio::test]
async fn log_real_git() {
    let Some(repo) = log_real_repo() else { return };
    let s = Service::new();
    let q = |f: fn(&mut LogQuery)| {
        let mut q = LogQuery {
            repo: repo.path.clone(),
            order: LOG_ORDER_TOPO.into(),
            ..LogQuery::default()
        };
        f(&mut q);
        q
    };
    let cs = log(&s, &bg(), &q(|_| {})).await.unwrap();
    assert_eq!(cs.len(), 5);
    let head = &cs[0];
    assert!(head.subject == "merge side" && head.parents.len() == 2 && head.is_head);
    assert!(head.oid.len() == 40 && !head.abbrev.is_empty() && head.abbrev.len() < 40);
    let kinds: HashMap<&str, &str> = head
        .refs
        .iter()
        .map(|r| (r.name.as_str(), r.kind.as_str()))
        .collect();
    assert!(kinds["main"] == REF_KIND_LOCAL && kinds["v1.0"] == REF_KIND_TAG);
    let root = cs.last().unwrap();
    assert!(root.subject == "init" && root.parents.is_empty());
    assert!(cs.iter().any(|c| c.subject == "두 번째 · 유니코드"));

    let page = log(
        &s,
        &bg(),
        &q(|q| {
            q.skip = 2;
            q.limit = 2
        }),
    )
    .await
    .unwrap();
    assert!(page.len() == 2 && page[0].oid == cs[2].oid && page[1].oid == cs[3].oid);
    let side = log(&s, &bg(), &q(|q| q.r#ref = "refs/heads/side".into()))
        .await
        .unwrap();
    assert!(
        side.iter()
            .all(|c| c.subject != "merge side" && c.subject != "rename with space")
    );
    let by_path = log(&s, &bg(), &q(|q| q.path = "d ir/한글 파일.txt".into()))
        .await
        .unwrap();
    assert!(by_path.len() == 1 && by_path[0].subject == "side 쪽 변경");
    assert!(
        log(&s, &bg(), &q(|q| q.author = "nobody-such-author".into()))
            .await
            .unwrap()
            .is_empty()
    );

    let empty = git_init();
    assert!(
        log(
            &s,
            &bg(),
            &LogQuery {
                repo: empty.path.clone(),
                ..LogQuery::default()
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
}

#[tokio::test]
async fn log_real_git_reflog() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    write_file(p, "dropped.txt", "x\n");
    git_run(p, &["add", "-A"]);
    git_run(p, &["commit", "-q", "-m", "버려질 커밋"]);
    git_run(p, &["reset", "-q", "--hard", "HEAD~1"]);
    let s = Service::new();
    let has = |cs: &[Commit]| cs.iter().any(|c| c.subject == "버려질 커밋");
    let off = log(
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
    assert!(!has(&off));
    let on = log(
        &s,
        &bg(),
        &LogQuery {
            repo: p.into(),
            order: LOG_ORDER_TOPO.into(),
            reflog: true,
            ..LogQuery::default()
        },
    )
    .await
    .unwrap();
    assert!(has(&on));
}
