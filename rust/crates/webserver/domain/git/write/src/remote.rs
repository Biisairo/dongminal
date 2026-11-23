//! fetch·pull·push 와 원격 설정 (FR-GIT-85~90·267).

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service, WriteSpec};
use dm_webserver_domain_git_query as query;
use serde::{Deserialize, Serialize};

use crate::commit::{argv, spec};
use crate::error::{Error, WriteKind, exec_write};

pub(crate) const PROGRESS_FLAG: &str = "--progress";

pub const PULL_DEFAULT: &str = "";
pub const PULL_REBASE: &str = "rebase";
pub const PULL_FF_ONLY: &str = "ff-only";
pub const PULL_NO_FF: &str = "no-ff";

pub const PUSH_NO_FORCE: &str = "";
pub const PUSH_LEASE: &str = "lease";
pub const PUSH_FORCE: &str = "force";

pub const REMOTE_REMOVE_ACTION: &str = "remote_remove";
const REMOTE_NAME_BAD: &[char] = &[
    '/', ' ', '\t', '\n', '\r', '~', '^', ':', '?', '*', '[', '\\',
];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.FetchOpts")]
pub struct FetchOpts {
    pub prune: bool,
    pub tags: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.PullOpts")]
pub struct PullOpts {
    pub mode: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.PushOpts")]
pub struct PushOpts {
    pub force: String,
    pub confirm: bool,
    pub publish: bool,
    pub remote: String,
    pub branch: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.PushPlan")]
pub struct PushPlan {
    pub publish: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub remote: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub force: String,
}

pub fn fetch_spec(o: &FetchOpts) -> WriteSpec {
    let mut av = argv(&["fetch", PROGRESS_FLAG]);
    if o.prune {
        av.push("--prune".to_owned());
    }
    match o.tags {
        Some(true) => av.push("--tags".to_owned()),
        Some(false) => av.push("--no-tags".to_owned()),
        None => {}
    }
    spec(av, false)
}

pub fn pull_spec(o: &PullOpts) -> Result<WriteSpec, Error> {
    let mut av = argv(&["pull", PROGRESS_FLAG]);
    match o.mode.as_str() {
        PULL_DEFAULT => {}
        PULL_REBASE => av.push("--rebase".to_owned()),
        PULL_FF_ONLY => av.push("--ff-only".to_owned()),
        PULL_NO_FF => av.push("--no-ff".to_owned()),
        _ => return Err(Error::new(WriteKind::PullMode, quote(&o.mode))),
    }
    Ok(spec(av, false))
}

pub(crate) fn push_force_args(force: &str, confirm: bool) -> Result<Vec<String>, Error> {
    match force {
        PUSH_NO_FORCE => Ok(Vec::new()),
        PUSH_LEASE => Ok(argv(&["--force-with-lease"])),
        PUSH_FORCE => {
            if !confirm {
                return Err(Error::new(
                    WriteKind::ForceConfirm,
                    "--force 는 2단계 확인을 요구한다",
                ));
            }
            Ok(argv(&["--force"]))
        }
        _ => Err(Error::new(WriteKind::PushForce, quote(force))),
    }
}

/// push 의 spec 과 계획. plan 은 오류여도 돌려준다 (publish 확인에 쓴다).
pub async fn push_spec(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &PushOpts,
) -> (Result<WriteSpec, Error>, PushPlan) {
    let mut plan = PushPlan {
        force: o.force.clone(),
        ..PushPlan::default()
    };
    let res = push_inner(s, ctx, repo, o, &mut plan).await;
    (res, plan)
}

async fn push_inner(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &PushOpts,
    plan: &mut PushPlan,
) -> Result<WriteSpec, Error> {
    let mut av = argv(&["push", PROGRESS_FLAG]);
    av.extend(push_force_args(&o.force, o.confirm)?);
    let destructive = o.force != PUSH_NO_FORCE;
    if !o.remote.is_empty() || !o.branch.is_empty() {
        check_push_target(&o.remote, &o.branch)?;
        plan.remote = o.remote.clone();
        plan.branch = o.branch.clone();
        plan.publish = o.publish;
        if o.publish {
            av.push("-u".to_owned());
        }
        av.push(o.remote.clone());
        av.push(o.branch.clone());
        return Ok(spec(av, destructive));
    }
    let st = query::tracked_status_of(s, ctx, repo).await?;
    if st.has_upstream {
        return Ok(spec(av, destructive));
    }
    if st.detached {
        return Err(Error::new(
            WriteKind::DetachedPush,
            "detached HEAD 에는 밀 브랜치가 없다",
        ));
    }
    let remote = query::default_remote(s, ctx, repo).await?;
    plan.publish = true;
    plan.remote = remote.clone();
    plan.branch = st.branch.clone();
    if !o.publish {
        return Err(Error::new(
            WriteKind::PublishRequired,
            format!(
                "{remote}/{} 를 {} 의 upstream 으로 설정한다",
                st.branch, st.branch
            ),
        ));
    }
    av.push("-u".to_owned());
    av.push(remote);
    av.push(st.branch);
    Ok(spec(av, destructive))
}

fn check_push_target(remote: &str, branch: &str) -> Result<(), Error> {
    if let Err(e) = check_remote_name(remote) {
        return Err(Error::wrap_text(WriteKind::PushTarget, e));
    }
    if let Err(e) = core::check_ref_arg("branch", branch) {
        return Err(Error::wrap_text(WriteKind::PushTarget, e));
    }
    Ok(())
}

/// 밀 커밋의 범위다. upstream 이 없으면 브랜치 자신이다.
pub fn push_range(upstream: &str, branch: &str) -> String {
    if upstream.is_empty() {
        return branch.to_owned();
    }
    format!("{upstream}..{branch}")
}

pub fn check_remote_name(name: &str) -> Result<(), Error> {
    if let Err(e) = core::check_ref_arg("remote", name) {
        return Err(Error::wrap(WriteKind::RemoteName, e));
    }
    if name.contains(REMOTE_NAME_BAD) {
        let inner = core::Error::new(
            core::Kind::RefName,
            format!("원격 이름에 쓸 수 없는 문자가 있다: {}", quote(name)),
        );
        return Err(Error::wrap(WriteKind::RemoteName, inner));
    }
    Ok(())
}

pub fn check_remote_url(u: &str) -> Result<(), Error> {
    if u.trim().is_empty() {
        return Err(Error::new(WriteKind::RemoteUrl, "URL 이 비었다"));
    }
    if u.starts_with('-') {
        return Err(Error::new(
            WriteKind::RemoteUrl,
            format!("URL 은 - 로 시작할 수 없다: {}", quote(u)),
        ));
    }
    if u.contains('\0') {
        return Err(Error::new(WriteKind::RemoteUrl, "URL 에 NUL 이 있다"));
    }
    if u.contains([' ', '\t', '\n', '\r']) {
        return Err(Error::new(
            WriteKind::RemoteUrl,
            format!("URL 에 공백이 있다: {}", quote(u)),
        ));
    }
    Ok(())
}

pub fn remote_add_args(name: &str, u: &str) -> Result<Vec<String>, Error> {
    check_remote_name(name)?;
    check_remote_url(u)?;
    Ok(argv(&["remote", "add", name, u]))
}

pub fn remote_remove_args(name: &str) -> Result<Vec<String>, Error> {
    check_remote_name(name)?;
    Ok(argv(&["remote", "remove", name]))
}

pub async fn remote_add(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
    u: &str,
) -> Result<Output, Error> {
    let av = remote_add_args(name, u)?;
    let list = query::remotes(s, ctx, repo).await?;
    if list.iter().any(|r| r.name == name) {
        return Err(Error::new(
            WriteKind::RemoteExists,
            format!("원격 {} 가 이미 있다", quote(name)),
        ));
    }
    exec_write(s, ctx, repo, spec(av, false)).await
}

pub async fn remote_remove(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<Output, Error> {
    let av = remote_remove_args(name)?;
    let list = query::remotes(s, ctx, repo).await?;
    let Some(cur) = list.iter().find(|r| r.name == name) else {
        return Err(Error::new(
            WriteKind::RemoteMissing,
            format!("원격 {} 가 없다", quote(name)),
        ));
    };
    s.add_hint(remote_remove_hint(repo, cur));
    exec_write(s, ctx, repo, spec(av, false)).await
}

fn remote_remove_hint(repo: &str, r: &query::Remote) -> Hint {
    let mut note =
        "원격 설정만 지운다 — 가져온 객체와 refs/remotes 는 위 명령과 fetch 로 되살아난다."
            .to_owned();
    if r.url.contains("***") {
        note.push_str(" URL 에 자격증명이 박혀 있어 그 자리를 지웠다: 직접 채워 넣어야 한다.");
    }
    Hint {
        repo: repo.to_owned(),
        action: REMOTE_REMOVE_ACTION.to_owned(),
        targets: Some(vec![r.name.clone()]),
        values: Some(vec![r.url.clone()]),
        command: format!("git remote add {} {}", r.name, r.url),
        note,
        ..Hint::default()
    }
}
