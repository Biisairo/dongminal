//! 리포 해석·핀·상태·시그니처·diff 내용 (GIT_SRS §3.8 FR-GIT-60~63). Go `handlers_git.go`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use dm_shared_fanout::{CancellationToken, each};
use dm_shared_httpresp::Response;
use dm_webserver_action::Answer;
use dm_webserver_domain_git_query as query;
use dm_webserver_domain_git_store::{self as store, Observation, Store};
use dm_webserver_domain_wsentry as wsentry;
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::GitServer;
use crate::answers::row_actions;
use crate::reply::{
    ERR_BAD_REQUEST, ERR_FAILED, Obj, embed, git_err_json, git_error, git_error_code, git_fail,
    git_json, obj, raw, status,
};
use crate::req::Req;

/// 동시에 도는 관측 수의 상한이다 (FR-GOB-3).
const OBSERVE_MAX: usize = 4;

/// Repo 탭이 핀 전부에 쥐는 임대의 갈래다 (FR-OPT-4-3).
const PINS_SCOPE: &str = "pins";

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitPathReq")]
struct PathReq {
    path: String,
}

impl GitServer {
    /// GET /api/git/repos[?observe=1|0&clientId=] — 핀 목록과 각 배지 (FR-FLW-2, FR-GOB-1).
    pub(crate) async fn api_git_repos(&self, r: &mut Req) -> Response {
        let Some(git) = self.git.clone() else {
            return crate::reply::git_unavailable();
        };
        let pins = self.git_pins_read();
        match r.q("observe").as_str() {
            "1" => {
                if let Ok(pins) = &pins {
                    self.git_observe_pins(&git, r, pins, &r.q("clientId")).await;
                }
            }
            "0" => {
                if let Some(w) = &self.watch {
                    w.release_scope(&r.q("clientId"), PINS_SCOPE);
                }
            }
            _ => {}
        }
        let pinned = self.git_pinned_entries(&git, r, pins.as_deref().ok()).await;
        git_json(StatusCode::OK, &obj! {"pinned" => pinned})
    }

    /// 핀된 저장소 전부를 관측해 배지의 근거를 새로 만든다 (FR-GOB-1~4). 실패는 삼킨다.
    /// 요청이 떠나면 남은 관측을 시작하지 않는다 (FR-GOB-6).
    async fn git_observe_pins(&self, git: &Arc<Store>, r: &Req, pins: &[String], client_id: &str) {
        let ctx = &r.ctx;
        each(ctx.token(), OBSERVE_MAX, pins.len(), |i| {
            let pin = &pins[i];
            async move {
                let Ok(root) = git.repo_root(ctx, pin).await else {
                    return;
                };
                match git.status(ctx, &root).await.0 {
                    // 관측이 실패했다 — 캐시된 루트 해석으로 isRepo:true 를 싣지 않게 잊는다.
                    Err(_) => git.forget_root(pin),
                    Ok(obs) => {
                        if let Some(w) = &self.watch {
                            w.note_scoped(&root, &obs, client_id, PINS_SCOPE);
                        }
                    }
                }
            }
        })
        .await;
    }

    /// 핀 목록을 순서 그대로 준다. 저장소가 아니게 된 핀도 지우지 않고 isRepo:false 다.
    /// 항목마다 한 칸이 계약이므로 요청이 떠나도 멈추지 않는다 (FR-PRF-55~57).
    async fn git_pinned_entries(
        &self,
        git: &Arc<Store>,
        r: &Req,
        pins: Option<&[String]>,
    ) -> Vec<Obj> {
        let Some(pins) = pins else {
            return Vec::new();
        };
        let out: Mutex<Vec<Obj>> = Mutex::new(vec![Obj::new(); pins.len()]);
        let ctx = &r.ctx;
        let (out_ref, never) = (&out, CancellationToken::new());
        each(&never, OBSERVE_MAX, pins.len(), |i| {
            let p = &pins[i];
            async move {
                let mut e = obj! {
                    "path" => p, "name" => dm_gocompat::filepath::base(p),
                    "isRepo" => false, "reason" => "", "badge" => None::<()>,
                };
                match git.repo_root(ctx, p).await {
                    Err(err) => {
                        e.insert("reason".to_owned(), raw(git_error_code(&err).1));
                    }
                    Ok(root) => {
                        e.insert("isRepo".to_owned(), raw(&true));
                        e.insert("badge".to_owned(), raw(&git_badge(git, p)));
                        e.insert("root".to_owned(), raw(&root));
                    }
                }
                out_ref.lock().unwrap_or_else(|e| e.into_inner())[i] = e;
            }
        })
        .await;
        out.into_inner().unwrap_or_else(|e| e.into_inner())
    }

