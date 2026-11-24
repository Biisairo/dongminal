//! GET /api/git/actions — 서버가 주는 동작의 답 (SERVER_DRIVEN_ACTIONS_SRS). Go
//! `handlers_git_actions.go` 의 `apiGitActions`·`gitTargetActions`·`gitRepoAddAnswer` 와
//! `handlers_git_actions_input.go` 의 입력 답.
//!
//! 실행 종단의 거절과 같은 함수를 부른다 (D-SDA-6).

use std::collections::BTreeMap;

use http::StatusCode;
use otter_gocompat::neturl::Values;
use otter_shared_httpresp::Response;
use otter_webserver_action::{self as action, Answer, allow, deny};
use otter_webserver_apierr::{self as apierr, Classify, Sentinel};
use otter_webserver_domain_git_core::{Ctx, Kind};
use otter_webserver_domain_git_jobs::SLOT_INDEX;
use otter_webserver_domain_git_query::{self as query, Status};
use otter_webserver_domain_git_write as write;

use crate::GitServer;
use crate::answers::{
    blank, commit_message_answer, commit_state_answer, err_answer, slots_answer,
    stash_create_answer, upstream_answer,
};
use crate::commit_ops::commit_op_answer;
use crate::reply::{WErr, git_error, git_fail, git_json, git_unavailable, obj};
use crate::req::Req;
use crate::worktree::git_worktrees_unavailable;
use crate::write_ops::git_amend_unchanged;

const COMMIT_IDS: [&str; 4] = [
    action::GIT_COMMIT_CHERRY_PICK,
    action::GIT_COMMIT_REVERT,
    action::GIT_COMMIT_RESET,
    action::GIT_COMMIT_DROP,
];

/// Compare with 의 판정이다 (GV-c).
fn compare_answer(rev: &str, path: &str) -> Answer {
    if blank(rev) {
        return deny(400, apierr::CODE_EMPTY_REV, None);
    }
    if blank(path) {
        return deny(400, apierr::CODE_EMPTY_PATH, None);
    }
    allow()
}

fn one(id: &str, a: Answer) -> BTreeMap<String, Answer> {
    BTreeMap::from([(id.to_owned(), a)])
}

