//! `POST /api/fs/ignored` — 탐색기의 한 겹에서 무시된 이름을 가른다 (Go `handlers_fs_ignored.go`,
//! EXPLORER_TRANSFER_IGNORE_SRS 묶음 A, FR-ETR-1~4).
//!
//! 파일 이름은 git core 의 정적 게이트(FR-GXU-12)가 인가를 건너뛰는 실행의 호출처로 허용한
//! 자리다 — 바꾸지 않는다.

use std::time::Duration;

use http::StatusCode;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::{self as core, Ctx, Kind, UnguardedSpec, exec_unguarded};
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::fs::{
    FS_ERR_BAD_REQUEST, FS_ERR_IO, FsError, fs_decode, fs_fail, fs_fail_err, fs_resolve_existing,
};
use crate::req::Req;

/// "이 경로로는 무시 여부를 물을 수 없다" 는 답이다 (FR-ETR-4).
pub(crate) const FS_ERR_NOT_REPO: &str = apierr::CODE_FS_NOT_REPO;

/// 판정 하나에 허용하는 시간이다.
pub(crate) const CHECK_IGNORE_TIMEOUT: Duration = Duration::from_secs(10);

/// `check-ignore` 는 1 을 "무시된 것 없음" 으로 쓴다 — 실패가 아니다 (FR-ETR-3).
const CHECK_IGNORE_FOUND: i32 = 0;
const CHECK_IGNORE_NONE: i32 = 1;

/// 실행 기록에 남는 사유다 (GIT_EXEC_UNIFY_SRS FR-GXU-1).
const UNGUARDED_REASON_CHECK_IGNORE: &str =
    "탐색기 무시 판정 — check-ignore 는 읽기 허용 목록에 없다 (FR-ETR-2)";

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsIgnoredReq")]
struct FsIgnoredReq {
    root: String,
    dir: String,
    names: Option<Vec<String>>,
}

#[derive(Serialize)]
struct IgnoredOnly {
    ignored: Vec<String>,
}

#[derive(Serialize)]
struct IgnoredResp {
    ignored: Vec<String>,
    #[serde(rename = "isRepo")]
    is_repo: bool,
}

/// Go `checkIgnore`: `git -C <dir> check-ignore -z --stdin` 한 번으로 겹 전체를 판정한다
/// (FR-ETR-2). `--no-index` 를 주지 않는다(D-3). 이름은 stdin 으로 간다.
pub(crate) async fn check_ignore(
    svc: Option<&core::Service>,
    ctx: &Ctx,
    dir: &str,
    names: &[String],
) -> Result<Vec<String>, FsError> {
    let mut stdin = String::new();
    for n in names {
        stdin.push_str(n);
        stdin.push('\0');
    }
    let spec = UnguardedSpec {
        argv: vec!["check-ignore".into(), "-z".into(), "--stdin".into()],
        stdin,
        timeout: CHECK_IGNORE_TIMEOUT,
        reason: UNGUARDED_REASON_CHECK_IGNORE.into(),
    };
    let res = exec_unguarded(svc, ctx, dir, &spec).await;
    let exit = match &res {
        Ok(out) => out.exit_code,
        Err(e) if e.is(Kind::GitMissing) => {
            return Err(FsError::new(FS_ERR_NOT_REPO, "git 을 찾을 수 없다"));
        }
        Err(e) if e.is(Kind::Timeout) || e.is(Kind::Canceled) => {
            return Err(FsError::new(
                FS_ERR_IO,
                "check-ignore 가 시간 안에 끝나지 않았다",
            ));
        }
        Err(e) => e.output().map_or(-1, |o| o.exit_code),
    };
    match (exit, res) {
        (CHECK_IGNORE_FOUND, Ok(out)) => Ok(split_nul(&out.stdout)),
        (CHECK_IGNORE_NONE, _) => Ok(Vec::new()),
        // 128 은 저장소가 아니거나 그 밖의 치명적 실패다. stderr 에 서버의 절대경로가 실리므로
        // 사유를 싣지 않는다.
        _ => Err(FsError::new(
            FS_ERR_NOT_REPO,
            "저장소가 아니거나 무시 여부를 물을 수 없다",
        )),
    }
}

/// Go `splitNUL`: 빈 조각을 버린다.
fn split_nul(s: &[u8]) -> Vec<String> {
    s.split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .map(crate::ansi::go_string)
        .collect()
}

impl Server {
    /// POST /api/fs/ignored.
    pub(crate) async fn api_fs_ignored(&self, r: &mut Req) -> Response {
        let req: FsIgnoredReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let root = match self.fs_root(&req.root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let dir = match fs_resolve_existing(&root, &req.dir) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        let names = req.names.unwrap_or_default();
        // FR-ETR-1: 받는 것은 **한 겹의 이름**이지 경로가 아니다.
        if names
            .iter()
            .any(|n| n.is_empty() || n == "." || n == ".." || n.contains(['/', '\\']))
        {
            return fs_fail(FS_ERR_BAD_REQUEST, "names 는 한 겹의 이름이어야 한다");
        }
        if names.is_empty() {
            return httpresp::json(
                StatusCode::OK,
                &IgnoredOnly {
                    ignored: Vec::new(),
                },
            );
        }
        let ctx = Ctx::from_token(r.ctx.clone());
        match check_ignore(self.deps.git_service.as_deref(), &ctx, &dir, &names).await {
            Ok(ignored) => httpresp::json(
                StatusCode::OK,
                &IgnoredResp {
                    ignored,
                    is_repo: true,
                },
            ),
            // API_ANSWER_NOT_ABSENCE_SRS FR-ANA-2: 판정할 수 없다는 것도 답이다.
            Err(e) if e.code == FS_ERR_NOT_REPO => httpresp::json(
                StatusCode::OK,
                &IgnoredResp {
                    ignored: Vec::new(),
                    is_repo: false,
                },
            ),
            Err(e) => fs_fail_err(&e),
        }
    }
}