    /// POST /api/git/repos/pin — 저장소를 재확인한 뒤 그 루트를 핀한다 (FR-GIT-12·62).
    pub(crate) async fn api_git_pin(&self, r: &mut Req) -> Response {
        let Some(git) = self.git.clone() else {
            return crate::reply::git_unavailable();
        };
        let path = match r.decode_body::<PathReq>().await {
            Ok(v) => v.path,
            Err(res) => return res,
        };
        let (a, root) = match self.repo_add_answer(&git, &r.ctx, &path).await {
            Ok(v) => v,
            Err(e) => return git_error(&e),
        };
        if !a.ok {
            let mut body = obj! {"error" => a.why};
            if let Some(args) = &a.args {
                body.insert("args".to_owned(), raw(args));
            }
            return git_err_json(status(a.status), &a.why, &body);
        }
        match self.entries().pin_add(&root) {
            Ok((stored, lists)) => git_json(
                StatusCode::OK,
                &obj! {"root" => stored, "pinned" => lists.pinned, "editors" => lists.editors},
            ),
            Err(e) => git_pin_save_fail(r, &e),
        }
    }

    /// POST /api/git/repos/unpin — 저장된 값과 문자열이 정확히 같은 항목을 지운다.
    pub(crate) async fn api_git_unpin(&self, r: &mut Req) -> Response {
        let path = match decode_path(r).await {
            Ok(p) => p,
            Err(res) => return res,
        };
        match self.entries().pin_remove(&path) {
            Ok(lists) => git_json(
                StatusCode::OK,
                &obj! {"pinned" => lists.pinned, "editors" => lists.editors},
            ),
            Err(e) => git_pin_save_fail(r, &e),
        }
    }

    /// repo 인자를 정규 루트로 옮긴다 (FR-GIT-62). 두 번째 값은 클라이언트가 보낸 그대로다.
    pub(crate) async fn git_repo_param(
        &self,
        r: &Req,
    ) -> Result<(Arc<Store>, String, String), Response> {
        let requested = r.q("repo");
        let root = self.git_resolve_repo(r, &requested).await?;
        let git = self.git.clone().ok_or_else(crate::reply::git_unavailable)?;
        Ok((git, root, requested))
    }

    /// GET /api/git/status?repo=<abs>[&ifMark=<mark>] (FR-GIT-63).
    pub(crate) async fn api_git_status(&self, r: &mut Req) -> Response {
        let requested = r.q("repo");
        let (root, not_repo) = match self.git_resolve_repo_soft(r, &requested).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if not_repo {
            return git_json(StatusCode::OK, &git_status_not_repo_body(&requested));
        }
        let Some(git) = self.git.clone() else {
            return crate::reply::git_unavailable();
        };
        let (obs, cached) = match git.status(&r.ctx, &root).await {
            (Ok(obs), cached) => (obs, cached),
            (Err(e), _) => return git_error(&e),
        };
        // 이 요청이 곧 관심 표명이다 (FR-GPO-10 · FR-GWL-1·9).
        if let Some(w) = &self.watch {
            w.note_for(&root, &obs, &r.q("clientId"));
        }
        let actions = match self.repo_actions(&git, &r.ctx, &root, &obs.status).await {
            Ok(a) => a,
            Err(e) => return git_error(&e),
        };
        let v = StatusView {
            resolved: wsentry::normalize_path(&requested),
            mark: store::mark(&obs),
            root,
            requested,
            actions,
        };
        if git_status_unchanged(&r.q("ifMark"), &v.mark) {
            return git_json(StatusCode::OK, &git_status_unchanged_body(&v));
        }
        git_json(StatusCode::OK, &git_status_body(&v, &obs, cached))
    }

    /// GET /api/git/signature?repo=<abs> — 감지용 경량 시그니처 (FR-GIT-19).
    pub(crate) async fn api_git_signature(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        match git.signature(&r.ctx, &root).await {
            Ok(sig) => git_json(
                StatusCode::OK,
                &obj! {"repo" => root, "requested" => requested, "signature" => sig},
            ),
            Err(e) => git_error(&e),
        }
    }

    /// GET /api/git/diff-content — 한 축의 양쪽 전체 내용 (FR-GIT-44~48).
    pub(crate) async fn api_git_diff_content(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req = DiffRequested {
            repo: requested,
            axis: r.q("axis"),
            path: r.q("path"),
            orig_path: r.q("origPath"),
            oid: r.q("oid"),
            parent_oid: r.q("parentOid"),
        };
        let diffs = self.diff_git(&git);
        let dc = if req.axis == query::AXIS_COMMIT_PARENT {
            query::diff_commit(
                &diffs,
                &r.ctx,
                &root,
                &req.oid,
                &req.parent_oid,
                &req.path,
                &req.orig_path,
            )
            .await
        } else {
            query::diff_content_of(&diffs, &r.ctx, &root, &req.axis, &req.path, &req.orig_path)
                .await
        };
        let mut dc = match dc {
            Ok(dc) => dc,
            Err(e) => return git_error(&e),
        };
        // REPO_FIX 03 §3A-3: 문서의 인코딩을 실으면 쪽마다 디코드한다.
        let enc = r.q("encoding");
        if !enc.is_empty() {
            if !dm_shared_textenc::valid(&enc) {
                return git_fail(
                    StatusCode::BAD_REQUEST,
                    ERR_BAD_REQUEST,
                    &format!("모르는 인코딩: {enc}"),
                );
            }
            dc.decode_as(&enc);
        }
        // M9_SRS FR-M9-20: 그림으로 볼 수 있는가 — 전용 실행기로 판정한다 (D-M9-16).
        if let Some(img) = &self.images {
            dc.image_mime = query::image_mime_of(
                img,
                &r.ctx,
                &root,
                &req.axis,
                &req.path,
                &req.orig_path,
                &req.oid,
                &req.parent_oid,
            )
            .await;
        }
        if !dc.image_mime.is_empty() {
            dc.note = String::new();
        }
        git_json(
            StatusCode::OK,
            &embed(&[("requested", raw(&req))], &raw(&dc)),
        )
    }
}

