//! Go `handlers_git_actions_input_test.go`·`handlers_git_actions_test.go`·
//! `handlers_git_actions_facts_test.go`·`handlers_git_actions_slots_test.go` 중 판정 함수 갈래.
//! Go 의 `gtBranchRepo`(실제 git 저장소) 대신 같은 ref·원격을 답하는 fake 를 쓴다. 판정 함수를
//! 직접 불러 실행 종단의 거절과 맞춰 본다. 답 종단(/api/git/actions) 쪽은 `actions.rs`·`carryover.rs` 가 잰다.
//!
//! 옮기지 않은 것:
//! - 입력 답(Tag·StashBranch·WorktreeCreate·Compare·RepoAdd)·StashCreateAnswerMatchesRejection·
//!   GitActionsUnknownAction·FactAnswers_MatchRejection: 종단을 지나므로 `actions.rs`·`carryover.rs` 에 있다.
//! - TestFactAnswers 의 stash.new 갈래는 `stash_new_answer`(비공개)가 `stash_create_answer(st, true)`
//!   그대로라 그 함수로 잰다.
//! - 칸을 보는 status actions 갈래(FollowSlots·PullHoldsBoth·InUnchanged·MatchRejection·SlotFirst)는
//!   exclusion.rs 에 있다.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::SystemTime;

use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_jobs::{Keys, SLOT_COMMON, SLOT_INDEX};
use otter_webserver_domain_git_query::{self as query, FileEntry, Status};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use otter_webserver_domain_git_write as write;
use serde_json::{Value, json};

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, qe, req};
use super::wfake::{WriteFake, fake_job_runner, out, wserver};
use crate::GitServer;
use crate::answers::{
    BranchFacts, SlotReader, clean_answer, err_answer, reset_answer, slots_answer,
    stash_create_answer, upstream_answer,
};

pub(super) fn repo() -> String {
    abs(&["work", "repo"])
}

fn may_give(id: &str, why: &str) -> bool {
    action::may_give(&action::catalog(), id, why)
}

const OID: &str = "1111111111111111111111111111111111111111";

/// Go `gtBranchRepo` 의 ref 들이다 — main·feat 는 upstream 이 있고, lone 은 없고, origin/other·
/// origin/dup 은 원격에만 있고, dupA·dupB 는 origin/dup 을 추적한다.
fn refs_out() -> String {
    let line = |name: &str, up: &str, head: &str| {
        format!("{name}\0{OID}\0{up}\0\0{head}\0c1\01700000000\n")
    };
    [
        line("refs/heads/dupA", "origin/dup", ""),
        line("refs/heads/dupB", "origin/dup", ""),
        line("refs/heads/feat", "origin/feat", ""),
        line("refs/heads/lone", "", ""),
        line("refs/heads/main", "origin/main", "*"),
        line("refs/remotes/origin/dup", "", ""),
        line("refs/remotes/origin/feat", "", ""),
        line("refs/remotes/origin/main", "", ""),
        line("refs/remotes/origin/other", "", ""),
    ]
    .concat()
}

const CONFIG_OUT: &str =
    "remote.origin.url=/tmp/remote.git\nremote.origin.fetch=+refs/heads/*:refs/remotes/origin/*\n";

pub(super) struct BEnv {
    pub(super) s: Arc<GitServer>,
    pub(super) f: WriteFake,
}

/// Go `gtBranchRepo` 를 흉내 내는 서버다 — `for-each-ref`·`config --list` 를 위 ref·원격으로
/// 답하고, 나머지는 `WriteFake` 로 넘긴다.
pub(super) fn branch_server(edit: impl FnOnce(&mut GitServer)) -> BEnv {
    let f = WriteFake::new();
    let (r, w) = (f.clone(), f.clone());
    let svc = otter_webserver_domain_git_core::Service::builder()
        .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
            let r = r.clone();
            Box::pin(async move {
                let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
                if a(0) == "for-each-ref" && a(1).starts_with("--format=%(refname)") {
                    return Ok(out(refs_out()));
                }
                if a(0) == "config" && a(1) == "--list" {
                    return Ok(out(CONFIG_OUT.to_owned()));
                }
                r.read(&dir, &args)
            })
        }))
        .write_runner(Arc::new(
            move |ctx, _dir, args: Vec<String>, stdin: String| {
                let w = w.clone();
                Box::pin(async move { w.write(&ctx, &args, &stdin) })
            },
        ))
        .build();
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(svc),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    let mut s = GitServer {
        git: Some(store),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        job_runner: Some(fake_job_runner(&f)),
        ..GitServer::default()
    };
    edit(&mut s);
    BEnv { s: Arc::new(s), f }
}

