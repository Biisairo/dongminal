//! /api/git/{log,commit,refs} — 히스토리 조회 (Go `handlers_git_history.go`).

use std::sync::Arc;

use http::StatusCode;
use otter_gocompat::neturl::Values;
use otter_shared_httpresp::Response;
use otter_webserver_domain_git_core::Ctx;
use otter_webserver_domain_git_query::{self as query, Commit, CommitRef, LogQuery};
use otter_webserver_domain_git_store::Store;
use serde::Serialize;

use crate::GitServer;
use crate::answers::split_remote_ref;
use crate::reply::{ERR_BAD_REQUEST, embed, git_error, git_error_code, git_fail, git_json, raw};
use crate::req::Req;

/// FNV-1a 32 의 시작값과 곱수.
const FNV32_OFFSET: u32 = 0x811c_9dc5;
const FNV32_PRIME: u32 = 0x0100_0193;

/// 클라이언트가 보낸 값 그대로다 — 다음 쪽 요청과 stale 가드의 근거다.
#[derive(Clone, Default, Serialize)]
struct LogRequested {
    repo: String,
    #[serde(rename = "ref")]
    r#ref: String,
    skip: i64,
    limit: i64,
    order: String,
    author: String,
    since: String,
    until: String,
    path: String,
    grep: String,
    reflog: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    stop: String,
}

/// stop 에서 자른 꼬리의 요약이다 — 화면이 가진 꼬리와 같은지 견주는 근거다.
#[derive(Serialize)]
struct LogTail {
    count: usize,
    digest: String,
    refs: Vec<LogTailRef>,
}

#[derive(Serialize)]
struct LogTailRef {
    i: usize,
    refs: Vec<CommitRef>,
    #[serde(rename = "isHead")]
    is_head: bool,
}

#[derive(Serialize)]
struct LogResponse {
    requested: LogRequested,
    repo: String,
    limit: i64,
    commits: Vec<Commit>,
    signature: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    initial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail: Option<LogTail>,
}

/// oid 목록의 지문이다 (FNV-1a 32, 각 oid 뒤에 개행).
pub(crate) fn oid_digest(cs: &[Commit]) -> String {
    let mut h = FNV32_OFFSET;
    for c in cs {
        for b in c.oid.bytes().chain(std::iter::once(b'\n')) {
            h ^= u32::from(b);
            h = h.wrapping_mul(FNV32_PRIME);
        }
    }
    format!("{h:08x}")
}

/// stop 커밋에서 목록을 자른다. stop 이 없으면 그대로다.
fn log_cut(mut cs: Vec<Commit>, stop: &str) -> (Vec<Commit>, Option<LogTail>) {
    let Some(k) = cs.iter().position(|c| c.oid == stop) else {
        return (cs, None);
    };
    let rest = cs.split_off(k);
    let refs = rest
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.refs.is_empty() || c.is_head)
        .map(|(i, c)| LogTailRef {
            i,
            refs: c.refs.clone(),
            is_head: c.is_head,
        })
        .collect();
    let tail = LogTail {
        count: rest.len(),
        digest: oid_digest(&rest),
        refs,
    };
    (cs, Some(tail))
}

/// Go `strconv.ParseBool` 인자. 비면 거짓이다.
fn bool_param(q: &Values, name: &str) -> Result<bool, Response> {
    let raw = q.get_or_empty(name);
    if raw.is_empty() {
        return Ok(false);
    }
    otter_gocompat::strconv::parse_bool(&raw).map_err(|_| {
        git_fail(
            StatusCode::BAD_REQUEST,
            ERR_BAD_REQUEST,
            &format!("{name} 는 참·거짓이어야 한다: {raw}"),
        )
    })
}

/// Go `strconv.Atoi` 로 읽는 0 이상의 정수 인자. 비면 0 이다.
pub(crate) fn count_param(q: &Values, name: &str) -> Result<i64, Response> {
    let raw = q.get_or_empty(name);
    if raw.is_empty() {
        return Ok(0);
    }
    match raw.parse::<i64>() {
        Ok(n) if n >= 0 => Ok(n),
        _ => Err(git_fail(
            StatusCode::BAD_REQUEST,
            ERR_BAD_REQUEST,
            &format!("{name} 는 0 이상의 정수여야 한다: {raw}"),
        )),
    }
}

fn log_params(q: &Values, requested: String) -> Result<LogRequested, Response> {
    let skip = count_param(q, "skip")?;
    let limit = count_param(q, "limit")?;
    let reflog = bool_param(q, "reflog")?;
    let req = LogRequested {
        repo: requested,
        r#ref: q.get_or_empty("ref"),
        skip,
        limit,
        order: q.get_or_empty("order"),
        author: q.get_or_empty("author"),
        since: q.get_or_empty("since"),
        until: q.get_or_empty("until"),
        path: q.get_or_empty("path"),
        grep: q.get_or_empty("grep"),
        reflog,
        stop: q.get_or_empty("stop"),
    };
    // stop 은 첫 쪽에만 뜻이 있다 — 페이지 경계와 섞이면 꼬리가 무엇인지 정할 수 없다.
    if !req.stop.is_empty() && req.skip > 0 {
        return Err(git_fail(
            StatusCode::BAD_REQUEST,
            ERR_BAD_REQUEST,
            "stop 은 skip 과 함께 쓸 수 없다",
        ));
    }
    Ok(req)
}

