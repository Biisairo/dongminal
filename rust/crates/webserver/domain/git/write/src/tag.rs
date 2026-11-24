//! 태그 (FR-GIT-258~262).

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Output, Service, WriteSpec};
use dm_webserver_domain_git_query as query;
use serde::{Deserialize, Serialize};

use crate::commit::{argv, spec};
use crate::error::{Error, WriteKind, exec_write};
use crate::remote::{PROGRESS_FLAG, check_remote_name};

const TAG_ANNOTATE_FLAG: &str = "-a";
const TAG_SIGN_FLAG: &str = "-s";
const TAG_MESSAGE_FLAG: &str = "-m";
const TAG_DELETE_FLAG: &str = "-d";
pub(crate) const PUSH_DELETE_FLAG: &str = "--delete";
const PUSH_ALL_TAGS_FLAG: &str = "--tags";

pub const TAG_LIGHTWEIGHT: &str = "";
pub const TAG_ANNOTATED: &str = "annotated";
pub const TAG_SIGNED: &str = "signed";
pub const TAG_KINDS: [&str; 3] = [TAG_LIGHTWEIGHT, TAG_ANNOTATED, TAG_SIGNED];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.TagCreateOpts")]
pub struct TagCreateOpts {
    pub name: String,
    /// 비면 HEAD.
    pub r#ref: String,
    pub kind: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "write.TagRemoteOpts")]
pub struct TagRemoteOpts {
    pub remote: String,
    pub name: String,
    pub all: bool,
}

pub fn tag_create_args(o: &TagCreateOpts) -> Result<Vec<String>, Error> {
    core::check_ref_arg("name", &o.name)?;
    if !o.r#ref.is_empty() {
        core::check_ref_arg("ref", &o.r#ref)?;
    }
    check_tag_message(&o.kind, &o.message)?;
    let mut av = argv(&["tag"]);
    match o.kind.as_str() {
        TAG_ANNOTATED => av.push(TAG_ANNOTATE_FLAG.to_owned()),
        TAG_SIGNED => av.push(TAG_SIGN_FLAG.to_owned()),
        _ => {}
    }
    if o.kind != TAG_LIGHTWEIGHT {
        av.push(TAG_MESSAGE_FLAG.to_owned());
        av.push(o.message.clone());
    }
    av.push(o.name.clone());
    if !o.r#ref.is_empty() {
        av.push(o.r#ref.clone());
    }
    Ok(av)
}

pub fn check_tag_message(kind: &str, message: &str) -> Result<(), Error> {
    match kind {
        TAG_LIGHTWEIGHT => Ok(()),
        TAG_ANNOTATED | TAG_SIGNED => {
            if message.trim().is_empty() {
                return Err(Error::new(
                    WriteKind::TagMessage,
                    format!("{kind} 태그에는 메시지가 필요하다"),
                ));
            }
            Ok(())
        }
        _ => Err(Error::new(WriteKind::TagKind, quote(kind))),
    }
}

pub fn tag_delete_args(name: &str) -> Result<Vec<String>, Error> {
    core::check_ref_arg("name", name)?;
    Ok(argv(&["tag", TAG_DELETE_FLAG, name]))
}

pub fn tag_push_args(o: &TagRemoteOpts) -> Result<Vec<String>, Error> {
    let mut av = tag_remote_argv(o)?;
    if o.all {
        av.push(PUSH_ALL_TAGS_FLAG.to_owned());
    } else {
        av.push(format!("{}{}", query::TAG_REF_PREFIX, o.name));
    }
    Ok(av)
}

pub fn tag_delete_remote_args(o: &TagRemoteOpts) -> Result<Vec<String>, Error> {
    if o.all {
        return Err(Error::new(
            WriteKind::TagPushTarget,
            "원격 삭제는 태그 하나만 받는다",
        ));
    }
    let mut av = tag_remote_argv(o)?;
    av.push(PUSH_DELETE_FLAG.to_owned());
    av.push(format!("{}{}", query::TAG_REF_PREFIX, o.name));
    Ok(av)
}