fn facts() -> BranchFacts {
    BranchFacts {
        refs: query::parse_refs(&refs_out()).unwrap(),
        st: Status::default(),
    }
}

fn args_json(a: &Answer) -> Value {
    a.args.as_ref().map_or(Value::Null, |m| json!(m))
}

/// Go `runInputCases`: 답이 거짓이면 실행이 같은 코드·같은 args 로, 문구 없이 거절된다. 답이 참이면
/// 실행이 거절되지 않는다 (TC-SDA-1 · GV-b).
async fn exec_matches(
    s: &Arc<GitServer>,
    name: &str,
    ans: &Answer,
    id: &str,
    why: &str,
    path: &str,
    body: Value,
) {
    let want_ok = why.is_empty();
    assert!(
        ans.ok == want_ok && (want_ok || ans.why == why),
        "{name}: 답 = {ans:?}, want ok={want_ok} why={why:?}"
    );
    if !want_ok {
        assert!(
            may_give(id, why),
            "{name}: {id} 의 목록에 {why} 가 없다 (M-3)"
        );
    }
    let mut body = body;
    body["repo"] = json!(repo());
    let res = req(s, "POST", path, &body.to_string()).await;
    let out = res.json();
    if want_ok {
        assert!(
            res.code < 400,
            "{name}: 답은 참인데 실행이 거절됐다: {} {out}",
            res.code
        );
        return;
    }
    assert!(
        res.code >= 400 && out["error"] == why,
        "{name}: 실행 = {} {}, want error {why}",
        res.code,
        out["error"]
    );
    assert_eq!(
        out.get("args").cloned().unwrap_or(Value::Null),
        args_json(ans),
        "{name}: 실행 args 와 답 args 가 다르다"
    );
    assert!(
        out.get("message").is_none(),
        "{name}: 서버가 문구를 실었다 (D-SDA-5): {}",
        out["message"]
    );
}

// GV-f (G-B2 · FR-SDA-41): upstream 은 알려진 원격 ref 여야 한다.
#[tokio::test]
async fn upstream_input_answer() {
    let e = branch_server(|_| {});
    let f = facts();
    let id = action::GIT_BRANCH_UPSTREAM_SET;
    for (name, branch, up, why) in [
        (
            "원격 ref 에 설정",
            "origin/feat",
            "origin/main",
            apierr::CODE_NOT_LOCAL_BRANCH,
        ),
        ("빈 upstream", "lone", " ", apierr::CODE_EMPTY_REF),
        (
            "모르는 원격 ref",
            "lone",
            "origin/nope",
            apierr::CODE_UPSTREAM_UNKNOWN,
        ),
        (
            "로컬 브랜치를 upstream 으로",
            "lone",
            "main",
            apierr::CODE_UPSTREAM_UNKNOWN,
        ),
        ("알려진 원격 ref", "lone", "origin/other", ""),
    ] {
        let ans = upstream_answer(&f, branch, up);
        let body = json!({"branch": branch, "upstream": up});
        exec_matches(&e.s, name, &ans, id, why, "/api/git/branch/upstream", body).await;
    }
    assert_eq!(
        e.f.wrote(),
        vec![vec!["branch", "--set-upstream-to=origin/other", "lone"]],
        "허용된 갈래만 실행돼야 한다"
    );
}

// GV-c (G-B4): 원격 추가의 이름·URL·이미 있는 이름.
#[tokio::test]
async fn remote_add_input_answer() {
    let e = branch_server(|_| {});
    let git = e.s.git.clone().unwrap();
    let id = action::GIT_REMOTE_ADD;
    for (name, n, u, why) in [
        ("빈 이름", "", "/tmp/x.git", apierr::CODE_EMPTY_NAME),
        (
            "쓸 수 없는 글자",
            "a/b",
            "/tmp/x.git",
            apierr::CODE_REMOTE_NAME_INVALID,
        ),
        ("빈 URL", "up", " ", apierr::CODE_EMPTY_URL),
        (
            "옵션 같은 URL",
            "up",
            "--upload-pack=x",
            apierr::CODE_REMOTE_URL_INVALID,
        ),
        (
            "이미 있는 이름",
            "origin",
            "/tmp/x.git",
            apierr::CODE_REMOTE_EXISTS,
        ),
        ("더할 수 있음", "up", "/tmp/x.git", ""),
    ] {
        let ans =
            e.s.remote_add_answer(&git, &Ctx::background(), &repo(), n, u)
                .await
                .unwrap();
        let body = json!({"name": n, "url": u});
        exec_matches(&e.s, name, &ans, id, why, "/api/git/remote/add", body).await;
    }
    assert_eq!(
        e.f.wrote(),
        vec![vec!["remote", "add", "up", "/tmp/x.git"]],
        "허용된 갈래만 실행돼야 한다"
    );
}

