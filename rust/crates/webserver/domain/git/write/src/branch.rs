//! 브랜치 조작 (FR-GIT-155·158·253~257). `*_args` 는 실행하지 않는 순수 함수다.

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service, WriteSpec};
use dm_webserver_domain_git_query as query;
use serde::{Deserialize, Serialize};

use crate::commit::{argv, spec};
use crate::error::{Error, WriteKind, exec_write};
use crate::remote::{
    PROGRESS_FLAG, PUSH_NO_FORCE, PushPlan, check_refspec_arg, check_remote_name, push_force_args,
};
use crate::stage::PATHS_SEP;
use crate::tag::PUSH_DELETE_FLAG;

const CHECKOUT_FORCE_FLAG: &str = "--force";
const CHECKOUT_DETACH_FLAG: &str = "--detach";
const CHECKOUT_CREATE_FLAG: &str = "-b";
const CHECKOUT_TRACK_FLAG: &str = "--track";

const BRANCH_RENAME_FLAG: &str = "-m";
const BRANCH_DELETE_FLAG: &str = "-d";
const BRANCH_DELETE_FORCE_FLAG: &str = "-D";
const BRANCH_UNSET_UPSTREAM_FLAG: &str = "--unset-upstream";
const BRANCH_SET_UPSTREAM_PREFIX: &str = "--set-upstream-to=";
const PUSH_UPSTREAM_FLAG: &str = "-u";

pub const BRANCH_CONFLICT_CHECKOUT: &str = "checkout_existing";
pub const BRANCH_CONFLICT_RENAME: &str = "create_other_name";
pub const BRANCH_CONFLICT_CANCEL: &str = "cancel";
pub const BRANCH_CONFLICT_OPTIONS: [&str; 3] = [
    BRANCH_CONFLICT_CHECKOUT,
    BRANCH_CONFLICT_RENAME,
    BRANCH_CONFLICT_CANCEL,
];

pub const MERGE_DEFAULT: &str = "";
pub const MERGE_FF_ONLY: &str = "ff-only";
pub const MERGE_NO_FF: &str = "no-ff";
pub const MERGE_SQUASH: &str = "squash";