/// 배지는 관측 캐시만 읽는다 — git status 를 실행하지 않는다 (FR-GIT-24). 이력이 없으면 null.
fn git_badge(git: &Store, root: &str) -> Option<Obj> {
    let obs = git.observed(root)?;
    let mut m = obj! {
        "total" => obs.status.total,
        "branch" => obs.status.branch,
        "detached" => obs.status.detached,
        "observedAtUnixMs" => obs.observed_at_unix_ms,
    };
    // 출력이 잘렸으면 total 은 하한이다 (FR-SAF-21 · FR-WRD-81). 평소에는 열쇠가 없다.
    if obs.status.output_truncated {
        m.insert("outputTruncated".to_owned(), raw(&true));
    }
    Some(m)
}

/// 본문의 path 를 읽는다. 비었으면 400 이다.
async fn decode_path(r: &mut Req) -> Result<String, Response> {
    let path = r.decode_body::<PathReq>().await?.path;
    if path.is_empty() {
        return Err(git_fail(
            StatusCode::BAD_REQUEST,
            ERR_BAD_REQUEST,
            "path 가 없다",
        ));
    }
    Ok(path)
}

/// 본문의 path 를 읽고 절대경로임까지 확인한다 (FR-DRC-11).
pub(crate) async fn decode_abs_path(r: &mut Req) -> Result<String, Response> {
    let path = decode_path(r).await?;
    if !dm_gocompat::filepath::is_abs(&path) {
        return Err(git_fail(
            StatusCode::BAD_REQUEST,
            ERR_BAD_REQUEST,
            "path 는 절대경로여야 한다",
        ));
    }
    Ok(path)
}

/// 핀 목록 저장의 실패다. 원인은 로그로만 보낸다 (FR-QG-5 · D-QG-2).
fn git_pin_save_fail(r: &Req, err: &wsentry::Error) -> Response {
    let path = &r.path;
    dm_shared_dmlog::infof!(r.rid(), "git pin save {path}: {err}");
    git_fail(
        StatusCode::INTERNAL_SERVER_ERROR,
        ERR_FAILED,
        "핀 목록을 저장하지 못했다",
    )
}

/// status 답의 두 갈래가 함께 싣는 값이다.
struct StatusView {
    root: String,
    requested: String,
    resolved: String,
    mark: String,
    actions: BTreeMap<String, Answer>,
}

/// 저장소가 아닌 경로의 답이다 (API_ANSWER_NOT_ABSENCE_SRS FR-ANA-1) — 200 이고 감시하지 않는다.
fn git_status_not_repo_body(requested: &str) -> Obj {
    obj! {
        "repo" => "",
        "requested" => requested,
        "requestedResolved" => wsentry::normalize_path(requested),
        "isRepo" => false,
        "rootMatch" => false,
        "cached" => false,
        "status" => None::<()>,
        "mark" => "",
    }
}

/// 클라이언트가 이미 가진 관측인가다 (FR-OPT-4-7).
fn git_status_unchanged(if_mark: &str, mark: &str) -> bool {
    !if_mark.is_empty() && if_mark == mark
}

fn git_status_unchanged_body(v: &StatusView) -> Obj {
    obj! {
        "repo" => v.root,
        "requested" => v.requested,
        "isRepo" => true,
        "rootMatch" => v.resolved == v.root,
        "requestedResolved" => v.resolved,
        "mark" => v.mark,
        "unchanged" => true,
        "actions" => v.actions,
    }
}

fn git_status_body(v: &StatusView, obs: &Observation, cached: bool) -> Obj {
    obj! {
        "repo" => v.root,
        "requested" => v.requested,
        "isRepo" => true,
        "rootMatch" => v.resolved == v.root,
        "requestedResolved" => v.resolved,
        "cached" => cached,
        "observedAtUnixMs" => obs.observed_at_unix_ms,
        "signature" => obs.signature,
        "status" => obs.status,
        "mark" => v.mark,
        "actions" => v.actions,
        "rowActions" => row_actions(&obs.status),
    }
}

/// 클라이언트가 보낸 값 그대로다 — stale 가드(FR-GIT-54)의 서버측 절반이다.
#[derive(Serialize)]
struct DiffRequested {
    repo: String,
    axis: String,
    path: String,
    #[serde(rename = "origPath")]
    orig_path: String,
    oid: String,
    #[serde(rename = "parentOid")]
    parent_oid: String,
}
