//! Go `patch_test.go`.

use std::collections::HashMap;
use std::path::Path;

use otter_webserver_domain_git_core::{self as core, Service};
use otter_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

/// n 줄짜리 파일을 쓴다. edit 에 든 줄만 다른 내용이 된다.
fn patch_file(dir: &Path, name: &str, n: usize, edit: &[(usize, &str)]) {
    let edit: HashMap<usize, &str> = edit.iter().copied().collect();
    let lines: Vec<String> = (1..=n)
        .map(|i| {
            edit.get(&i)
                .map_or_else(|| format!("line{i}"), |v| (*v).to_owned())
        })
        .collect();
    std::fs::write(dir.join(name), lines.join("\n") + "\n").unwrap();
}

/// 30줄 파일 하나를 커밋해 둔 저장소와 실제 git 을 쓰는 Service.
fn patch_repo() -> Option<(Service, Fx)> {
    let fx = temp_repo()?;
    patch_file(fx.dir(), "f.txt", 30, &[]);
    git_run(fx.dir(), &["add", "f.txt"]);
    git_run(fx.dir(), &["commit", "-m", "f"]);
    Some((Service::new(), fx))
}

fn split_content_lines(s: &str) -> Vec<String> {
    s.trim_end_matches(['\r', '\n'])
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned())
        .collect()
}

fn worktree_lines(dir: &Path, name: &str) -> Vec<String> {
    split_content_lines(&std::fs::read_to_string(dir.join(name)).unwrap())
}

async fn index_lines(dir: &str, name: &str) -> Vec<String> {
    let spec = format!(":{name}");
    let o = Service::new()
        .exec(&bg(), dir, &["show", spec.as_str()])
        .await
        .unwrap();
    split_content_lines(&o.stdout_str())
}

fn has_line(lines: &[String], want: &str) -> bool {
    lines.iter().any(|l| l == want)
}

fn line_index_of(lines: &[String], want: &str) -> i64 {
    let i = lines
        .iter()
        .position(|l| l == want)
        .unwrap_or_else(|| panic!("hunk 본문에 {want:?} 가 없다: {lines:?}"));
    i64::try_from(i).unwrap() + 1
}

fn po(op: &str, axis: &str, path: &str, hunk: i64, diff_id: &str) -> PatchOpts {
    PatchOpts {
        op: op.into(),
        axis: axis.into(),
        path: path.into(),
        hunk,
        diff_id: diff_id.into(),
        ..PatchOpts::default()
    }
}

/// Go 는 reflect 로 필드 집합을 고정했다. 여기서는 `..` 없는 구조 분해가 같은 일을 한다 —
/// 필드가 늘면 컴파일이 깨진다.
#[test]
fn patch_opts_has_no_patch_field() {
    let PatchOpts {
        op,
        axis,
        path,
        hunk,
        from,
        to,
        diff_id,
    } = PatchOpts::default();
    let _: (String, String, String, String) = (op, axis, path, diff_id);
    let _: (i64, i64, i64) = (hunk, from, to);
}

#[test]
fn patch_args_pure_and_derives_destructive() {
    let cases = [
        (
            PATCH_STAGE,
            sv(&["apply", "--cached", "--whitespace=nowarn", "-"]),
            false,
        ),
        (
            PATCH_UNSTAGE,
            sv(&["apply", "--cached", "-R", "--whitespace=nowarn", "-"]),
            false,
        ),
        (
            PATCH_REVERT,
            sv(&["apply", "-R", "--whitespace=nowarn", "-"]),
            true,
        ),
    ];
    for (op, want, destructive) in &cases {
        let (argv, d) = patch_args(op).unwrap();
        assert_eq!(&argv, want, "{op}");
        assert_eq!(d, *destructive, "{op}");
    }
    assert!(patch_args("rm -rf").unwrap_err().is(WriteKind::PatchOp));
    for (op, _, _) in cases {
        let (argv, _) = patch_args(op).unwrap();
        core::guard_write_args(&argv).unwrap();
    }
}

#[tokio::test]
async fn patch_rejects_wrong_axis_before_exec() {
    let f = WriteFake::default();
    let s = svc_w(&f);
    let bad = [
        po(PATCH_STAGE, query::AXIS_INDEX_HEAD, "f.txt", 0, "x"),
        po(PATCH_UNSTAGE, query::AXIS_WORKTREE_INDEX, "f.txt", 0, "x"),
        po(PATCH_REVERT, query::AXIS_INDEX_HEAD, "f.txt", 0, "x"),
        po(PATCH_STAGE, query::AXIS_WORKTREE_HEAD, "f.txt", 0, "x"),
    ];
    for o in bad {
        let e = patch(&s, &bg(), &abs_repo(), &o).await.unwrap_err();
        assert!(e.is(WriteKind::PatchAxis), "{o:?}: {e}");
    }
    assert!(f.argvs().is_empty());
}

