//! Go `kinds_test.go` — 잡으로 옮긴 쓰기 (REPO_FIX 01 §6.1~6.3).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_webserver_domain_git_core::{self as core, Kind, Output, Service};
use dm_webserver_domain_git_write as write;

use super::support::*;
use crate::kinds::indicator_kind;
use crate::{
    Emit, Exclusion, FIX_FETCH_MERGE, FIX_FETCH_REBASE, FIX_FORCE_WITH_LEASE, Fix, JobResult, Jobs,
    JobsKind, JobsOptions, LINE_STDOUT, REMOTE_REJECT_OPTIONS, SLOT_COMMON, SLOT_INDEX, SLOT_ORDER,
    SlotInfo, StartOptions, indicator_kinds, on_finish, remote_reject_fixes, slots_of,
};

fn done_jobs() -> Jobs {
    Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(done_runner(0, "")),
            ..JobsOptions::default()
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_kind_table_accepts_shapes() {
    let cases: &[(&str, &[&str], &str)] = &[
        ("commit", &["commit", "--file=-", "--cleanup=strip"], "msg"),
        (
            "commit",
            &[
                "commit",
                "--file=-",
                "--cleanup=strip",
                "--amend",
                "--signoff",
                "--no-verify",
                "-a",
            ],
            "msg",
        ),
        ("merge", &["merge", "feature"], ""),
        ("merge", &["merge", "--no-ff", "feature"], ""),
        ("merge", &["merge", "--continue"], ""),
        ("merge", &["merge", "--abort"], ""),
        ("rebase", &["rebase", "main"], ""),
        ("rebase", &["rebase", "--onto", "abc^", "abc"], ""),
        ("rebase", &["rebase", "--skip"], ""),
        ("cherry-pick", &["cherry-pick", "abc"], ""),
        ("cherry-pick", &["cherry-pick", "-m", "1", "abc"], ""),
        ("cherry-pick", &["cherry-pick", "--continue"], ""),
        ("revert", &["revert", "-m", "2", "--no-commit", "abc"], ""),
        ("revert", &["revert", "--abort"], ""),
        ("checkout", &["checkout", "main", "--"], ""),
        (
            "checkout",
            &["checkout", "--force", "--detach", "abc", "--"],
            "",
        ),
        (
            "checkout",
            &["checkout", "-b", "new", "--track", "origin/new", "--"],
            "",
        ),
        ("checkout", &["checkout", "-b", "new", "main", "--"], ""),
        ("checkout", &["checkout", "-b", "new", "--"], ""),
        ("checkout", &["checkout", "-b", "new", "main"], ""),
        ("checkout", &["checkout", "-b", "new"], ""),
        ("am", &["am", "--skip"], ""),
        ("bisect", &["bisect", "reset"], ""),
    ];
    let repo = job_repo();
    for (kind, argv, stdin) in cases {
        let j = done_jobs();
        let jb = j
            .start(
                &repo,
                keys_of(&repo),
                kind,
                spec(argv, stdin),
                StartOptions::default(),
            )
            .unwrap_or_else(|e| panic!("{}: 거부됐다: {e}", argv.join(" ")));
        job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn job_start_kind_table_rejects_shapes() {
    let cases: &[(&str, &str, &[&str], &str)] = &[
        ("commit 메시지 인자", "commit", &["commit", "-m", "x"], ""),
        (
            "commit stdin 없음",
            "commit",
            &["commit", "--file=-", "--cleanup=strip"],
            "",
        ),
        (
            "commit 모르는 플래그",
            "commit",
            &["commit", "--file=-", "--cleanup=strip", "--allow-empty"],
            "m",
        ),
        ("merge 위치 둘", "merge", &["merge", "a", "b"], ""),
        (
            "merge 제어 뒤 인자",
            "merge",
            &["merge", "--abort", "x"],
            "",
        ),
        ("merge skip 없음", "merge", &["merge", "--skip"], ""),
        ("rebase -i", "rebase", &["rebase", "-i", "main"], ""),
        (
            "cherry-pick --no-commit",
            "cherry-pick",
            &["cherry-pick", "--no-commit", "abc"],
            "",
        ),
        (
            "revert -m 숫자 아님",
            "revert",
            &["revert", "-m", "x", "abc"],
            "",
        ),
        ("checkout -B", "checkout", &["checkout", "-B", "x"], ""),
        (
            "checkout track 단독",
            "checkout",
            &["checkout", "--track", "origin/x"],
            "",
        ),
        ("checkout 위치 둘", "checkout", &["checkout", "a", "b"], ""),
        (
            "checkout 위치 둘 + --",
            "checkout",
            &["checkout", "a", "b", "--"],
            "",
        ),
        (
            "checkout ref 뒤 -- 없음",
            "checkout",
            &["checkout", "main"],
            "",
        ),
        (
            "checkout -- 뒤 경로",
            "checkout",
            &["checkout", "main", "--", "f.txt"],
            "",
        ),
        ("am 모르는 제어", "am", &["am", "--quit"], ""),
        ("bisect good", "bisect", &["bisect", "good"], ""),
        (
            "submodule 은 Start 가 아니다",
            "submodule",
            &["submodule", "update"],
            "",
        ),
        (
            "worktree 는 Start 가 아니다",
            "worktree",
            &["worktree", "add", "x"],
            "",
        ),
        ("표에 없는 kind", "reset", &["reset", "--hard"], ""),
        ("kind 와 argv 불일치", "merge", &["rebase", "main"], ""),
    ];
    let repo = job_repo();
    for (name, kind, argv, stdin) in cases {
        let j = done_jobs();
        let err = j
            .start(
                &repo,
                keys_of(&repo),
                kind,
                spec(argv, stdin),
                StartOptions::default(),
            )
            .err()
            .unwrap_or_else(|| panic!("{name}: 거절되지 않았다"));
        assert!(
            err.is(JobsKind::JobKind)
                || err.is_core(Kind::UnsafeArgument)
                || err.is_core(Kind::WriteCommand),
            "{name}: err = {err}"
        );
    }
}

// §6.1: StartUnguarded 는 submodule·worktree 만, worktree 는 `worktree add` 만.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_start_unguarded_kind_table() {
    let j = done_jobs();
    let repo = job_repo();
    let o = StartOptions::default;
    let err = j
        .start_unguarded(&repo, keys_of(&repo), "fetch", sv(&["fetch"]), "x", o())
        .expect_err("fetch");
    assert!(err.is(JobsKind::JobKind), "fetch err = {err}");
    let err = j
        .start_unguarded(
            &repo,
            keys_of(&repo),
            "worktree",
            sv(&["worktree", "remove", "x"]),
            "x",
            o(),
        )
        .expect_err("worktree remove");
    assert!(err.is(JobsKind::JobKind), "worktree remove err = {err}");
    let a = abs_work_a();
    let jb = j
        .start_unguarded(
            &a,
            keys_of(&a),
            "worktree",
            sv(&["worktree", "add", "-b", "x", "/p"]),
            "x",
            o(),
        )
        .expect("worktree add");
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
}

// §6.2: stdin 은 실행기에 가고, Job JSON·줄·기록에는 싣지 않는다(기록은 바이트 수).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_stdin_reaches_runner_only() {
    const SECRET: &str = "커밋 메시지 비밀-본문";
    let got: Arc<Mutex<String>> = Arc::default();
    let g2 = got.clone();
    let svc = job_svc();
    let j = Jobs::new(
        svc.clone(),
        JobsOptions {
            runner: Some(runner(move |_, _, _, stdin: String, emit: Emit| {
                *g2.lock().unwrap() = stdin;
                async move {
                    emit(LINE_STDOUT, "[main abc] ok");
                    (0, None)
                }
            })),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "commit",
            spec(&["commit", "--file=-", "--cleanup=strip"], SECRET),
            StartOptions::default(),
        )
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert_eq!(*got.lock().unwrap(), SECRET, "실행기 stdin");
    let raw = serde_json::to_string(&fin).unwrap();
    assert!(!raw.contains(SECRET), "Job JSON 에 stdin 이 실렸다: {raw}");
    let recs = svc.records(1);
    assert!(
        recs.len() == 1 && recs[0].stdin_bytes == SECRET.len(),
        "기록 = {recs:?}"
    );
    let raw = serde_json::to_string(&recs[0]).unwrap();
    assert!(!raw.contains(SECRET), "기록에 stdin 이 실렸다");
}

// §6.3: slots 는 kind 에서 서버가 파생한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_slots_in_json() {
    let j = done_jobs();
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "pull",
            spec(&["pull", "--progress"], ""),
            StartOptions::default(),
        )
        .unwrap();
    assert_eq!(
        jb.slots.clone().unwrap_or_default().join(","),
        "index,common"
    );
    let v = serde_json::to_value(&jb).unwrap();
    assert_eq!(v["slots"], serde_json::json!(["index", "common"]));
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    let jb2 = j
        .start(
            &repo,
            keys_of(&repo),
            "commit",
            job_commit_spec(),
            StartOptions::default(),
        )
        .unwrap();
    assert_eq!(jb2.slots.clone().unwrap_or_default().join(","), "index");
    job_wait(&j, &jb2.id, Duration::from_secs(2)).await;
}

