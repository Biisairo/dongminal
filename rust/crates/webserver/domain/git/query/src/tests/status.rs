use super::support::*;
use crate::status::drop_partial_record;
use crate::*;
use dm_webserver_domain_git_core::Kind;

fn nul(recs: &[&str]) -> String {
    recs.join("\0") + "\0"
}

const OID: &str = "# branch.oid 1111111111111111111111111111111111111111";
const HEAD: &str = "# branch.head main";

fn parse(recs: &[&str]) -> Status {
    parse_status_v2(&nul(recs)).unwrap()
}

#[test]
fn paths_with_space_newline_unicode() {
    let st = parse(&[
        OID,
        HEAD,
        "1 M. N... 100644 100644 100644 aaa bbb my file.txt",
        "1 .M N... 100644 100644 100644 aaa bbb line\nbreak.txt",
        "? 한글 폴더/파일 이름.txt",
    ]);
    assert_eq!(st.staged[0].path, "my file.txt");
    assert_eq!(st.changes[0].path, "line\nbreak.txt");
    assert_eq!(st.untracked[0].path, "한글 폴더/파일 이름.txt");
    assert!(st.untracked[0].untracked);
    assert_eq!(st.total, 3);
}

#[test]
fn rename_copy_consume_two_tokens() {
    let st = parse(&[
        OID,
        HEAD,
        "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
        "old name.txt",
        "2 .C N... 100644 100644 100644 aaa bbb C75 copy.txt",
        "src.txt",
        "? after.txt",
    ]);
    let r = &st.staged[0];
    assert_eq!(
        (
            r.path.as_str(),
            r.orig_path.as_str(),
            r.score,
            r.xy.as_str()
        ),
        ("new name.txt", "old name.txt", 100, "R.")
    );
    let c = &st.changes[0];
    assert_eq!(
        (c.path.as_str(), c.orig_path.as_str(), c.score),
        ("copy.txt", "src.txt", 75)
    );
    assert_eq!(st.untracked.len(), 1);
    assert_eq!(st.total, 3);
}

#[test]
fn both_sides_and_conflict() {
    let st = parse(&[OID, HEAD, "1 MM N... 100644 100644 100644 aaa bbb both.txt"]);
    assert!(
        st.staged.len() == 1
            && st.changes.len() == 1
            && st.staged[0].staged
            && st.staged[0].unstaged
    );
    assert_eq!(st.total, 1);
    let st = parse(&[
        OID,
        HEAD,
        "u UU N... 100644 100644 100644 100644 h1 h2 h3 both modified.txt",
    ]);
    assert!(
        st.conflicts.len() == 1
            && st.conflicts[0].conflict
            && st.conflicts[0].path == "both modified.txt"
    );
    assert!(st.staged.is_empty() && st.changes.is_empty() && st.untracked.is_empty());
    assert_eq!(st.total, 1);
}

#[test]
fn branch_headers() {
    let st = parse(&["# branch.oid (initial)", "# branch.head main"]);
    assert!(st.initial && st.oid.is_empty() && st.branch == "main");
    let st = parse(&[OID, "# branch.head (detached)"]);
    assert!(st.detached && st.branch.is_empty());
    let st = parse(&[OID, HEAD]);
    assert!(!st.has_upstream && st.upstream.is_empty() && st.ahead == 0 && st.behind == 0);
    let st = parse(&[
        OID,
        HEAD,
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
    ]);
    assert!(st.has_upstream && st.upstream == "origin/main" && st.ahead == 2 && st.behind == 3);
    let st = parse(&[OID, HEAD, "# branch.upstream origin/main"]);
    assert!(st.has_upstream && st.ahead == 0 && st.behind == 0);
}

#[test]
fn short_record_is_error() {
    for recs in [
        &[OID, HEAD, "1 M. N... 100644"][..],
        &[OID, HEAD, "2 R. N... 100644 100644 100644 aaa bbb"],
        &[OID, HEAD, "u UU N... 100644 100644"],
    ] {
        assert!(parse_status_v2(&nul(recs)).is_err(), "{recs:?}");
    }
    // origPath 없음: 끝 NUL 뒤 토큰이 없다.
    let e = parse_status_v2(&nul(&[
        OID,
        HEAD,
        "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
    ]))
    .unwrap_err();
    assert_eq!(
        e.to_string(),
        "porcelain v2: rename 레코드에 origPath 가 없다: \"2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\""
    );
    let e = parse_status_v2(&nul(&[OID, "1 M. N... 100644"])).unwrap_err();
    assert_eq!(
        e.to_string(),
        "porcelain v2: 1 레코드의 필드가 3개다 (want 8): \"M. N... 100644\""
    );
    let e = parse_status_v2(&nul(&["x y"])).unwrap_err();
    assert_eq!(e.to_string(), "porcelain v2: 알 수 없는 레코드: \"x y\"");
}

#[test]
fn unknown_header_ignored_and_sorted() {
    let st = parse(&[
        OID,
        HEAD,
        "# branch.future something new",
        "# stash 3",
        "! ignored.txt",
        "? real.txt",
    ]);
    assert!(st.untracked.len() == 1 && st.untracked[0].path == "real.txt" && st.total == 1);
    let st = parse(&[OID, HEAD, "? z.txt", "? a.txt", "? m.txt"]);
    let got: Vec<&str> = st.untracked.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(got, ["a.txt", "m.txt", "z.txt"]);
}