impl GitServer {
    /// GET /api/git/actions?repo=&action=… | ?repo=&kind=… — 동작 하나(또는 대상 하나의 메뉴)의 답.
    pub(crate) async fn api_git_actions(&self, r: &mut Req) -> Response {
        let id = r.q("action");
        // 저장소 추가는 저장소가 아닌 자리에서 묻는다 — repo 를 받지 않는다 (GV-c).
        if id == action::GIT_REPO_ADD {
            return self.git_repo_add_answer(r, &r.q("path")).await;
        }
        if id == action::GIT_WORKTREE_CREATE && self.user_worktrees.is_none() {
            return git_worktrees_unavailable();
        }
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let kind = r.q("kind");
        if !kind.is_empty() {
            return self.git_target_actions(r, &root, &requested, &kind).await;
        }
        let answered = |a: Answer| {
            git_json(
                StatusCode::OK,
                &obj! {
                    "requested" => obj! {"repo" => requested, "action" => id},
                    "repo" => root,
                    "actions" => one(&id, a),
                },
            )
        };
        if let Some(res) = self.git_input_answer(&r.ctx, &root, &id, &r.query).await {
            return match res {
                Ok(a) => answered(a),
                Err(e) => git_error(&*e),
            };
        }
        if id != action::GIT_STASH_CREATE && id != action::GIT_COMMIT {
            return git_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                &format!("unknown action: {id}"),
            );
        }
        // 실행 종단이 판정에 쓰는 것과 같은 관측이다.
        let st = match git.status(&r.ctx, &root).await.0 {
            Ok(obs) => obs.status,
            Err(e) => return git_error(&e),
        };
        let keys = match self.git_keys(&git, &r.ctx, &root).await {
            Ok(k) => k,
            Err(e) => return git_error(&e),
        };
        // 칸이 먼저다 — 실행 종단도 잠금을 쥔 뒤에 상태를 판정한다 (GR-2a).
        let slot = slots_answer(&self.exclusion(), &keys, &[SLOT_INDEX]);
        let a = if id == action::GIT_STASH_CREATE {
            action::first([
                slot,
                stash_create_answer(&st, r.q("includeUntracked") == "1"),
            ])
        } else {
            let message = r.q("message");
            let (amend, all, signoff) = (
                r.q("amend") == "1",
                r.q("all") == "1",
                r.q("signoff") == "1",
            );
            let a = action::first([commit_message_answer(&message), slot]);
            if !a.ok {
                a
            } else {
                let pf = match query::preflight_of(git.service(), &r.ctx, &root).await {
                    Ok(pf) => pf,
                    Err(e) => return git_error(&e),
                };
                commit_state_answer(&st, &pf, all, amend, || {
                    git_amend_unchanged(git.service(), &r.ctx, &root, &message, signoff)
                })
                .await
            }
        };
        answered(a)
    }

    /// `kind=` 의 답 — 대상 하나의 메뉴 전부다 (GT-c·GT-d).
    async fn git_target_actions(
        &self,
        r: &Req,
        root: &str,
        requested: &str,
        kind: &str,
    ) -> Response {
        if kind == "branch" {
            return self.git_branch_menu(r, root, requested).await;
        }
        if kind != "commit" {
            return git_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
                &format!("unknown kind: {kind}"),
            );
        }
        let Some(git) = self.git.clone() else {
            return git_unavailable();
        };
        let oid = r.q("oid");
        let c = match self.git_commit_facts(&r.ctx, root, &oid).await {
            Ok(c) => c,
            Err(res) => return res,
        };
        let st = match git.status(&r.ctx, root).await.0 {
            Ok(obs) => obs.status,
            Err(e) => return git_error(&e),
        };
        let keys = match self.git_keys(&git, &r.ctx, root).await {
            Ok(k) => k,
            Err(e) => return git_error(&e),
        };
        let slot = slots_answer(&self.exclusion(), &keys, &[SLOT_INDEX]);
        let out: BTreeMap<String, Answer> = COMMIT_IDS
            .iter()
            .map(|id| {
                let a = action::first([slot.clone(), commit_op_answer(id, &st, &c)]);
                ((*id).to_owned(), a)
            })
            .collect();
        git_json(
            StatusCode::OK,
            &obj! {
                "requested" => obj! {"repo" => requested, "kind" => kind, "oid" => oid},
                "repo" => root,
                "actions" => out,
            },
        )
    }

    /// 저장소 추가의 답이다 (GV-c · G-B7).
    async fn git_repo_add_answer(&self, r: &Req, path: &str) -> Response {
        let Some(git) = self.git.clone() else {
            return git_unavailable();
        };
        match self.repo_add_answer(&git, &r.ctx, path).await {
            Ok((a, _)) => git_json(
                StatusCode::OK,
                &obj! {
                    "requested" => obj! {"action" => action::GIT_REPO_ADD, "path" => path},
                    "actions" => one(action::GIT_REPO_ADD, a),
                },
            ),
            Err(e) => git_error(&e),
        }
    }

    /// 대화상자 입력의 답이다 (GV-*). `None` 이면 입력 동작이 아니다.
    async fn git_input_answer(
        &self,
        ctx: &Ctx,
        root: &str,
        id: &str,
        q: &Values,
    ) -> Option<Result<Answer, WErr>> {
        let git = self.git.clone()?;
        let get = |k: &str| q.get_or_empty(k);
        Some(match id {
            action::GIT_TAG_CREATE => Ok(err_answer(
                write::check_tag_message(&get("tagKind"), &get("message"))
                    .err()
                    .as_ref(),
            )),
            action::GIT_BRANCH_UPSTREAM_SET => self
                .branch_facts(&git, ctx, root, Status::default())
                .await
                .map(|f| upstream_answer(&f, &get("branch"), &get("upstream")))
                .map_err(WErr::from),
            action::GIT_STASH_BRANCH => self
                .stash_branch_answer(&git, ctx, root, &get("name"))
                .await
                .map_err(WErr::from),
            action::GIT_WORKTREE_CREATE => {
                self.worktree_create_answer(
                    ctx,
                    root,
                    &get("name"),
                    &get("ref"),
                    get("newBranch") == "1",
                )
                .await
            }
            action::GIT_REMOTE_ADD => self
                .remote_add_answer(&git, ctx, root, &get("name"), &get("url"))
                .await
                .map_err(WErr::from),
            action::GIT_COMPARE => Ok(compare_answer(&get("rev"), &get("path"))),
            _ => return None,
        })
    }

    /// stash 에서 브랜치 만들기의 판정이다 (GV-c). 이름 규칙 전체는 git 에 묻는다 (FR-GIT-159).
    pub(crate) async fn stash_branch_answer(
        &self,
        git: &std::sync::Arc<otter_webserver_domain_git_store::Store>,
        ctx: &Ctx,
        root: &str,
        name: &str,
    ) -> Result<Answer, query::Error> {
        if blank(name) {
            return Ok(deny(400, apierr::CODE_EMPTY_NAME, None));
        }
        if let Err(e) = query::valid_branch_name(git.service(), ctx, root, name).await {
            if !Classify::is(&e, &Sentinel::Core(Kind::RefName)) {
                return Err(e);
            }
            return Ok(err_answer(Some(&e)));
        }
        if query::local_branch_exists(git.service(), ctx, root, name).await? {
            return Ok(deny(
                409,
                apierr::CODE_BRANCH_EXISTS,
                Some(BTreeMap::from([("branch".to_owned(), name.into())])),
            ));
        }
        Ok(allow())
    }
}