// GV-b: 답은 도메인 sentinel 을 apierr 표로 코드로 바꾼 것이다 — 실행 거절과 같은 표다.
#[test]
fn err_answer_maps_sentinel() {
    let a = err_answer::<write::Error>(None);
    assert!(a.ok, "nil = {a:?}, want 허용");
    let e = write::check_tag_message(write::TAG_ANNOTATED, "").unwrap_err();
    let a = err_answer(Some(&e));
    assert!(
        !a.ok && a.why == apierr::CODE_TAG_MESSAGE_REQUIRED && a.status == 400,
        "= {a:?}, want 400 tag_message_required"
    );
}

fn entries(paths: &[&str]) -> Vec<FileEntry> {
    paths
        .iter()
        .map(|p| FileEntry {
            path: (*p).to_owned(),
            ..FileEntry::default()
        })
        .collect()
}

/// 이름 · 상태 · -u · 참인가 · 사유 · args.count.
type StashCase = (&'static str, Status, bool, bool, &'static str, Option<i64>);

// TC-SDA-1 (FR-SDA-24 · M-3): stash 만들기 판정의 표 시험.
#[test]
fn stash_create_answer_table() {
    let one = entries(&["a"]);
    let cases: [StashCase; 7] = [
        (
            "staged",
            Status {
                staged: one.clone(),
                ..Status::default()
            },
            false,
            true,
            "",
            None,
        ),
        (
            "changes",
            Status {
                changes: one.clone(),
                ..Status::default()
            },
            false,
            true,
            "",
            None,
        ),
        (
            "conflicts",
            Status {
                conflicts: one.clone(),
                ..Status::default()
            },
            false,
            true,
            "",
            None,
        ),
        (
            "untracked 만 · -u 켬",
            Status {
                untracked: one.clone(),
                ..Status::default()
            },
            true,
            true,
            "",
            None,
        ),
        (
            "untracked 만 · -u 끔",
            Status {
                untracked: entries(&["a", "b"]),
                ..Status::default()
            },
            false,
            false,
            apierr::CODE_UNTRACKED_ONLY,
            Some(2),
        ),
        (
            "변경 없음 · -u 끔",
            Status::default(),
            false,
            false,
            apierr::CODE_NOTHING_TO_STASH,
            None,
        ),
        (
            "변경 없음 · -u 켬",
            Status::default(),
            true,
            false,
            apierr::CODE_NOTHING_TO_STASH,
            None,
        ),
    ];
    for (name, st, untracked, ok, why, count) in cases {
        let a = stash_create_answer(&st, untracked);
        assert!(
            a.ok == ok && a.why == why,
            "{name}: answer = {a:?}, want ok={ok} why={why:?}"
        );
        if let Some(n) = count {
            assert_eq!(
                a.args.as_ref().and_then(|m| m.get("count")).cloned(),
                Some(json!(n)),
                "{name}: args"
            );
        }
        if !a.ok {
            assert_eq!(a.status, 409, "{name}: status, want 409 (상태 때문)");
            assert!(
                may_give(action::GIT_STASH_CREATE, &a.why),
                "{name}: 사유 {:?} 가 동작 목록에 없다",
                a.why
            );
        }
    }
}

// TC-SDA-1 (GR-2b·c): 상태 사실 판정의 표 시험.
#[test]
fn fact_answers() {
    let one = entries(&["a"]);
    let st = |f: fn(&mut Status, Vec<FileEntry>)| {
        let mut s = Status::default();
        f(&mut s, one.clone());
        s
    };
    let cases = [
        (
            "stash.new · 변경 없음",
            stash_create_answer(&Status::default(), true),
            apierr::CODE_NOTHING_TO_STASH,
        ),
        (
            "stash.new · untracked 만",
            stash_create_answer(&st(|s, v| s.untracked = v), true),
            "",
        ),
        (
            "stash.new · staged",
            stash_create_answer(&st(|s, v| s.staged = v), true),
            "",
        ),
        (
            "reset · 커밋 없음",
            reset_answer(&Status {
                initial: true,
                ..Status::default()
            }),
            apierr::CODE_NO_HEAD,
        ),
        ("reset · 커밋 있음", reset_answer(&Status::default()), ""),
        (
            "clean · untracked 없음",
            clean_answer(&st(|s, v| s.changes = v)),
            apierr::CODE_NOTHING_TO_CLEAN,
        ),
        (
            "clean · untracked 있음",
            clean_answer(&st(|s, v| s.untracked = v)),
            "",
        ),
    ];
    for (name, got, why) in cases {
        assert!(
            got.ok == why.is_empty() && got.why == why,
            "{name}: answer = {got:?}, want why={why:?}"
        );
        if !got.ok {
            assert_eq!(got.status, 409, "{name}: status, want 409");
        }
    }
}