pub async fn tag_create(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &TagCreateOpts,
) -> Result<Output, Error> {
    let av = tag_create_args(o)?;
    check_new_tag_name(s, ctx, repo, &o.name).await?;
    exec_write(s, ctx, repo, spec(av, false)).await
}

/// 로컬 태그 삭제. 파괴적이며 되살리는 hint 를 실행 전에 남긴다.
pub async fn tag_delete(s: &Service, ctx: &Ctx, repo: &str, name: &str) -> Result<Output, Error> {
    let av = tag_delete_args(name)?;
    let oid = match query::tag_oid(s, ctx, repo, name).await {
        Ok(o) => o,
        Err(e) => return Err(tag_missing(name, e)),
    };
    s.add_hint(tag_delete_hint(repo, name, &oid));
    exec_write(s, ctx, repo, spec(av, true)).await
}

pub fn tag_push_spec(o: &TagRemoteOpts) -> Result<WriteSpec, Error> {
    Ok(spec(tag_push_args(o)?, false))
}

/// 원격 태그 삭제. 로컬에 같은 태그가 없으면 oid 없는 hint 다.
pub async fn tag_delete_remote_spec(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    o: &TagRemoteOpts,
) -> Result<(WriteSpec, Hint), Error> {
    let av = tag_delete_remote_args(o)?;
    let oid = query::tag_oid(s, ctx, repo, &o.name)
        .await
        .unwrap_or_default();
    Ok((
        spec(av, true),
        tag_delete_remote_hint(repo, &o.remote, &o.name, &oid),
    ))
}

pub async fn check_new_tag_name(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    name: &str,
) -> Result<(), Error> {
    query::valid_tag_name(s, ctx, repo, name).await?;
    if query::tag_exists(s, ctx, repo, name).await? {
        return Err(Error::new(
            WriteKind::TagExists,
            format!("태그 {} 가 이미 있다", quote(name)),
        ));
    }
    Ok(())
}

pub fn tag_delete_hint(repo: &str, name: &str, oid: &str) -> Hint {
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_TAG_DELETE.to_owned(),
        targets: Some(vec![format!("{}{name}", query::TAG_REF_PREFIX)]),
        values: Some(vec![oid.to_owned()]),
        command: format!("git tag {name} {oid}"),
        note: "로컬 태그만 지운다 — 원격의 같은 태그는 그대로 남는다 (FR-GIT-261).".to_owned(),
        ..Hint::default()
    }
}

pub fn tag_delete_remote_hint(repo: &str, remote: &str, name: &str, oid: &str) -> Hint {
    let mut h = Hint {
        repo: repo.to_owned(),
        action: core::ACTION_REMOTE_REF_DELETE.to_owned(),
        targets: Some(vec![format!("{remote} {}{name}", query::TAG_REF_PREFIX)]),
        note: "원격의 태그만 지운다 — 로컬의 같은 태그는 그대로 남는다 (FR-GIT-261).".to_owned(),
        ..Hint::default()
    };
    if oid.is_empty() {
        h.note = "로컬에 같은 태그가 없어 되살릴 oid 를 얻지 못했다 — 원격이 가리키던 값은 그 원격에만 있다.".to_owned();
        return h;
    }
    h.values = Some(vec![oid.to_owned()]);
    h.command = format!("git push {remote} {oid}:{}{name}", query::TAG_REF_PREFIX);
    h
}

fn tag_missing(name: &str, err: query::Error) -> Error {
    if err.core().and_then(core::plain_exit).is_some() {
        return Error::new(
            WriteKind::TagNotFound,
            format!("태그 {} 가 없다", quote(name)),
        );
    }
    err.into()
}

fn tag_remote_argv(o: &TagRemoteOpts) -> Result<Vec<String>, Error> {
    check_remote_name(&o.remote)?;
    if o.all != o.name.is_empty() {
        return Err(Error::new(
            WriteKind::TagPushTarget,
            format!(
                "태그 하나 또는 전부(--tags) 중 하나여야 한다: name={} all={}",
                quote(&o.name),
                o.all
            ),
        ));
    }
    if !o.name.is_empty() {
        core::check_ref_arg("name", &o.name)?;
    }
    Ok(argv(&["push", PROGRESS_FLAG, &o.remote]))
}
