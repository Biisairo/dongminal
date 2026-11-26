//! ISSUE_TREE_CHAT_SRS TC-ITH-15 — 이슈 파일: 형식 검사, ready 계산, 허용·거절 전이, 원자적 쓰기, 잠금.

use std::sync::Arc;

use super::*;

const PERF_LIKE: &str = "---
id: \"1.10.1\"
title: e2e 실패 A — full 토픽(채팅: 간선)
status: done
deps: [\"1.8\"]
owner: \"027320fb-3c82-4f5b-8ffa-7d3656903fee\"
branch: pf/1.10.1
---

# 1.10.1 e2e 실패 A

## 목표

본문 --- 줄도 그대로.

## 진행 기록

2026-11-24: 끝.
";

const DATE: &str = "2026-11-26";

fn dir() -> (tempfile::TempDir, Dir) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("issues");
    let dir = Dir::new(&p);
    dir.init("# 안내\n").unwrap();
    (d, dir)
}

fn status_of(d: &Dir, id: &str) -> Status {
    d.get(id).unwrap().1.status
}

#[test]
fn parse_perf_issue_and_round_trip() {
    let i = parse(PERF_LIKE).unwrap();
    assert_eq!(i.id, "1.10.1");
    assert_eq!(i.title, "e2e 실패 A — full 토픽(채팅: 간선)");
    assert_eq!(i.status, Status::Done);
    assert_eq!(i.deps, vec!["1.8".to_string()]);
    assert_eq!(i.owner, "027320fb-3c82-4f5b-8ffa-7d3656903fee");
    assert_eq!(i.branch, "pf/1.10.1");
    assert!(i.body.starts_with("\n# 1.10.1 e2e 실패 A"));
    assert!(i.body.contains("본문 --- 줄도 그대로."));
    assert_eq!(render(&i), PERF_LIKE);
    assert_eq!(parse(&render(&i)).unwrap(), i);
}

#[test]
fn format_errors() {
    for (bad, why) in [
        ("id: \"1\"\n", "머리말 없음"),
        ("---\nid: \"1\"\ntitle: t\nstatus: todo\n", "닫히지 않음"),
        ("---\ntitle: t\nstatus: todo\n---\n", "id 없음"),
        ("---\nid: \"1..2\"\ntitle: t\nstatus: todo\n---\n", "id 꼴"),
        ("---\nid: \"1\"\nstatus: todo\n---\n", "title 없음"),
        (
            "---\nid: \"1\"\ntitle: t\nstatus: doing\n---\n",
            "모르는 상태",
        ),
        (
            "---\nid: \"1\"\ntitle: t\nstatus: todo\ndeps: [1\n---\n",
            "deps 깨짐",
        ),
        (
            "---\nid: \"1\"\ntitle: t\nstatus: todo\ndeps: [\"a b\"]\n---\n",
            "deps id 꼴",
        ),
        (
            "---\nid: \"1\"\ntitle: t\nstatus: todo\nwhat\n---\n",
            "읽을 수 없는 줄",
        ),
    ] {
        assert!(matches!(parse(bad), Err(Error::Format(_))), "{why}");
    }
    let ok = parse("---\nid: \"2\"\ntitle: t\nstatus: todo\ndeps: []\n---\n").unwrap();
    assert!(ok.deps.is_empty() && ok.owner.is_empty() && ok.branch.is_empty());
}

#[test]
fn ids_parents_and_order() {
    assert!(valid_id("1") && valid_id("1.10.2") && valid_id("a1.b"));
    assert!(!valid_id("") && !valid_id("1.") && !valid_id(".1") && !valid_id("1-2"));
    assert_eq!(parent("1.10.2"), Some("1.10"));
    assert_eq!(parent("3"), None);
    let mut v = vec!["1.10", "1.2", "10", "2", "1", "1.2.1"];
    v.sort_by(|a, b| id_cmp(a, b));
    assert_eq!(v, ["1", "1.2", "1.2.1", "1.10", "2", "10"]);
}

#[test]
fn transitions() {
    use Status::*;
    for (f, t) in [
        (Todo, Ready),
        (Ready, InProgress),
        (InProgress, Review),
        (Review, Done),
        (Todo, Blocked),
        (InProgress, Blocked),
        (Review, Blocked),
        (Blocked, Ready),
        (Blocked, InProgress),
        (InProgress, Split),
        (Done, Done),
    ] {
        assert!(transition_ok(f, t), "{f:?}→{t:?}");
    }
    for (f, t) in [
        (Todo, InProgress),
        (Todo, Done),
        (Ready, Review),
        (Review, InProgress),
        (Done, Todo),
        (Done, Blocked),
        (Split, InProgress),
        (Blocked, Done),
        (Ready, Split),
    ] {
        assert!(!transition_ok(f, t), "{f:?}→{t:?}");
    }
}