/// Go `fakeSlots`: 칸 이름 → 그 칸을 쥔 잡이다. 키는 보지 않는다.
struct FakeSlots(BTreeMap<&'static str, String>);

impl SlotReader for FakeSlots {
    fn index_busy(&self, _: &str) -> Option<String> {
        self.0.get(SLOT_INDEX).cloned()
    }
    fn common_busy(&self, _: &str) -> Option<String> {
        self.0.get(SLOT_COMMON).cloned()
    }
}

// TC-SDA-1 (GR-1a): 칸 판정의 표 시험.
#[test]
fn slots_answer_table() {
    let k = Keys {
        top: "/top".to_owned(),
        common: "/common".to_owned(),
    };
    let cases: [(&str, &[&'static str], &[&str], bool); 5] = [
        ("비어 있음", &[], &[SLOT_INDEX], true),
        (
            "index 바쁨 · index 동작",
            &[SLOT_INDEX],
            &[SLOT_INDEX],
            false,
        ),
        (
            "common 바쁨 · index 동작",
            &[SLOT_COMMON],
            &[SLOT_INDEX],
            true,
        ),
        (
            "common 바쁨 · 두 칸 동작",
            &[SLOT_COMMON],
            &[SLOT_INDEX, SLOT_COMMON],
            false,
        ),
        (
            "index 바쁨 · common 동작",
            &[SLOT_INDEX],
            &[SLOT_COMMON],
            true,
        ),
    ];
    for (name, busy, slots, ok) in cases {
        let x = FakeSlots(busy.iter().map(|s| (*s, "j1".to_owned())).collect());
        let a = slots_answer(&x, &k, slots);
        assert_eq!(a.ok, ok, "{name}: answer = {a:?}");
        if !a.ok {
            assert!(
                a.why == apierr::CODE_JOB_BUSY && a.status == 409,
                "{name}: answer = {a:?}, want 409 job_busy"
            );
        }
    }
}

/// Go `statusActions`.
pub(super) async fn status_actions(s: &Arc<GitServer>, query: &str) -> (Value, Value) {
    let res = req(
        s,
        "GET",
        &format!("/api/git/status?repo={}{query}", qe(&repo())),
        "",
    )
    .await;
    assert_eq!(res.code, 200, "status = {}", res.text());
    let out = res.json();
    let acts = out["actions"].clone();
    assert!(acts.is_object(), "status 응답에 actions 가 없다: {out}");
    (out, acts)
}

fn clean_status() -> String {
    format!("# branch.oid {}\0# branch.head main\0", "a".repeat(40))
}

/// 이름 · status 출력 · (동작, 사유)들.
type FactCase = (&'static str, String, Vec<(&'static str, &'static str)>);

// GR-2d: 셋은 1층이다 — status 응답의 같은 status 로 판정한다.
#[tokio::test]
async fn status_actions_facts() {
    let untracked = clean_status() + "? n.txt\0";
    let initial = "# branch.oid (initial)\0# branch.head main\0".to_owned();
    let cases: [FactCase; 3] = [
        (
            "깨끗함",
            clean_status(),
            vec![
                (action::GIT_STASH_NEW, apierr::CODE_NOTHING_TO_STASH),
                (action::GIT_UNCOMMITTED_CLEAN, apierr::CODE_NOTHING_TO_CLEAN),
                (action::GIT_UNCOMMITTED_RESET, ""),
            ],
        ),
        (
            "untracked 만",
            untracked,
            vec![
                (action::GIT_STASH_NEW, ""),
                (action::GIT_UNCOMMITTED_CLEAN, ""),
                (action::GIT_UNCOMMITTED_RESET, ""),
            ],
        ),
        (
            "커밋 없음",
            initial,
            vec![(action::GIT_UNCOMMITTED_RESET, apierr::CODE_NO_HEAD)],
        ),
    ];
    for (name, status, want) in cases {
        let f = WriteFake::new();
        f.lock().status = status;
        let e = wserver(&f);
        let (_, acts) = status_actions(&e.s, "").await;
        for (id, why) in want {
            let a = &acts[id];
            assert!(a.is_object(), "{name}: {id} 의 답이 없다");
            assert!(
                a["ok"] == why.is_empty() && (why.is_empty() || a["why"] == why),
                "{name}: {id} = {a}, want why={why:?}"
            );
            if !why.is_empty() {
                assert!(
                    may_give(id, why),
                    "{name}: {id} 가 동작 목록에 {why} 를 갖지 않는다"
                );
            }
        }
    }
}