#[tokio::test]
async fn patch_requires_diff_id() {
    let f = WriteFake::default();
    let s = svc_w(&f);
    let o = po(PATCH_STAGE, query::AXIS_WORKTREE_INDEX, "f.txt", 0, "");
    let e = patch(&s, &bg(), &abs_repo(), &o).await.unwrap_err();
    assert!(e.is(WriteKind::PatchStale), "{e}");
    assert!(f.argvs().is_empty());
}

#[tokio::test]
async fn patch_stages_one_hunk_only() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(
        fx.dir(),
        "f.txt",
        30,
        &[(5, "FIVE"), (15, "FIFTEEN"), (25, "TWENTYFIVE")],
    );
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 3);
    patch(
        &s,
        &ctx,
        fx.p(),
        &po(
            PATCH_STAGE,
            query::AXIS_WORKTREE_INDEX,
            "f.txt",
            1,
            &fd.diff_id,
        ),
    )
    .await
    .unwrap();

    let idx = index_lines(fx.p(), "f.txt").await;
    assert!(has_line(&idx, "FIFTEEN"), "{idx:?}");
    assert!(
        !has_line(&idx, "FIVE") && !has_line(&idx, "TWENTYFIVE"),
        "{idx:?}"
    );
    let wt = worktree_lines(fx.dir(), "f.txt");
    for want in ["FIVE", "FIFTEEN", "TWENTYFIVE"] {
        assert!(has_line(&wt, want), "{want}: {wt:?}");
    }
    let rest = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_eq!(rest.hunks.len(), 2);
}

#[tokio::test]
async fn patch_rejects_stale_observation() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(5, "FIVE"), (25, "TWENTYFIVE")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    patch_file(
        fx.dir(),
        "f.txt",
        30,
        &[(5, "FIVE"), (15, "FIFTEEN"), (25, "TWENTYFIVE")],
    );
    let e = patch(
        &s,
        &ctx,
        fx.p(),
        &po(
            PATCH_STAGE,
            query::AXIS_WORKTREE_INDEX,
            "f.txt",
            1,
            &fd.diff_id,
        ),
    )
    .await
    .unwrap_err();
    assert!(e.is(WriteKind::PatchStale), "{e}");
    let idx = index_lines(fx.p(), "f.txt").await;
    for bad in ["FIVE", "FIFTEEN", "TWENTYFIVE"] {
        assert!(!has_line(&idx, bad), "{bad}: {idx:?}");
    }
}

#[tokio::test]
async fn patch_rejects_hunk_out_of_range() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(5, "FIVE")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    for n in [-1, 1, 99] {
        let e = patch(
            &s,
            &ctx,
            fx.p(),
            &po(
                PATCH_STAGE,
                query::AXIS_WORKTREE_INDEX,
                "f.txt",
                n,
                &fd.diff_id,
            ),
        )
        .await
        .unwrap_err();
        assert!(e.is(WriteKind::PatchRange), "hunk {n}: {e}");
    }
}

#[tokio::test]
async fn patch_unstages_one_hunk_only() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(5, "FIVE"), (25, "TWENTYFIVE")]);
    git_run(fx.dir(), &["add", "f.txt"]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_INDEX_HEAD, "f.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 2);
    patch(
        &s,
        &ctx,
        fx.p(),
        &po(
            PATCH_UNSTAGE,
            query::AXIS_INDEX_HEAD,
            "f.txt",
            0,
            &fd.diff_id,
        ),
    )
    .await
    .unwrap();
    let idx = index_lines(fx.p(), "f.txt").await;
    assert!(!has_line(&idx, "FIVE"), "{idx:?}");
    assert!(has_line(&idx, "TWENTYFIVE"), "{idx:?}");
    let wt = worktree_lines(fx.dir(), "f.txt");
    assert!(
        has_line(&wt, "FIVE") && has_line(&wt, "TWENTYFIVE"),
        "{wt:?}"
    );
}

fn ranged(op: &str, from: i64, to: i64, diff_id: &str) -> PatchOpts {
    PatchOpts {
        from,
        to,
        ..po(op, query::AXIS_WORKTREE_INDEX, "f.txt", 0, diff_id)
    }
}

#[tokio::test]
async fn patch_line_range_stages_only_selected() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(10, "TEN"), (12, "TWELVE")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 1);
    let h = &fd.hunks[0];
    let from = line_index_of(&h.lines, "-line10");
    let to = line_index_of(&h.lines, "+TEN");
    patch(
        &s,
        &ctx,
        fx.p(),
        &ranged(PATCH_STAGE, from, to, &fd.diff_id),
    )
    .await
    .unwrap();
    let idx = index_lines(fx.p(), "f.txt").await;
    assert!(
        has_line(&idx, "TEN") && !has_line(&idx, "line10"),
        "{idx:?}"
    );
    assert!(
        !has_line(&idx, "TWELVE") && has_line(&idx, "line12"),
        "{idx:?}"
    );
    let wt = worktree_lines(fx.dir(), "f.txt");
    assert!(has_line(&wt, "TEN") && has_line(&wt, "TWELVE"), "{wt:?}");
}

