//! /api/git/tag{,/validate,/delete,/push,/delete-remote} — 태그 표면 (GIT_ACTIONS_SRS §3.3
//! FR-GIT-260~262). Go `handlers_git_tag.go`.
//!
//! 목록은 /api/git/refs 다 (FR-GIT-147). 삭제는 두 라우트다 (FR-GIT-261) — 로컬과 원격은 하나가
//! 다른 하나를 자동으로 하지 않는다. 원격을 지나는 둘은 잡 경로다 (FR-GIT-101~104).

use dm_shared_httpresp::Response;
use dm_webserver_action::Answer;
use dm_webserver_apierr::{self as apierr, Classify, Sentinel};
use dm_webserver_domain_git_core::{Kind, WriteSpec};
use dm_webserver_domain_git_query as query;
use dm_webserver_domain_git_write::{self as write, TagCreateOpts, TagRemoteOpts, WriteKind};
use http::StatusCode;
use serde::Deserialize;

use crate::GitServer;
use crate::answers::err_answer;
use crate::reply::{Bare, WErr, git_err_json, git_error, git_json, git_tail, obj};
use crate::req::Req;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitTagCreateReq")]
struct TagCreateReq {
    repo: String,
    name: String,
    r#ref: String,
    kind: String,
    message: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitTagDeleteReq")]
struct TagDeleteReq {
    repo: String,
    name: String,
    confirm: bool,
}

/// `remote` 가 비면 서버가 정한다. 자격증명을 담는 필드가 없다 (FR-GIT-104).
#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitTagRemoteReq")]
struct TagRemoteReq {
    repo: String,
    remote: String,
    name: String,
    all: bool,
    confirm: bool,
}

impl GitServer {
    /// POST /api/git/tag — 태그를 만든다 (FR-GIT-260).
    pub(crate) async fn api_git_tag_create(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<TagCreateReq>(r).await;
        t.resolve(&req.repo).await;
        let opts = TagCreateOpts {
            name: req.name.clone(),
            r#ref: req.r#ref.clone(),
            kind: req.kind.clone(),
            message: req.message.clone(),
        };
        // 대화상자의 답(`git.tag.create`)과 같은 판정이다 (GV-e · D-SDA-6).
        let a: Answer = err_answer(
            write::check_tag_message(&req.kind, &req.message)
                .err()
                .as_ref(),
        );
        if !t.judge(Ok::<_, Bare>(a)) {
            return t.finish();
        }
        // 잘못된 요청은 실행 전에 답한다.
        if let Err(e) = write::tag_create_args(&opts) {
            t.reject(&e);
        }
        if t.stop() {
            return t.finish();
        }
        if let Some(res) = self
            .git_tag_name_taken(&t.git(), &t.ctx(), &req.repo, &t.root, &req.name)
            .await
        {
            return res;
        }
        let (git, root) = (t.git(), t.root.clone());
        t.apply(|ctx| async move {
            write::tag_create(git.service(), &ctx, &root, &opts)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(Some(&obj! {"tag" => req.name}));
        t.finish()
    }

    /// POST /api/git/tag/delete — 로컬 태그를 지운다. 파괴적이다 (FR-GIT-89·261). 원격은 건드리지
    /// 않는다.
    pub(crate) async fn api_git_tag_delete(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<TagDeleteReq>(r).await;
        t.require_confirm(
            true,
            req.confirm,
            "태그 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·261)",
        );
        if let Err(e) = write::tag_delete_args(&req.name) {
            t.reject(&e);
        }
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        // 없는 태그는 실행 전에 404 로 답한다.
        let git = t.git();
        match query::tag_exists(git.service(), &t.ctx(), &t.root, &req.name).await {
            Err(e) => return git_error(&e),
            Ok(false) => {
                t.reject_with(
                    StatusCode::NOT_FOUND,
                    apierr::CODE_NOT_FOUND,
                    &format!("태그 {} 가 없다", req.name),
                );
                return t.finish();
            }
            Ok(true) => {}
        }
        let root = t.root.clone();
        let name = req.name.clone();
        t.apply(|ctx| async move {
            write::tag_delete(git.service(), &ctx, &root, &name)
                .await
                .map(drop)
                .map_err(WErr::from)
        })
        .await;
        t.ok(Some(&obj! {"tag" => req.name}));
        t.finish()
    }

    /// POST /api/git/tag/push — 태그 하나 또는 전부를 민다 (FR-GIT-262). 잡이다.
    pub(crate) async fn api_git_tag_push(&self, r: &mut Req) -> Response {
        self.git_tag_remote_route(r, false).await
    }

    /// POST /api/git/tag/delete-remote — 원격의 태그를 지운다. 파괴적이다 (FR-GIT-261). 로컬은
    /// 건드리지 않는다.
    pub(crate) async fn api_git_tag_delete_remote(&self, r: &mut Req) -> Response {
        self.git_tag_remote_route(r, true).await
    }

    /// GET /api/git/tag/validate?repo=&name= — 이름 규칙 검사 (FR-GIT-260). 위반은 200 의 본문이다
    /// (branch/validate 와 같은 규약).
    pub(crate) async fn api_git_tag_validate(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let name = r.q("name");
        let mut body = obj! {
            "requested" => obj! {"repo" => requested, "name" => name},
            "repo" => root,
            "ok" => true,
            "reason" => "",
            "exists" => false,
            "kinds" => write::TAG_KINDS,
        };
        if let Err(e) = query::valid_tag_name(git.service(), &r.ctx, &root, &name).await {
            if !Classify::is(&e, &Sentinel::Core(Kind::RefName)) {
                // 이름의 문제가 아니라 저장소·git 의 문제다.
                return git_error(&e);
            }
            body.extend(obj! {"ok" => false, "reason" => git_tail(&e.to_string())});
            return git_json(StatusCode::OK, &body);
        }
        match query::tag_exists(git.service(), &r.ctx, &root, &name).await {
            Ok(found) => {
                body.extend(obj! {"exists" => found});
                git_json(StatusCode::OK, &body)
            }
            Err(e) => git_error(&e),
        }
    }

    /// 원격을 지나는 둘의 공통 절차다 (FR-GIT-261·262). spec 을 실행 전에 만든다 — hint 는 등록이
    /// 성공한 뒤에만 남긴다 (REPO_FIX 01 §5.1).
    async fn git_tag_remote_route(&self, r: &mut Req, delete: bool) -> Response {
        let (mut t, req) = self.begin_write::<TagRemoteReq>(r).await;
        if t.stop() {
            return t.finish();
        }
        t.require_confirm(
            delete,
            req.confirm,
            "원격 ref 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89·261)",
        );
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let git = t.git();
        let mut remote = req.remote.clone();
        if remote.is_empty() {
            match query::default_remote(git.service(), &t.ctx(), &t.root).await {
                Ok(got) => remote = got,
                Err(e) => {
                    t.reject(&e);
                    return t.finish();
                }
            }
        }
        let opts = TagRemoteOpts {
            remote: remote.clone(),
            name: req.name.clone(),
            all: req.all,
        };
        let spec: Result<(WriteSpec, Option<_>), write::Error> = if delete {
            write::tag_delete_remote_spec(git.service(), &t.ctx(), &t.root, &opts)
                .await
                .map(|(s, h)| (s, Some(h)))
        } else {
            write::tag_push_spec(&opts).map(|s| (s, None))
        };
        match spec {
            Ok((sp, hint)) => {
                let extra = obj! {"remote" => remote, "tag" => req.name, "all" => req.all};
                t.start_hinted_job("push", sp, Some(&extra), hint).await;
            }
            Err(e) => t.reject(&e),
        }
        t.finish()
    }

    /// 이름 규칙과 이름 충돌을 실행 전에 답한다 (FR-GIT-250.3). `Some` 이면 다 만든 응답이다.
    async fn git_tag_name_taken(
        &self,
        git: &std::sync::Arc<dm_webserver_domain_git_store::Store>,
        ctx: &dm_webserver_domain_git_core::Ctx,
        requested: &str,
        root: &str,
        name: &str,
    ) -> Option<Response> {
        let e = write::check_new_tag_name(git.service(), ctx, root, name)
            .await
            .err()?;
        if !Classify::is(&e, &Sentinel::Write(WriteKind::TagExists)) {
            return Some(git_error(&e));
        }
        Some(git_err_json(
            StatusCode::CONFLICT,
            apierr::CODE_TAG_EXISTS,
            &obj! {
                "error" => apierr::CODE_TAG_EXISTS,
                "message" => format!("태그 {name} 가 이미 있다"),
                "requested" => requested,
                "repo" => root,
                "tag" => name,
            },
        ))
    }
}