#[tokio::test]
async fn status_argv_and_not_repo() {
    let (s, seen) = fake(out(&nul(&[OID, HEAD]), "", 0));
    let st = status_of(&s, &bg(), &abs_r()).await.unwrap();
    assert_eq!(
        seen.lock().unwrap()[0].join(" "),
        "status --porcelain=v2 -z --branch --untracked-files=all"
    );
    assert_eq!(st.repo, abs_r());
    let (s, seen) = fake(out(&nul(&[OID, HEAD]), "", 0));
    tracked_status_of(&s, &bg(), &abs_r()).await.unwrap();
    assert_eq!(
        seen.lock().unwrap()[0].last().unwrap(),
        "--untracked-files=no"
    );
    let (s, _) = fake(out("", "fatal: not a git repository", 128));
    assert!(
        status_of(&s, &bg(), &abs_r())
            .await
            .unwrap_err()
            .is_core(Kind::NotRepo)
    );
}

#[test]
fn untracked_dir_and_submodule_entries() {
    let st = parse(&[OID, HEAD, "? nested/", "? plain.txt"]);
    let (dir, file) = (&st.untracked[0], &st.untracked[1]);
    assert!(dir.path == "nested" && dir.dir && dir.sub.is_empty());
    assert!(file.path == "plain.txt" && !file.dir);
    let st = parse(&[
        OID,
        HEAD,
        "1 .M S.MU 160000 160000 160000 aaa bbb sub",
        "1 .M N... 100644 100644 100644 aaa bbb file.txt",
    ]);
    let sub = st.changes.iter().find(|e| e.path == "sub").unwrap();
    let file = st.changes.iter().find(|e| e.path == "file.txt").unwrap();
    assert!(sub.dir && sub.sub == "S.MU" && !file.dir);
    let st = parse(&[
        OID,
        HEAD,
        "1 .M S.MU 160000 160000 160000 aaa bbb sub",
        "? nested/",
    ]);
    assert_eq!(st.total, 2);
    let st = parse(&[OID, HEAD, "? a/b/nested/"]);
    assert!(st.untracked[0].path == "a/b/nested" && st.untracked[0].dir);
}

#[test]
fn submodule_inner_only() {
    let e = |sub: &str| FileEntry {
        sub: sub.into(),
        ..FileEntry::default()
    };
    assert!(e("S.M.").submodule_inner_only());
    assert!(e("S..U").submodule_inner_only());
    assert!(!e("SCM.").submodule_inner_only());
    assert!(!e("S...").submodule_inner_only());
    assert!(!e("").submodule_inner_only());
}

#[test]
fn caps_groups() {
    let mut recs = vec![OID.to_owned(), HEAD.to_owned()];
    let n = STATUS_GROUP_CAP + 37;
    recs.extend((0..n).map(|i| format!("? f{i:06}.txt")));
    let refs: Vec<&str> = recs.iter().map(String::as_str).collect();
    let st = parse(&refs);
    assert_eq!(st.untracked.len(), STATUS_GROUP_CAP);
    assert_eq!(st.truncated.as_ref().unwrap()["untracked"], n as i64);
    assert_eq!(st.total, n as i64);
    assert!(parse(&[OID, HEAD, "? a"]).truncated.is_none());
}

#[tokio::test]
async fn truncated_between_rename_and_orig_path() {
    let (a, b) = ("1".repeat(40), "2".repeat(40));
    let recs = [
        format!("# branch.oid {}", "a".repeat(40)),
        "# branch.head main".into(),
        format!("1 M. N... 100644 100644 100644 {a} {b} a.txt"),
        format!("2 R. N... 100644 100644 100644 {a} {b} R100 new.txt"),
    ];
    let body = recs.join("\0") + "\0old.t";
    let o = dm_webserver_domain_git_core::Output {
        stdout_truncated: true,
        ..out(&body, "", 0)
    };
    let (s, _) = fake(o);
    let st = status_of(&s, &bg(), &abs_repo()).await.unwrap();
    assert!(st.staged.len() == 1 && st.staged[0].path == "a.txt" && st.output_truncated);
    assert_eq!(drop_partial_record(b"abc"), b"");
}

#[test]
fn status_json_wire() {
    let st = parse(&[OID, HEAD]);
    assert_eq!(
        json(&st),
        r#"{"repo":"","oid":"1111111111111111111111111111111111111111","branch":"main","detached":false,"initial":false,"upstream":"","hasUpstream":false,"ahead":0,"behind":0,"staged":null,"changes":null,"untracked":null,"conflicts":null,"total":0,"operation":{"kind":""}}"#
    );
    let st = parse(&[
        OID,
        HEAD,
        "2 R. S.M. 100644 100644 100644 aaa bbb R90 n",
        "o",
    ]);
    assert!(json(&st).contains(r#""staged":[{"path":"n","origPath":"o","xy":"R.","staged":true,"unstaged":false,"conflict":false,"untracked":false,"score":90,"sub":"S.M.","dir":true}]"#), "{}", json(&st));
}

// 실제 git: 상태가 git 출력과 맞는다.
#[tokio::test]
async fn status_real_git() {
    let Some(repo) = git_repo() else { return };
    write_file(&repo.path, "README.md", "changed\n");
    write_file(&repo.path, "new.txt", "n\n");
    write_file(&repo.path, "staged.txt", "s\n");
    git_run(&repo.path, &["add", "staged.txt"]);
    let st = status_of(&Service::new(), &bg(), &repo.path).await.unwrap();
    assert_eq!(st.branch, "main");
    assert_eq!(
        st.changes
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        ["README.md"]
    );
    assert_eq!(
        st.untracked
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        ["new.txt"]
    );
    assert_eq!(
        st.staged
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>(),
        ["staged.txt"]
    );
    assert_eq!(st.total, 3);
    let tr = tracked_status_of(&Service::new(), &bg(), &repo.path)
        .await
        .unwrap();
    assert!(tr.untracked.is_empty());
}

use dm_webserver_domain_git_core::Service;