#[tokio::test]
async fn patch_revert_drops_only_selected_lines() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(10, "TEN"), (12, "TWELVE")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    let h = &fd.hunks[0];
    let from = line_index_of(&h.lines, "-line10");
    let to = line_index_of(&h.lines, "+TEN");
    patch(
        &s,
        &ctx,
        fx.p(),
        &ranged(PATCH_REVERT, from, to, &fd.diff_id),
    )
    .await
    .unwrap();
    let wt = worktree_lines(fx.dir(), "f.txt");
    assert!(!has_line(&wt, "TEN") && has_line(&wt, "line10"), "{wt:?}");
    assert!(
        has_line(&wt, "TWELVE") && !has_line(&wt, "line12"),
        "{wt:?}"
    );
    let hints = s.hints(0);
    let last = hints.last().expect("revert 가 hint 를 남기지 않았다");
    assert_eq!(last.action, core::ACTION_DISCARD);
    assert!(
        last.command.contains("git stash push") && last.command.contains("f.txt"),
        "{:?}",
        last.command
    );
}

#[tokio::test]
async fn patch_rejects_bad_line_range() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(10, "TEN")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    let n = i64::try_from(fd.hunks[0].lines.len()).unwrap();
    for (from, to) in [(3, 2), (0, 2), (1, n + 1), (-1, 1)] {
        let e = patch(
            &s,
            &ctx,
            fx.p(),
            &ranged(PATCH_STAGE, from, to, &fd.diff_id),
        )
        .await
        .unwrap_err();
        assert!(e.is(WriteKind::PatchRange), "범위 {from}~{to}: {e}");
    }
}

#[tokio::test]
async fn patch_rejects_selection_without_change() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    patch_file(fx.dir(), "f.txt", 30, &[(10, "TEN")]);
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "f.txt")
        .await
        .unwrap();
    let e = patch(&s, &ctx, fx.p(), &ranged(PATCH_STAGE, 1, 1, &fd.diff_id))
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::PatchEmpty), "{e}");
}

#[tokio::test]
async fn patch_handles_no_newline_at_eof() {
    let Some((s, fx)) = patch_repo() else { return };
    let ctx = bg();
    std::fs::write(fx.join("n.txt"), "a\nb\nc").unwrap();
    git_run(fx.dir(), &["add", "n.txt"]);
    git_run(fx.dir(), &["commit", "-m", "n"]);
    std::fs::write(fx.join("n.txt"), "a\nb\nC").unwrap();
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "n.txt")
        .await
        .unwrap();
    assert_eq!(fd.hunks.len(), 1);
    patch(
        &s,
        &ctx,
        fx.p(),
        &po(
            PATCH_STAGE,
            query::AXIS_WORKTREE_INDEX,
            "n.txt",
            0,
            &fd.diff_id,
        ),
    )
    .await
    .unwrap();
    let idx = index_lines(fx.p(), "n.txt").await;
    assert!(has_line(&idx, "C"), "{idx:?}");
}

#[tokio::test]
async fn patch_large_file_stages_hunk() {
    let Some(fx) = temp_repo() else { return };
    let line = "y".repeat(63) + "\n";
    let n = (2 << 20) / line.len();
    std::fs::write(fx.join("big.txt"), line.repeat(n)).unwrap();
    git_run(fx.dir(), &["add", "big.txt"]);
    git_run(fx.dir(), &["commit", "-m", "big"]);
    std::fs::write(fx.join("big.txt"), line.to_uppercase().repeat(n)).unwrap();
    let s = Service::new();
    let ctx = bg();
    let fd = query::hunks_of(&s, &ctx, fx.p(), query::AXIS_WORKTREE_INDEX, "big.txt")
        .await
        .unwrap();
    patch(
        &s,
        &ctx,
        fx.p(),
        &po(
            PATCH_STAGE,
            query::AXIS_WORKTREE_INDEX,
            "big.txt",
            0,
            &fd.diff_id,
        ),
    )
    .await
    .unwrap();
    let idx = index_lines(fx.p(), "big.txt").await;
    assert!(
        idx.first()
            .is_some_and(|l| *l == line.trim_end_matches('\n').to_uppercase()),
        "스테이지되지 않았다"
    );
    let recs = s.records(0);
    let last = recs.last().unwrap();
    assert!(
        last.write && last.argv().first().is_some_and(|a| a == "apply"),
        "{last:?}"
    );
}
