//! 원격 목록 (FR-GIT-269). URL 의 자격증명은 저장 전에 지운다 (FR-GIT-104).

use dm_webserver_domain_git_core::{Ctx, Service, sanitize_remote};
use serde::Serialize;

use crate::error::{Error, QueryKind};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Remote {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(rename = "pushUrl", skip_serializing_if = "String::is_empty")]
    pub push_url: String,
}

pub async fn remotes(s: &Service, ctx: &Ctx, repo: &str) -> Result<Vec<Remote>, Error> {
    let out = s.exec(ctx, repo, &["config", "--list"]).await?;
    Ok(parse_remotes(&out.stdout_str()))
}

/// 기본 원격이다. 하나면 그것, 여럿이면 origin. 정할 수 없으면 NoRemote.
pub async fn default_remote(s: &Service, ctx: &Ctx, repo: &str) -> Result<String, Error> {
    let out = s.exec(ctx, repo, &["config", "--list"]).await?;
    let names: Vec<String> = parse_remotes(&out.stdout_str())
        .into_iter()
        .map(|r| r.name)
        .collect();
    match names.len() {
        0 => Err(Error::new(QueryKind::NoRemote, "원격이 없다")),
        1 => Ok(names[0].clone()),
        _ if names.iter().any(|x| x == "origin") => Ok("origin".into()),
        n => Err(Error::new(
            QueryKind::NoRemote,
            format!("원격이 {n} 개이고 origin 이 없다: [{}]", names.join(" ")),
        )),
    }
}

pub(crate) fn parse_remotes(out: &str) -> Vec<Remote> {
    let mut list: Vec<Remote> = Vec::new();
    for line in out.split('\n') {
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("remote.") else {
            continue;
        };
        let (name, is_url) = if let Some(n) = rest.strip_suffix(".url") {
            (n, true)
        } else if let Some(n) = rest.strip_suffix(".pushurl") {
            (n, false)
        } else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let idx = match list.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                list.push(Remote {
                    name: name.into(),
                    ..Remote::default()
                });
                list.len() - 1
            }
        };
        if is_url {
            list[idx].url = sanitize_remote(val);
        } else {
            list[idx].push_url = sanitize_remote(val);
        }
    }
    list.retain(|r| !r.url.is_empty());
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}