// §6.3: 완료 훅은 Done 공개 전·기록 뒤에 불리고, 결과를 채울 수 있다. 훅이 끝날 때까지 잡은 칸에 남는다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_finisher_fills_result_before_publish() {
    let x = Exclusion::new();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(done_runner(0, "")),
            exclusion: Some(x.clone()),
            ..JobsOptions::default()
        },
    );
    // (saw_done, saw_slot, ctx_alive)
    let seen: Arc<Mutex<Option<(bool, bool, bool)>>> = Arc::default();
    let (j2, x2, s2, repo2) = (j.clone(), x.clone(), seen.clone(), job_repo());
    let fin = on_finish(Box::new(move |ctx, mut jb| {
        Box::pin(async move {
            let cur = j2.get(&jb.id).expect("잡");
            *s2.lock().unwrap() = Some((
                cur.done,
                x2.index_busy(&repo2).is_some(),
                ctx.err().is_none(),
            ));
            jb.result = Some(JobResult {
                oid: "abc".into(),
                ..JobResult::default()
            });
            jb
        })
    }));
    let repo = job_repo();
    let jb = j
        .start(&repo, keys_of(&repo), "commit", job_commit_spec(), fin)
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    let (saw_done, saw_slot, ctx_alive) = seen.lock().unwrap().expect("훅이 불리지 않았다");
    assert!(!saw_done, "훅이 불릴 때 이미 Done 이 공개됐다");
    assert!(saw_slot, "훅이 도는 동안 칸이 비었다");
    assert!(ctx_alive, "완료 ctx 가 이미 끝났다");
    assert_eq!(
        fin.result.as_ref().map(|r| r.oid.as_str()),
        Some("abc"),
        "결과가 공개되지 않았다"
    );
    assert!(x.index_busy(&repo).is_none(), "끝난 뒤에도 칸이 찼다");
}

