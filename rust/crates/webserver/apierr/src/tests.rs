//! Go `apierr/*_test.go` 이식.

use std::collections::HashSet;
use std::io;

use dm_webserver_domain_git_core as core;
use dm_webserver_domain_git_jobs::JobsKind;
use dm_webserver_domain_git_query::{self as query, QueryKind};
use dm_webserver_domain_git_write::{self as write, WriteKind};
use dm_webserver_domain_worktree as worktree;

use super::*;

/// 시험용: sentinel 자신은 자기와 같다 (Go `errors.Is(err, err)`).
impl Classify for Sentinel {
    fn is(&self, s: &Sentinel) -> bool {
        self == s
    }
}

const GIT_CASES: &[(Sentinel, u16, &str)] = &[
    (
        Sentinel::Core(core::Kind::IndexLocked),
        409,
        CODE_INDEX_LOCKED,
    ),
    (Sentinel::Jobs(JobsKind::RepoBusy), 409, CODE_REPO_BUSY),
    (
        Sentinel::Core(core::Kind::ServerShutdown),
        503,
        CODE_SERVER_SHUTDOWN,
    ),
    (
        Sentinel::Worktree(worktree::Kind::RepoBusy),
        409,
        CODE_REPO_BUSY,
    ),
    (
        Sentinel::Write(WriteKind::PatchStale),
        409,
        CODE_STALE_OBSERVATION,
    ),
    (
        Sentinel::Write(WriteKind::CleanChanged),
        409,
        CODE_STALE_OBSERVATION,
    ),
    (
        Sentinel::Write(WriteKind::PatchEmpty),
        400,
        CODE_PATCH_EMPTY,
    ),
    (Sentinel::Write(WriteKind::PatchOp), 400, CODE_BAD_REQUEST),
    (Sentinel::Write(WriteKind::PatchAxis), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Write(WriteKind::PatchRange),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Query(QueryKind::DiffTruncated),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Write(WriteKind::RemoteExists),
        409,
        CODE_REMOTE_EXISTS,
    ),
    (
        Sentinel::Write(WriteKind::RemoteMissing),
        404,
        CODE_REMOTE_MISSING,
    ),
    (
        Sentinel::Write(WriteKind::RemoteName),
        400,
        CODE_REMOTE_NAME_INVALID,
    ),
    (
        Sentinel::Write(WriteKind::RemoteUrl),
        400,
        CODE_REMOTE_URL_INVALID,
    ),
    (
        Sentinel::Write(WriteKind::PushTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Write(WriteKind::StashEmpty),
        409,
        CODE_NOTHING_TO_STASH,
    ),
    (
        Sentinel::Write(WriteKind::StashMoved),
        409,
        CODE_STASH_MOVED,
    ),
    (
        Sentinel::Write(WriteKind::PublishRequired),
        409,
        CODE_PUBLISH_REQUIRED,
    ),
    (
        Sentinel::Write(WriteKind::ForceConfirm),
        400,
        CODE_CONFIRM_REQUIRED,
    ),
    (Sentinel::Write(WriteKind::PullMode), 400, CODE_BAD_REQUEST),
    (Sentinel::Write(WriteKind::PushForce), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Write(WriteKind::DetachedPush),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Write(WriteKind::UpstreamLocal),
        400,
        CODE_BAD_REQUEST,
    ),
    (Sentinel::Query(QueryKind::NoRemote), 409, CODE_NO_REMOTE),
    (Sentinel::Jobs(JobsKind::JobBusy), 409, CODE_JOB_BUSY),
    (
        Sentinel::Write(WriteKind::BranchExists),
        409,
        CODE_BRANCH_EXISTS,
    ),
    (
        Sentinel::Write(WriteKind::CheckoutTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Write(WriteKind::BranchRename),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Write(WriteKind::BranchDelete),
        400,
        CODE_BAD_REQUEST,
    ),
    (Sentinel::Write(WriteKind::MergeMode), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Write(WriteKind::BranchUpstream),
        400,
        CODE_BAD_REQUEST,
    ),
    (Sentinel::Write(WriteKind::TagExists), 409, CODE_TAG_EXISTS),
    (Sentinel::Write(WriteKind::TagNotFound), 404, CODE_NOT_FOUND),
    (
        Sentinel::Write(WriteKind::TagKind),
        400,
        CODE_TAG_KIND_INVALID,
    ),
    (
        Sentinel::Write(WriteKind::TagMessage),
        400,
        CODE_TAG_MESSAGE_REQUIRED,
    ),
    (
        Sentinel::Write(WriteKind::TagPushTarget),
        400,
        CODE_BAD_REQUEST,
    ),
    (Sentinel::Write(WriteKind::ResetMode), 400, CODE_RESET_MODE),
    (Sentinel::Write(WriteKind::PickVerb), 400, CODE_BAD_REQUEST),
    (Sentinel::Query(QueryKind::BlameTruncated), 413, CODE_FAILED),
    (
        Sentinel::Query(QueryKind::BlamePathNotFound),
        404,
        CODE_NOT_FOUND,
    ),
    (Sentinel::Query(QueryKind::RevNotFound), 404, CODE_NOT_FOUND),
    (Sentinel::Query(QueryKind::UnsafeRev), 400, CODE_BAD_REQUEST),
    (Sentinel::Query(QueryKind::DiffPath), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Query(QueryKind::DiffBothAbsent),
        404,
        CODE_NOT_FOUND,
    ),
    (Sentinel::Query(QueryKind::DiffAxis), 400, CODE_BAD_REQUEST),
    (Sentinel::Query(QueryKind::DiffSide), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Query(QueryKind::DiffTooLarge),
        413,
        CODE_TOO_LARGE,
    ),
    (Sentinel::Query(QueryKind::LogOrder), 400, CODE_BAD_REQUEST),
    (
        Sentinel::Query(QueryKind::CommitParent),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Worktree(worktree::Kind::UnsafeArgument),
        400,
        CODE_REF_NAME,
    ),
    (
        Sentinel::Worktree(worktree::Kind::UnsafePath),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Worktree(worktree::Kind::NotRepo),
        404,
        CODE_NOT_REPO,
    ),
    (
        Sentinel::Worktree(worktree::Kind::GitMissing),
        503,
        CODE_GIT_MISSING,
    ),
    (
        Sentinel::Core(core::Kind::UnsafeArgument),
        400,
        CODE_BAD_REQUEST,
    ),
    (
        Sentinel::Core(core::Kind::WriteCommand),
        400,
        CODE_BAD_REQUEST,
    ),
    (Sentinel::Core(core::Kind::NotRepo), 404, CODE_NOT_REPO),
    (
        Sentinel::Core(core::Kind::RepoMissing),
        404,
        CODE_REPO_MISSING,
    ),
    (
        Sentinel::Core(core::Kind::GitMissing),
        503,
        CODE_GIT_MISSING,
    ),
    (Sentinel::Core(core::Kind::Timeout), 504, CODE_TIMEOUT),
    (
        Sentinel::Core(core::Kind::Canceled),
        STATUS_CLIENT_CLOSED,
        CODE_CANCELED,
    ),
    (Sentinel::Core(core::Kind::RefName), 400, CODE_REF_NAME),
];

fn tables() -> [(&'static str, Table); 3] {
    [("Git", GIT), ("Runs", RUNS), ("FS", FS)]
}

#[test]
fn git_table_matches_pre_refactor_behavior() {
    for (s, status, code) in GIT_CASES {
        assert_eq!(GIT.lookup(s), Some((*status, *code)), "{s:?}");
    }
}

#[test]
fn git_table_cases_cover_every_rule() {
    let cased: HashSet<Sentinel> = GIT_CASES.iter().map(|c| c.0).collect();
    for r in GIT.rules() {
        assert!(cased.contains(&r.err), "{:?} 에 사례가 없다", r.err);
    }
}

/// 실제 crate 오류가 감싼 사유까지 판정된다 (Go `errors.Is` 의 unwrap).
#[test]
fn git_table_classifies_real_errors() {
    let e: query::Error = core::Error::new(core::Kind::IndexLocked, "x").into();
    assert_eq!(GIT.lookup(&e), Some((409, CODE_INDEX_LOCKED)));
    let e = write::check_remote_name("a b").unwrap_err();
    assert_eq!(GIT.lookup(&e), Some((400, CODE_REMOTE_NAME_INVALID)));
    let e = write::pull_spec(&write::PullOpts { mode: "x".into() }).unwrap_err();
    assert_eq!(GIT.lookup(&e), Some((400, CODE_BAD_REQUEST)));
    let e = worktree::Error::new(worktree::Kind::NotRepo, "x");
    assert_eq!(GIT.lookup(&e), Some((404, CODE_NOT_REPO)));
    let e = query::Error::new(QueryKind::NoRemote, "x");
    assert_eq!(GIT.lookup(&e), Some((409, CODE_NO_REMOTE)));
    let e = core::Error::new(core::Kind::Canceled, "x");
    assert_eq!(GIT.lookup(&e), Some((STATUS_CLIENT_CLOSED, CODE_CANCELED)));
}

#[test]
fn git_table_is_surface_independent() {
    let codes: HashSet<&str> = GIT.codes().into_iter().collect();
    for c in &codes {
        assert!(all_codes().contains(c), "{c} 가 코드 목록에 없다");
    }
}

#[test]
fn runs_table_matches_pre_refactor_behavior() {
    use dm_webserver_domain_run::Error as R;
    let runs: Vec<(R, u16)> = vec![
        (R::UnknownRun, 404),
        (R::SenderNotMember, 403),
        (R::UnknownMember, 404),
        (R::RunMemberMismatch, 403),
        (R::RunClosed, 409),
        (R::RunOpen, 409),
        (R::AlreadyReported, 409),
        (R::ToolAlreadyMember, 409),
        (R::TreeOpen { run_id: "r".into() }, 409),
        (R::TreeNotOpen, 409),
        (
            R::NodeTaken {
                member_id: "m".into(),
            },
            409,
        ),
        (R::MemberAttached, 409),
        (R::MemberNotAttached, 409),
        (R::UnreportedMembers, 409),
        (R::InvalidArgument("세부".into()), 400),
    ];
    for (e, status) in &runs {
        assert_eq!(RUNS.lookup(e), Some((*status, e.code())), "{e:?}");
    }
    for (k, status) in [
        (worktree::Kind::NotRepo, 400),
        (worktree::Kind::GitMissing, 400),
        (worktree::Kind::UnsafeArgument, 400),
        (worktree::Kind::UnsafePath, 400),
    ] {
        let e = worktree::Error::new(k, "세부");
        assert_eq!(RUNS.lookup(&e), Some((status, k.as_str())));
    }
    let e = worktree::Error::new(worktree::Kind::RepoBusy, "세부");
    assert_eq!(RUNS.lookup(&e), Some((409, CODE_REPO_BUSY)));
    assert_eq!(runs.len() + 5, RUNS.rules().len());
}

#[test]
fn worktree_status_differs_per_surface() {
    let e = worktree::Error::new(worktree::Kind::NotRepo, "x");
    assert_eq!(GIT.lookup(&e).map(|r| r.0), Some(404));
    assert_eq!(RUNS.lookup(&e).map(|r| r.0), Some(400));
}

#[test]
fn fs_table_matches_pre_refactor_behavior() {
    use dm_webserver_domain_wsentry::Error as W;
    for (e, code) in [
        (W::NotAbsolute, CODE_BAD_REQUEST),
        (W::NotDir, CODE_BAD_REQUEST),
        (W::NotFound, CODE_NOT_FOUND),
    ] {
        let (status, got) = FS.lookup(&e).unwrap();
        assert_eq!(got, code);
        assert_eq!(status, fs_status(code));
    }
    for (k, code) in [
        (io::ErrorKind::NotFound, CODE_NOT_FOUND),
        (io::ErrorKind::AlreadyExists, CODE_EXISTS),
        (io::ErrorKind::PermissionDenied, CODE_PERMISSION),
    ] {
        let e = io::Error::from(k);
        assert_eq!(FS.lookup(&e).map(|r| r.1), Some(code));
    }
}

#[test]
fn every_sentinel_is_mapped_or_exempt() {
    let mapped: HashSet<Sentinel> = tables().iter().flat_map(|(_, t)| t.sentinels()).collect();
    let exempt: HashSet<Sentinel> = UNMAPPED.iter().map(|e| e.err).collect();
    for s in INVENTORY {
        assert!(
            mapped.contains(s) != exempt.contains(s),
            "{s:?} 는 표와 면제 중 정확히 한 곳에 있어야 한다"
        );
    }
}

#[test]
fn every_rule_is_in_inventory() {
    for (name, t) in tables() {
        for r in t.rules() {
            if matches!(r.err, Sentinel::Fs(_)) {
                continue;
            }
            assert!(INVENTORY.contains(&r.err), "{name}: {:?}", r.err);
        }
    }
}

#[test]
fn no_duplicate_rule_within_table() {
    for (name, t) in tables() {
        let mut seen = HashSet::new();
        for r in t.rules() {
            assert!(seen.insert(r.err), "{name}: {:?} 가 두 번", r.err);
        }
    }
}

#[test]
fn codes_are_identifiers_and_statuses_plausible() {
    for (name, t) in tables() {
        for r in t.rules() {
            assert!(!r.code.is_empty(), "{name}: {:?}", r.err);
            assert!(!r.code.contains([' ', '\t', '\n']), "{}", r.code);
            assert_eq!(r.code, r.code.to_lowercase());
            assert!((400..=599).contains(&r.status), "{name}: {:?}", r.err);
        }
    }
}

#[test]
fn lookup_picks_no_default_and_first_match_wins() {
    let e = core::Error::other("분류되지 않은 실패");
    assert_eq!(GIT.lookup(&e), None);
    // RemoteName 과 core RefName 을 함께 품은 오류는 먼저 오는 RemoteName 규칙이 이긴다.
    let e = write::check_remote_name("a b").unwrap_err();
    assert!(e.is(WriteKind::RemoteName) && e.is_core(core::Kind::RefName));
    assert_eq!(GIT.lookup(&e).map(|r| r.1), Some(CODE_REMOTE_NAME_INVALID));
    let _ = JobsKind::JobBusy;
}

#[test]
fn fs_status_cases() {
    for (code, want) in [
        (CODE_BAD_REQUEST, 400),
        (CODE_NOT_FOUND, 404),
        (CODE_EXISTS, 409),
        (CODE_OUTSIDE_ROOT, 403),
        (CODE_PERMISSION, 403),
        (CODE_FS_NOT_REPO, 404),
        (CODE_IO, 500),
        ("모르는 코드", 500),
    ] {
        assert_eq!(fs_status(code), want, "{code}");
    }
}

#[test]
fn exemptions_have_reasons_and_inventory_unique() {
    for e in UNMAPPED {
        assert!(e.reason.trim().len() > 10, "{:?}", e.err);
    }
    let set: HashSet<_> = INVENTORY.iter().collect();
    assert_eq!(set.len(), INVENTORY.len());
}

#[test]
fn codes_documented_and_unique() {
    let all = all_codes();
    for c in &all {
        let d = code_doc(c).unwrap_or_else(|| panic!("{c} 에 안내가 없다"));
        assert!(!d.meaning.is_empty() && !d.recover.is_empty(), "{c}");
    }
    let set: HashSet<_> = all.iter().collect();
    assert_eq!(set.len(), all.len(), "코드가 겹친다");
    for (c, _) in CODE_DOC {
        assert!(all.contains(c), "{c} 는 안내만 있고 코드가 없다");
    }
    assert!(
        CODE_DOC.windows(2).all(|w| w[0].0 < w[1].0),
        "CODE_DOC 정렬"
    );
}

#[test]
fn body_read_code_and_code_for_status() {
    assert_eq!(
        body_read_code(&dm_shared_httpreq::ReadError::TooLarge),
        CODE_BODY_TOO_BIG
    );
    for (s, c) in [
        (400, CODE_BAD_REQUEST),
        (403, CODE_FORBIDDEN),
        (404, CODE_NOT_FOUND),
        (405, CODE_NOT_ALLOWED),
        (409, CODE_CONFLICT),
        (413, CODE_TOO_LARGE),
        (421, CODE_HOST_REJECTED),
        (428, CODE_IF_MATCH_REQUIRED),
        (503, CODE_UNAVAILABLE),
        (500, CODE_INTERNAL),
        (418, CODE_BAD_REQUEST),
    ] {
        assert_eq!(code_for_status(s), c, "{s}");
    }
}
