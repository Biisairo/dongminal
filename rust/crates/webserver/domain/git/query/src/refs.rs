//! ref 목록 (FR-GIT-140~145).

use std::sync::OnceLock;

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{Ctx, Service, unix_sec_to_milli};
use regex::Regex;
use serde::Serialize;

use crate::error::Error;
use crate::log::short_ref_name;
use crate::status::{atoi, is_false};

pub const REF_KIND_LOCAL: &str = "local";
pub const REF_KIND_REMOTE: &str = "remote";
pub const REF_KIND_TAG: &str = "tag";

const REFS_FIELDS: usize = 7;
const REFS_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(contents:subject)%00%(creatordate:unix)";
const REFS_PATTERNS: [&str; 3] = ["refs/heads", "refs/remotes", "refs/tags"];
pub(crate) const REF_TRACK_GONE: &str = "[gone]";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ref {
    pub name: String,
    pub short: String,
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub remote: String,
    pub oid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub upstream: String,
    pub ahead: i64,
    pub behind: i64,
    #[serde(skip_serializing_if = "is_false")]
    pub gone: bool,
    #[serde(rename = "isHead")]
    pub is_head: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub subject: String,
    #[serde(rename = "atUnixMs")]
    pub at_unix_ms: i64,
}

/// 로컬·원격 브랜치와 태그 전부다.
pub async fn refs(s: &Service, ctx: &Ctx, repo: &str) -> Result<Vec<Ref>, Error> {
    let mut args = vec!["for-each-ref", REFS_FORMAT];
    args.extend(REFS_PATTERNS);
    let out = s.exec(ctx, repo, &args).await?;
    if out.stdout_truncated {
        return Err(Error::other(format!(
            "git for-each-ref 의 출력이 상한({}B)에서 잘렸다: ref 목록을 온전히 줄 수 없다",
            s.max_output()
        )));
    }
    parse_refs(&out.stdout_str())
}

pub fn parse_refs(out: &str) -> Result<Vec<Ref>, Error> {
    let mut refs = Vec::new();
    for line in out.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() != REFS_FIELDS {
            return Err(Error::other(format!(
                "for-each-ref: 필드가 {}개다 (want {REFS_FIELDS}): {}",
                f.len(),
                quote(line)
            )));
        }
        let (short, kind) = short_ref_name(f[0]);
        let (ahead, behind, gone) = parse_track(f[3]);
        refs.push(Ref {
            name: f[0].into(),
            short: short.into(),
            kind: kind.into(),
            oid: f[1].into(),
            upstream: f[2].into(),
            ahead,
            behind,
            gone,
            is_head: f[4].trim() == "*",
            subject: f[5].into(),
            at_unix_ms: unix_sec_to_milli(f[6]),
            ..Ref::default()
        });
    }
    sort_tags_newest_first(&mut refs);
    Ok(refs)
}

/// 태그 자리만 최신순으로 바꾼다. 다른 ref 의 자리는 그대로다.
fn sort_tags_newest_first(refs: &mut [Ref]) {
    let idx: Vec<usize> = (0..refs.len())
        .filter(|&i| refs[i].kind == REF_KIND_TAG)
        .collect();
    if idx.len() < 2 {
        return;
    }
    let mut tags: Vec<Ref> = idx.iter().map(|&i| refs[i].clone()).collect();
    tags.sort_by(|a, b| {
        b.at_unix_ms
            .cmp(&a.at_unix_ms)
            .then_with(|| b.name.cmp(&a.name))
    });
    for (k, i) in idx.into_iter().enumerate() {
        refs[i] = tags[k].clone();
    }
}

pub(crate) fn parse_track(track: &str) -> (i64, i64, bool) {
    if track.is_empty() {
        return (0, 0, false);
    }
    if track.contains(REF_TRACK_GONE) {
        return (0, 0, true);
    }
    static AHEAD: OnceLock<Regex> = OnceLock::new();
    static BEHIND: OnceLock<Regex> = OnceLock::new();
    let ahead = AHEAD.get_or_init(|| Regex::new(r"ahead ([0-9]+)").expect("고정 정규식"));
    let behind = BEHIND.get_or_init(|| Regex::new(r"behind ([0-9]+)").expect("고정 정규식"));
    (track_num(ahead, track), track_num(behind, track), false)
}

fn track_num(re: &Regex, track: &str) -> i64 {
    re.captures(track).and_then(|m| atoi(&m[1])).unwrap_or(0)
}