// §6.3: 원격 전용 판정(auth·reject·options)은 fetch·pull·push 에서만.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_remote_judgments_only_for_remote_kinds() {
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(done_runner(1, "! [rejected] could not read Username")),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "merge",
            spec(&["merge", "x"], ""),
            StartOptions::default(),
        )
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    assert!(
        !fin.rejected && !fin.auth_required && fin.options.as_ref().is_none_or(Vec::is_empty),
        "merge 에 원격 판정이 붙었다: {fin:?}"
    );
}

// §6.3: 원격이 아닌 kind 의 취소 문구.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_cancel_message_by_kind() {
    let started = Arc::new(tokio::sync::Notify::new());
    let st2 = started.clone();
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            runner: Some(runner(move |ctx: core::Ctx, _, _, _, _| {
                let s = st2.clone();
                async move {
                    s.notify_one();
                    ctx.done().await;
                    (-1, ctx.err().map(core::Error::from_ctx))
                }
            })),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "rebase",
            spec(&["rebase", "main"], ""),
            StartOptions::default(),
        )
        .unwrap();
    notified(&started).await;
    j.cancel(&jb.id);
    let fin = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert_eq!(
        fin.err,
        "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라"
    );
}

// §6.3: 상한 초과는 errorCode git_timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_timeout_error_code() {
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            ceiling: Some(Duration::from_millis(30)),
            runner: Some(block_runner(None)),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert_eq!(fin.error_code, "git_timeout");
    let v = serde_json::to_value(&fin).unwrap();
    assert_eq!(v["errorCode"], "git_timeout");
}

// §8: 서버 루트가 취소되면 잡은 server_shutdown 으로 끝나고 canceled 가 아니다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_root_cancel_is_server_shutdown() {
    let root = core::Ctx::background().with_cancel();
    let started = Arc::new(tokio::sync::Notify::new());
    let j = Jobs::new(
        job_svc(),
        JobsOptions {
            root: Some(root.clone()),
            runner: Some(block_runner(Some(started.clone()))),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "fetch",
            job_fetch_spec(),
            StartOptions::default(),
        )
        .unwrap();
    notified(&started).await;
    root.cancel();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(3)).await;
    assert!(
        fin.error_code == "server_shutdown" && !fin.canceled,
        "= errorCode {:?} canceled {}",
        fin.error_code,
        fin.canceled
    );
    assert_eq!(fin.err, "서버 종료로 중단했다 — 일부가 적용됐을 수 있다");
}