/// 인자 검증으로 거부된 실패인가 — 그때는 관측하지 않는다.
fn log_rejected(err: Option<&query::Error>) -> bool {
    err.is_some_and(|e| git_error_code(e).0 == StatusCode::BAD_REQUEST)
}

impl GitServer {
    /// GET /api/git/log — 커밋 목록 한 페이지 (FR-GIT-113·114·123·128·130·280). 커밋이 없는 것은 실패가 아니다 (FR-GDT-21).
    pub(crate) async fn api_git_log(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req = match log_params(&r.query, requested) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let lq = LogQuery {
            repo: root.clone(),
            r#ref: req.r#ref.clone(),
            skip: req.skip,
            limit: req.limit,
            order: req.order.clone(),
            author: req.author.clone(),
            since: req.since.clone(),
            until: req.until.clone(),
            path: req.path.clone(),
            grep: req.grep.clone(),
            reflog: req.reflog,
        };
        let res = query::log(git.service(), &r.ctx, &lq).await;
        let rejected = log_rejected(res.as_ref().err());
        let limit = query::log_limit(req.limit);
        let commits = match res {
            Ok(c) => c,
            Err(e) => {
                if git_initial(&git, &r.ctx, &root, rejected).await {
                    let body = LogResponse {
                        requested: req,
                        repo: root,
                        limit,
                        commits: Vec::new(),
                        signature: String::new(),
                        initial: true,
                        tail: None,
                    };
                    return git_json(StatusCode::OK, &body);
                }
                return git_error(&e);
            }
        };
        let sig = git.signature(&r.ctx, &root).await.unwrap_or_default();
        let empty = commits.is_empty();
        let (commits, tail) = if req.stop.is_empty() {
            (commits, None)
        } else {
            log_cut(commits, &req.stop)
        };
        let initial = empty && git_initial(&git, &r.ctx, &root, rejected).await;
        let body = LogResponse {
            requested: req,
            repo: root,
            limit,
            commits,
            signature: sig.value,
            initial,
            tail,
        };
        git_json(StatusCode::OK, &body)
    }

    /// GET /api/git/commit?repo=&oid=&parent=<n> — 커밋 하나의 상세 (FR-GIT-136·137·139).
    pub(crate) async fn api_git_commit(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let oid = r.q("oid");
        if oid.is_empty() {
            return git_fail(StatusCode::BAD_REQUEST, ERR_BAD_REQUEST, "oid 인자가 없다");
        }
        let parent = match count_param(&r.query, "parent") {
            Ok(n) => n,
            Err(res) => return res,
        };
        #[derive(Serialize)]
        struct Requested<'a> {
            repo: &'a str,
            oid: &'a str,
            parent: i64,
        }
        let req = Requested {
            repo: &requested,
            oid: &oid,
            parent,
        };
        match query::commit_detail_of(git.service(), &r.ctx, &root, &oid, parent).await {
            Ok(d) => git_json(
                StatusCode::OK,
                &embed(&[("requested", raw(&req)), ("repo", raw(&root))], &raw(&d)),
            ),
            Err(e) => git_error(&e),
        }
    }

    /// GET /api/git/refs?repo= — 로컬·원격·태그 (FR-GIT-122). 원격 ref 는 원격 이름을 가른다 (GT-e).
    pub(crate) async fn api_git_refs(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let mut refs = match query::refs(git.service(), &r.ctx, &root).await {
            Ok(v) => v,
            Err(e) => return git_error(&e),
        };
        let mut names = match self.remote_names(&git, &r.ctx, &root).await {
            Ok(v) => v,
            Err(e) => return git_error(&e),
        };
        for rf in refs
            .iter_mut()
            .filter(|rf| rf.kind == query::REF_KIND_REMOTE)
        {
            rf.remote = split_remote_ref(&mut names, &rf.short)
                .map(|(remote, _)| remote)
                .unwrap_or_default();
        }
        #[derive(Serialize)]
        struct Requested<'a> {
            repo: &'a str,
        }
        #[derive(Serialize)]
        struct RefsResponse<'a> {
            requested: Requested<'a>,
            repo: &'a str,
            refs: Vec<query::Ref>,
        }
        git_json(
            StatusCode::OK,
            &RefsResponse {
                requested: Requested { repo: &requested },
                repo: &root,
                refs,
            },
        )
    }
}

/// 커밋이 없는 저장소인가 (FR-GDT-21). 관측 캐시를 먼저 본다 — 거부된 요청에서는 git 을
/// 실행하지 않는다.
async fn git_initial(git: &Arc<Store>, ctx: &Ctx, root: &str, rejected: bool) -> bool {
    if let Some(obs) = git.observed(root) {
        return obs.status.initial;
    }
    if rejected {
        return false;
    }
    git.status(ctx, root)
        .await
        .0
        .is_ok_and(|obs| obs.status.initial)
}