#[test]
fn ready_is_todo_with_done_deps() {
    let (_t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    d.create("1.1", "가", &[]).unwrap();
    d.create("1.2", "나", &["1.1".into()]).unwrap();
    let all = d.issues().unwrap();
    let get = |id: &str| all.iter().find(|i| i.id == id).unwrap().clone();
    assert!(is_ready(&get("1.1"), &all));
    assert!(!is_ready(&get("1.2"), &all));
    for s in [
        Status::Ready,
        Status::InProgress,
        Status::Review,
        Status::Done,
    ] {
        d.set(
            "1.1",
            &Change {
                status: Some(s),
                ..Change::default()
            },
            DATE,
        )
        .unwrap();
    }
    let all = d.issues().unwrap();
    assert!(is_ready(all.iter().find(|i| i.id == "1.2").unwrap(), &all));
    assert!(!is_ready(all.iter().find(|i| i.id == "1.1").unwrap(), &all));
}

#[test]
fn create_rules() {
    let (_t, d) = dir();
    assert!(matches!(d.create("1.1", "고아", &[]), Err(Error::NoParent(p)) if p == "1"));
    let p = d.create("1", "뿌리 이슈: 시작/끝", &[]).unwrap();
    assert_eq!(p.file_name().unwrap(), "1-뿌리-이슈-시작-끝.md");
    assert!(matches!(d.create("1", "또", &[]), Err(Error::Exists(_))));
    assert!(matches!(d.create("1.1", "x", &["9".into()]), Err(Error::BadDep(x)) if x == "9"));
    assert!(matches!(d.create("1.x-y", "x", &[]), Err(Error::Format(_))));
    assert!(matches!(
        d.create("2", "두\n줄", &[]),
        Err(Error::Format(_))
    ));
    d.create("1.1", "가", &["1".into()]).unwrap();
    let (_, i) = d.get("1.1").unwrap();
    assert_eq!(
        (i.status, i.deps.clone()),
        (Status::Todo, vec!["1".to_string()])
    );
    for h in ["# 1.1 가", "## 목표", "## 완료 조건", "## 진행 기록"] {
        assert!(i.body.contains(h), "{h}");
    }
}

#[test]
fn set_rejects_bad_transitions_and_needs_reason() {
    let (_t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    let to = |s| Change {
        status: Some(s),
        ..Change::default()
    };
    assert!(matches!(
        d.set("1", &to(Status::Done), DATE),
        Err(Error::Transition {
            from: Status::Todo,
            to: Status::Done
        })
    ));
    assert_eq!(status_of(&d, "1"), Status::Todo, "거절한 전이를 썼다");
    assert!(matches!(
        d.set("1", &to(Status::Blocked), DATE),
        Err(Error::NeedReason)
    ));
    let c = Change {
        status: Some(Status::Blocked),
        reason: Some("빌드 캐시가 없다".into()),
        owner: Some("tab-1".into()),
        branch: Some("perf/1".into()),
    };
    let i = d.set("1", &c, DATE).unwrap();
    assert_eq!(
        (i.status, i.owner.as_str(), i.branch.as_str()),
        (Status::Blocked, "tab-1", "perf/1")
    );
    assert!(
        i.body.contains("2026-11-26:\nblocked — 빌드 캐시가 없다"),
        "{}",
        i.body
    );
    assert!(matches!(
        d.set("9", &to(Status::Ready), DATE),
        Err(Error::NotFound(_))
    ));
}

#[test]
fn log_appends_and_writes_atomically() {
    let (t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    d.log("1", DATE, "첫 기록\n둘째 줄\n").unwrap();
    d.log("1", "2026-11-27", "다음").unwrap();
    let (p, i) = d.get("1").unwrap();
    assert!(
        i.body
            .ends_with("## 진행 기록\n\n2026-11-26:\n첫 기록\n둘째 줄\n\n2026-11-27:\n다음\n"),
        "{}",
        i.body
    );
    assert!(matches!(d.log("1", DATE, "  \n"), Err(Error::Format(_))));
    let names: Vec<String> = std::fs::read_dir(p.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && n != README_FILE)
        .collect();
    assert_eq!(names.len(), 1, "임시 파일이 남았다: {names:?}");
    drop(t);
}

/// FR-LIS-8: 여러 쓰기가 동시에 와도 잠금으로 줄 서서 하나도 잃지 않는다.
#[test]
fn concurrent_writes_are_serialized() {
    let (_t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    let path = Arc::new(d.path().to_path_buf());
    let hs: Vec<_> = (0..4)
        .map(|w| {
            let path = Arc::clone(&path);
            std::thread::spawn(move || {
                let d = Dir::new(path.as_path());
                for n in 0..10 {
                    d.log("1", DATE, &format!("w{w}-n{n}")).unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let (_, i) = d.get("1").unwrap();
    for w in 0..4 {
        for n in 0..10 {
            assert!(
                i.body.contains(&format!("w{w}-n{n}\n")),
                "w{w}-n{n} 를 잃었다"
            );
        }
    }
}

#[test]
fn load_checks_files() {
    let (_t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    std::fs::write(
        d.path().join("2-틀린.md"),
        "---\nid: \"3\"\ntitle: t\nstatus: todo\n---\n",
    )
    .unwrap();
    assert!(matches!(d.load(), Err(Error::Format(m)) if m.contains("2-틀린.md")));
    std::fs::remove_file(d.path().join("2-틀린.md")).unwrap();
    std::fs::write(d.path().join("notes.txt"), "x").unwrap();
    assert_eq!(d.issues().unwrap().len(), 1);
}

#[test]
fn tree_shape_and_filter() {
    let (_t, d) = dir();
    d.create("1", "뿌리", &[]).unwrap();
    d.create("1.1", "가", &[]).unwrap();
    d.create("1.2", "나", &["1.1".into()]).unwrap();
    d.create("1.10", "열", &[]).unwrap();
    d.set(
        "1.1",
        &Change {
            owner: Some("027320fb-3c82-4f5b".into()),
            ..Change::default()
        },
        DATE,
    )
    .unwrap();
    let t = d.tree(&[]).unwrap();
    assert_eq!(
        t,
        "1       [ready      ] 뿌리\n  1.1     [ready      ] 가  @027320fb\n  1.2     [todo       ] 나  ← 1.1\n  1.10    [ready      ] 열\n"
    );
    assert_eq!(
        d.tree(&["todo".into()]).unwrap(),
        "  1.2     [todo       ] 나  ← 1.1\n"
    );
}

#[test]
fn init_and_alias() {
    let (t, d) = dir();
    assert_eq!(
        std::fs::read_to_string(d.path().join(README_FILE)).unwrap(),
        "# 안내\n"
    );
    d.init("다른 글").unwrap();
    assert_eq!(
        std::fs::read_to_string(d.path().join(README_FILE)).unwrap(),
        "# 안내\n",
        "있는 안내를 덮었다"
    );
    assert_eq!(alias(&t.path().join("perf").join("issues")), "perf");
    assert_eq!(alias(&t.path().join("trees").join("chat")), "chat");
}

/// FR-LIS-2·16 (TC-ITH-16): `<이슈 폴더>#<ID>` 는 폴더가 있으면 로컬이고, 트리 이름은 `<별칭>:<ID>` 다.
#[test]
fn resolve_args_and_local_refs() {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().join("docs").join("perf").join("issues");
    std::fs::create_dir_all(&dir).unwrap();
    let got = resolve_arg("docs/perf/issues#2.1", t.path()).unwrap();
    assert_eq!(got.0, dir);
    assert_eq!(got.1, "2.1");
    assert_eq!(local_tree_ref(&got.0, &got.1), "perf:2.1");
    let abs = format!("{}#3", dir.display());
    assert_eq!(resolve_arg(&abs, std::path::Path::new("/")).unwrap().1, "3");
    assert_eq!(
        resolve_arg("owner/repo#12", t.path()),
        None,
        "폴더가 없으면 GitHub 이다"
    );
    assert_eq!(resolve_arg("docs/perf/issues#bad-id", t.path()), None);
    assert_eq!(resolve_arg("docs/perf/issues", t.path()), None);
    assert!(is_local_tree_ref("perf:2.1") && is_local_tree_ref("my-trees:a1"));
    for bad in ["o/r#1", "perf:", ":1", "perf:1-2", "a b:1", "perf"] {
        assert!(!is_local_tree_ref(bad), "{bad}");
    }
}