// §6.3 ②: index.lock 에 막혀 끝난 잡은 errorCode index_locked 와 lock 정보를 싣는다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_index_locked_error_code() {
    let dir = tempfile::tempdir().unwrap();
    let git_dir = dir.path().to_string_lossy().into_owned();
    let gd = git_dir.clone();
    let svc = Arc::new(
        Service::builder()
            .runner(Arc::new(move |_, _, args: Vec<String>| {
                let out = if args.len() > 1 && args[0] == "rev-parse" && args[1] == "--git-path" {
                    Output {
                        stdout: format!("{gd}/index.lock\n").into_bytes(),
                        ..Output::default()
                    }
                } else {
                    Output::default()
                };
                Box::pin(async move { Ok(out) })
            }))
            .build(),
    );
    let stderr = format!("fatal: Unable to create '{git_dir}/index.lock': File exists.");
    let j = Jobs::new(
        svc,
        JobsOptions {
            runner: Some(done_runner(128, &stderr)),
            ..JobsOptions::default()
        },
    );
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "merge",
            spec(&["merge", "x"], ""),
            StartOptions::default(),
        )
        .unwrap();
    let fin = job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    let want = dm_gocompat::filepath::join(&[git_dir.as_str(), "index.lock"]);
    let lock = fin.lock.clone().expect("lock 정보");
    assert!(
        fin.error_code == "index_locked" && dm_gocompat::filepath::clean(&lock.path) == want,
        "= errorCode {:?} lock {lock:?}",
        fin.error_code
    );
    assert!(lock.mtime_unix_ms.is_none(), "없는 파일의 mtime 을 실었다");
}

// K-h (K2): 잡 표시기에 서는가는 서버가 정한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn job_indicator_in_json() {
    let j = done_jobs();
    let repo = job_repo();
    let jb = j
        .start(
            &repo,
            keys_of(&repo),
            "pull",
            spec(&["pull", "--progress"], ""),
            StartOptions::default(),
        )
        .unwrap();
    assert!(jb.indicator, "pull 은 표시기의 잡이다");
    assert_eq!(serde_json::to_value(&jb).unwrap()["indicator"], true);
    job_wait(&j, &jb.id, Duration::from_secs(2)).await;
    let sub = j
        .start_unguarded(
            &repo,
            keys_of(&repo),
            "submodule",
            sv(&["submodule", "update"]),
            "test",
            StartOptions::default(),
        )
        .unwrap();
    assert!(!sub.indicator, "submodule 은 표시기의 잡이 아니다");
    job_wait(&j, &sub.id, Duration::from_secs(2)).await;
}

// K-f (K4): 후속 선택지는 할 일을 함께 싣는다. 순서는 Options 와 같다.
#[test]
fn remote_reject_fixes_table() {
    let fixes = remote_reject_fixes();
    assert_eq!(fixes.len(), REMOTE_REJECT_OPTIONS.len());
    for (i, f) in fixes.iter().enumerate() {
        assert_eq!(f.id, REMOTE_REJECT_OPTIONS[i], "fixes[{i}].id");
    }
    let fix = |id: &str, kind: &str, k: &str, v: &str, confirm: &str| Fix {
        id: id.into(),
        kind: kind.into(),
        body: BTreeMap::from([(k.to_owned(), v.to_owned())]),
        confirm: confirm.into(),
    };
    let want = [
        fix(FIX_FETCH_REBASE, "pull", "mode", write::PULL_REBASE, ""),
        fix(FIX_FETCH_MERGE, "pull", "mode", write::PULL_DEFAULT, ""),
        fix(
            FIX_FORCE_WITH_LEASE,
            "push",
            "force",
            write::PUSH_LEASE,
            core::ACTION_FORCE_PUSH,
        ),
    ];
    assert_eq!(fixes, want);
}

// K-g: 칸 순서는 index → common 이고, 원격 동작을 쥐는 칸은 common 하나다.
#[test]
fn slot_order() {
    assert_eq!(
        SLOT_ORDER,
        [
            SlotInfo {
                slot: SLOT_INDEX,
                remote: false
            },
            SlotInfo {
                slot: SLOT_COMMON,
                remote: true
            },
        ]
    );
    for k in ["fetch", "push"] {
        assert_eq!(slots_of(k)[0], SLOT_COMMON, "{k} 는 원격 칸을 쓴다");
    }
}

// K-j ③: 표시기에 서는 종류의 공개 목록. 정렬돼 있고, 그쪽 탭이 드는 종류는 없다.
#[test]
fn indicator_kinds_sorted() {
    let got = indicator_kinds();
    let mut sorted = got.clone();
    sorted.sort();
    assert_eq!(got, sorted, "정렬돼 있지 않다");
    let want = sv(&[
        "am",
        "bisect",
        "checkout",
        "cherry-pick",
        "commit",
        "fetch",
        "merge",
        "pull",
        "push",
        "rebase",
        "revert",
    ]);
    assert_eq!(got, want);
    for k in &got {
        assert!(indicator_kind(k), "{k:?} 는 표시기 종류가 아니다");
    }
    for k in ["submodule", "worktree"] {
        assert!(!indicator_kind(k), "{k:?} 가 표시기 종류다");
    }
}