pub const BRANCH_DELETE_FORCE: &str = "force_delete";
pub const BRANCH_DELETE_CANCEL: &str = "cancel";
pub const BRANCH_DELETE_OPTIONS: [&str; 2] = [BRANCH_DELETE_FORCE, BRANCH_DELETE_CANCEL];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.CheckoutOpts")]
pub struct CheckoutOpts {
    pub r#ref: String,
    /// 비어 있지 않으면 이 이름으로 만들며 checkout.
    pub create: String,
    /// upstream 으로 설정할 원격 ref.
    pub track: String,
    pub detach: bool,
    pub force: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.BranchCreateOpts")]
pub struct BranchCreateOpts {
    pub name: String,
    /// 비면 HEAD.
    #[serde(rename = "startRef")]
    pub start_ref: String,
    pub checkout: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.BranchRenameOpts")]
pub struct BranchRenameOpts {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.BranchDeleteOpts")]
pub struct BranchDeleteOpts {
    pub names: Option<Vec<String>>,
    pub force: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.BranchDeletePlan")]
pub struct BranchDeletePlan {
    pub names: Option<Vec<String>>,
    pub oids: Option<Vec<String>>,
    pub force: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.MergeOpts")]
pub struct MergeOpts {
    pub r#ref: String,
    pub mode: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.RebaseOpts")]
pub struct RebaseOpts {
    pub r#ref: String,
    pub onto: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.UpstreamOpts")]
pub struct UpstreamOpts {
    pub branch: String,
    pub upstream: String,
    pub unset: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.BranchPushOpts")]
pub struct BranchPushOpts {
    pub branch: String,
    pub force: String,
    pub confirm: bool,
    pub publish: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.RemoteBranchOpts")]
pub struct RemoteBranchOpts {
    pub remote: String,
    pub branch: String,
}

/// 끝의 `--` 는 이름을 ref 로만 읽게 한다 (ATTIC_FIX_SRS FR-ATF-1).
pub fn checkout_args(o: &CheckoutOpts) -> Result<Vec<String>, Error> {
    for (name, val) in [
        ("ref", &o.r#ref),
        ("create", &o.create),
        ("track", &o.track),
    ] {
        if !val.is_empty() {
            core::check_ref_arg(name, val)?;
        }
    }
    if o.create.is_empty() && o.r#ref.is_empty() {
        return Err(Error::new(WriteKind::CheckoutTarget, "옮겨 갈 ref 가 없다"));
    }
    if o.create.is_empty() && !o.track.is_empty() {
        return Err(Error::new(
            WriteKind::CheckoutTarget,
            "track 은 create 와 함께만 온다",
        ));
    }
    if !o.track.is_empty() && !o.r#ref.is_empty() {
        return Err(Error::new(
            WriteKind::CheckoutTarget,
            format!(
                "track 과 ref 를 함께 받지 않는다: {} / {}",
                quote(&o.track),
                quote(&o.r#ref)
            ),
        ));
    }
    let mut out = argv(&["checkout"]);
    if o.force {
        out.push(CHECKOUT_FORCE_FLAG.to_owned());
    }
    if o.detach {
        out.push(CHECKOUT_DETACH_FLAG.to_owned());
    }
    if !o.create.is_empty() {
        out.push(CHECKOUT_CREATE_FLAG.to_owned());
        out.push(o.create.clone());
    }
    if !o.track.is_empty() {
        out.push(CHECKOUT_TRACK_FLAG.to_owned());
        out.push(o.track.clone());
    }
    if !o.r#ref.is_empty() {
        out.push(o.r#ref.clone());
    }
    out.push(PATHS_SEP.to_owned());
    Ok(out)
}

pub fn branch_create_args(o: &BranchCreateOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("name", &o.name)?;
    if !o.start_ref.is_empty() {
        core::check_ref_arg("startRef", &o.start_ref)?;
    }
    let mut out = if o.checkout {
        argv(&["checkout", CHECKOUT_CREATE_FLAG, &o.name])
    } else {
        argv(&["branch", &o.name])
    };
    if !o.start_ref.is_empty() {
        out.push(o.start_ref.clone());
    }
    Ok(out)
}

pub fn branch_rename_args(o: &BranchRenameOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("from", &o.from)?;
    core::check_ref_arg("to", &o.to)?;
    if o.from == o.to {
        return Err(Error::new(
            WriteKind::BranchRename,
            format!("같은 이름이다: {}", quote(&o.to)),
        ));
    }
    Ok(argv(&["branch", BRANCH_RENAME_FLAG, &o.from, &o.to]))
}

/// `-d` 가 기본이고 `-D` 는 명시할 때만이다. 여러 개를 한 번에 강제 삭제하지 않는다.
pub fn branch_delete_args(o: &BranchDeleteOpts) -> Result<Vec<String>, Error> {
    let names = fold_branch_names(o.names.as_deref().unwrap_or_default());
    if names.is_empty() {
        return Err(Error::new(WriteKind::BranchDelete, "지울 브랜치가 없다"));
    }
    if o.force && names.len() > 1 {
        return Err(Error::new(
            WriteKind::BranchDelete,
            format!("일괄 삭제는 -d 로만 한다 ({}개)", names.len()),
        ));
    }
    for n in &names {
        core::check_ref_arg("name", n)?;
    }
    let flag = if o.force {
        BRANCH_DELETE_FORCE_FLAG
    } else {
        BRANCH_DELETE_FLAG
    };
    let mut out = argv(&["branch", flag]);
    out.extend(names);
    Ok(out)
}

pub fn merge_args(o: &MergeOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("ref", &o.r#ref)?;
    let mut out = argv(&["merge"]);
    match o.mode.as_str() {
        MERGE_DEFAULT => {}
        MERGE_FF_ONLY => out.push("--ff-only".to_owned()),
        MERGE_NO_FF => out.push("--no-ff".to_owned()),
        MERGE_SQUASH => out.push("--squash".to_owned()),
        _ => return Err(Error::new(WriteKind::MergeMode, quote(&o.mode))),
    }
    out.push(o.r#ref.clone());
    Ok(out)
}

pub fn rebase_args(o: &RebaseOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("ref", &o.r#ref)?;
    let mut out = argv(&["rebase"]);
    if !o.onto.is_empty() {
        core::check_ref_arg("onto", &o.onto)?;
        out.push("--onto".to_owned());
        out.push(o.onto.clone());
    }
    out.push(o.r#ref.clone());
    Ok(out)
}

/// 대상 브랜치를 반드시 받는다 (FR-GIT-257).
pub fn upstream_args(o: &UpstreamOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("branch", &o.branch)?;
    if o.unset {
        if !o.upstream.is_empty() {
            return Err(Error::new(
                WriteKind::BranchUpstream,
                format!(
                    "unset 과 upstream 을 함께 받지 않는다: {}",
                    quote(&o.upstream)
                ),
            ));
        }
        return Ok(argv(&["branch", BRANCH_UNSET_UPSTREAM_FLAG, &o.branch]));
    }
    core::check_ref_arg("upstream", &o.upstream)?;
    Ok(vec![
        "branch".to_owned(),
        format!("{BRANCH_SET_UPSTREAM_PREFIX}{}", o.upstream),
        o.branch.clone(),
    ])
}

/// 같은 이름을 하나로 접는다(처음 순서 유지) (FR-ATF-4).
pub fn fold_branch_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(names.len());
    for n in names {
        if !out.contains(n) {
            out.push(n.clone());
        }
    }
    out
}

pub fn checkout_spec(o: &CheckoutOpts) -> Result<WriteSpec, Error> {
    Ok(spec(checkout_args(o)?, o.force))
}

pub async fn branch_create(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &BranchCreateOpts,
) -> Result<Output, Error> {
    let argv = branch_create_args(o)?;
    check_new_branch_name(s, ctx, repo, &o.name).await?;
    exec_write(s, ctx, repo, spec(argv, false)).await
}

async fn check_new_branch_name(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<(), Error> {
    query::valid_branch_name(s, ctx, repo, name).await?;
    if query::local_branch_exists(s, ctx, repo, name).await? {
        return Err(Error::branch_exists_for(name));
    }
    Ok(())
}

pub async fn branch_rename(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &BranchRenameOpts,
) -> Result<Output, Error> {
    let argv = branch_rename_args(o)?;
    check_new_branch_name(s, ctx, repo, &o.to).await?;
    exec_write(s, ctx, repo, spec(argv, false)).await
}

/// 지울 브랜치마다 되살리는 hint 를 실행 전에 남긴다 (FR-GIT-92). plan 은 오류여도 돌려준다.
pub async fn branch_delete(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &BranchDeleteOpts,
) -> (Result<Output, Error>, BranchDeletePlan) {
    let names = fold_branch_names(o.names.as_deref().unwrap_or_default());
    let o = BranchDeleteOpts {
        names: Some(names.clone()),
        force: o.force,
    };
    let argv = match branch_delete_args(&o) {
        Ok(a) => a,
        Err(e) => return (Err(e), BranchDeletePlan::default()),
    };
    let mut plan = BranchDeletePlan {
        names: Some(names.clone()),
        oids: None,
        force: o.force,
    };
    for n in &names {
        match query::branch_oid(s, ctx, repo, n).await {
            Ok(oid) => plan.oids.get_or_insert_with(Vec::new).push(oid),
            Err(e) => return (Err(e.into()), plan),
        }
    }
    let oids = plan.oids.clone().unwrap_or_default();
    for (n, oid) in names.iter().zip(&oids) {
        s.add_hint(branch_delete_hint(repo, n, oid));
    }
    (exec_write(s, ctx, repo, spec(argv, true)).await, plan)
}

/// rebase 는 파괴적이다. hint 는 잡 등록이 성공한 뒤 호출자가 남긴다.
pub fn rebase_spec(repo: &str, o: &RebaseOpts, head: &str) -> Result<(WriteSpec, Hint), Error> {
    let argv = rebase_args(o)?;
    Ok((spec(argv, true), rebase_hint(repo, o, head)))
}

pub async fn set_upstream(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &UpstreamOpts,
) -> Result<Output, Error> {
    let argv = upstream_args(o)?;
    exec_write(s, ctx, repo, spec(argv, false)).await
}

/// 행의 브랜치를 그 upstream 으로 민다. plan 은 오류여도 돌려준다.
pub async fn branch_push_spec(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &BranchPushOpts,
) -> (Result<WriteSpec, Error>, PushPlan) {
    let mut plan = PushPlan {
        force: o.force.clone(),
        branch: o.branch.clone(),
        ..PushPlan::default()
    };
    let res = branch_push_inner(s, ctx, repo, o, &mut plan).await;
    (res, plan)
}

async fn branch_push_inner(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &BranchPushOpts,
    plan: &mut PushPlan,
) -> Result<WriteSpec, Error> {
    check_refspec_arg("branch", &o.branch)?;
    let mut av = argv(&["push", PROGRESS_FLAG]);
    av.extend(push_force_args(&o.force, o.confirm)?);
    let destructive = o.force != PUSH_NO_FORCE;
    let up = query::branch_upstream_target(s, ctx, repo, &o.branch).await?;
    if up.remote == "." {
        return Err(Error::new(
            WriteKind::UpstreamLocal,
            format!("{} 의 upstream 은 로컬 브랜치({})다", o.branch, up.r#ref),
        ));
    }
    if !up.remote.is_empty() && !up.r#ref.is_empty() {
        plan.remote = up.remote.clone();
        av.push(up.remote);
        av.push(format!("{}:{}", o.branch, up.r#ref));
        return Ok(spec(av, destructive));
    }
    let remote = query::default_remote(s, ctx, repo).await?;
    plan.publish = true;
    plan.remote = remote.clone();
    if !o.publish {
        return Err(Error::new(
            WriteKind::PublishRequired,
            format!(
                "{remote}/{} 를 {} 의 upstream 으로 설정한다",
                o.branch, o.branch
            ),
        ));
    }
    av.push(PUSH_UPSTREAM_FLAG.to_owned());
    av.push(remote);
    av.push(o.branch.clone());
    Ok(spec(av, destructive))
}

/// `git fetch --progress <remote> <branch>:<branch>`
pub fn remote_fetch_spec(o: &RemoteBranchOpts) -> Result<WriteSpec, Error> {
    check_remote_branch(o)?;
    Ok(spec(
        vec![
            "fetch".to_owned(),
            PROGRESS_FLAG.to_owned(),
            o.remote.clone(),
            format!("{}:{}", o.branch, o.branch),
        ],
        false,
    ))
}

/// 원격 브랜치 삭제. 파괴적이며 되살리는 push 를 hint 로 싣는다 (FR-GIT-268).
pub async fn remote_branch_delete_spec(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &RemoteBranchOpts,
) -> Result<(WriteSpec, Hint), Error> {
    check_remote_branch(o)?;
    let oid = query::remote_branch_oid(s, ctx, repo, &format!("{}/{}", o.remote, o.branch)).await?;
    Ok((
        spec(
            vec![
                "push".to_owned(),
                PROGRESS_FLAG.to_owned(),
                o.remote.clone(),
                PUSH_DELETE_FLAG.to_owned(),
                format!("{}{}", query::BRANCH_REF_PREFIX, o.branch),
            ],
            true,
        ),
        remote_branch_delete_hint(repo, o, &oid),
    ))
}

fn check_remote_branch(o: &RemoteBranchOpts) -> Result<(), Error> {
    check_remote_name(&o.remote)?;
    check_refspec_arg("remote", &o.remote)?;
    check_refspec_arg("branch", &o.branch)?;
    Ok(())
}

fn branch_delete_hint(repo: &str, name: &str, oid: &str) -> Hint {
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_BRANCH_DELETE.to_owned(),
        targets: Some(vec![name.to_owned()]),
        values: Some(vec![oid.to_owned()]),
        command: format!("git branch {name} {oid}"),
        note: format!("지우기 전 {name} 는 {oid} 를 가리켰다. 위 명령이 그 자리로 되돌린다."),
        ..Hint::default()
    }
}

fn rebase_hint(repo: &str, o: &RebaseOpts, head: &str) -> Hint {
    let target = if o.onto.is_empty() {
        o.r#ref.clone()
    } else {
        format!("{} ← {}", o.onto, o.r#ref)
    };
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_REBASE.to_owned(),
        targets: Some(vec![target]),
        values: Some(vec![head.to_owned()]),
        command: format!("git reset --hard {head}"),
        note: format!(
            "rebase 전 HEAD 는 {head} 였다. 커밋 해시가 바뀌므로 위 명령이 유일한 되돌림이다."
        ),
        ..Hint::default()
    }
}

fn remote_branch_delete_hint(repo: &str, o: &RemoteBranchOpts, oid: &str) -> Hint {
    let full = format!("{}/{}", o.remote, o.branch);
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_REMOTE_REF_DELETE.to_owned(),
        targets: Some(vec![full.clone()]),
        values: Some(vec![oid.to_owned()]),
        command: format!("git push {} {oid}:refs/heads/{}", o.remote, o.branch),
        note: format!("지우기 전 {full} 는 {oid} 였다. 위 명령이 원격에 그 ref 를 다시 만든다."),
        ..Hint::default()
    }
}
