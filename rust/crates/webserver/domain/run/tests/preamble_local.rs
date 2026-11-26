//! ISSUE_TREE_CHAT_SRS FR-LIS-14·15 (TC-ITH-17): 로컬 트리와 coord 일꾼의 프리앰블.
//! GitHub 트리(tree)의 프리앰블은 Go 비교 시험(go_parity)이 바이트로 잰다.

use otter_webserver_domain_run::*;

fn rec(tree: &str, issue_dir: &str, mode: &str) -> Record {
    Record {
        id: "run-1".into(),
        tree: tree.into(),
        issue_dir: issue_dir.into(),
        mode: mode.into(),
        coordinator_tool_id: "coord-1".into(),
        ..Record::default()
    }
}

fn member(issue: &str) -> Member {
    Member {
        id: "m-1".into(),
        role: format!("perf:{issue}"),
        assign: Some(Assignment {
            issue: issue.into(),
            title: "제목".into(),
            ..Assignment::default()
        }),
        ..Member::default()
    }
}

fn ctx() -> TreeContext {
    TreeContext {
        parent_tool_id: "coord-1".into(),
        group_id: "g-1".into(),
        doc_path: "/d/issue-tree.md".into(),
        ctx_pct: 50,
    }
}

fn has_all(p: &str, want: &[&str]) {
    for w in want {
        assert!(p.contains(w), "없음: {w}\n---\n{p}");
    }
}

fn has_none(p: &str, banned: &[&str]) {
    for b in banned {
        assert!(!p.contains(b), "있으면 안 됨: {b}\n---\n{p}");
    }
}

/// FR-LIS-15: local + tree 노드는 GitHub 이슈 운영 대신 `otterctl issue` 운영을 받는다.
#[test]
fn local_tree_node_uses_issue_files() {
    let p = tree_preamble(
        &rec("perf:2", "/repo/perf/issues", ""),
        &member("2.1"),
        &ctx(),
    );
    assert!(p.starts_with("너는 otterminal 이슈 트리의 노드다."), "{p}");
    has_all(
        &p,
        &[
            "원본 폴더: /repo/perf/issues",
            "「로컬 이슈」",
            "otterctl issue show 2.1",
            "otterctl issue set 2.1 --status in-progress",
            "otterctl issue log 2.1",
            "otterctl issue new 2.1.",
            "--status review",
            "--status done",
            "--status blocked --reason",
            "worktree 안의 사본",
            "완료 perf:2.1",
        ],
    );
    has_none(&p, &["viewerPermission", "gh api", "프로젝트 보드", "일꾼"]);
}

/// FR-LIS-10~14: local + coord 의 일꾼은 일꾼 규칙을 받는다.
#[test]
fn local_coord_worker_gets_worker_rules() {
    let p = tree_preamble(
        &rec("perf:2", "/repo/perf/issues", MODE_COORD),
        &member("2.3"),
        &ctx(),
    );
    assert!(
        p.starts_with("너는 otterminal 이슈 트리(coord)의 일꾼이다."),
        "{p}"
    );
    has_all(
        &p,
        &[
            "「일꾼 규칙」",
            "부모: coord-1 — 조정자다",
            "원본 폴더: /repo/perf/issues",
            "otterctl issue set 2.3 --status in-progress",
            "otterctl issue new 2.3.",
            "--status split",
            "--status blocked --reason",
            "--status review",
            "시험을 먼저",
            "다른 에이전트를 띄우지 않는다",
            "문서와 코드가 다르면",
            "커밋이 막히면",
            "병합하지 않는다",
            "review perf:2.3",
        ],
    );
    has_none(
        &p,
        &[
            "viewerPermission",
            "--status done",
            "하위를 띄운다",
            "완료 perf:2.3",
        ],
    );
}

/// FR-LIS-18: github + coord 의 일꾼은 이슈를 닫지 않고, 상태는 조정자가 Run 멤버 상태로 센다.
#[test]
fn github_coord_worker_does_not_close_issue() {
    let mut m = member("#41");
    m.role = "otter#40›41".into();
    let p = tree_preamble(&rec("o/r#40", "", MODE_COORD), &m, &ctx());
    assert!(
        p.starts_with("너는 otterminal 이슈 트리(coord)의 일꾼이다."),
        "{p}"
    );
    has_all(
        &p,
        &[
            "「일꾼 규칙」",
            "「이슈 접근 규칙」",
            "이슈를 닫지 않는다",
            "다른 에이전트를 띄우지 않는다",
            "review otter#40›41",
        ],
    );
    has_none(&p, &["otterctl issue", "원본 폴더"]);
}
