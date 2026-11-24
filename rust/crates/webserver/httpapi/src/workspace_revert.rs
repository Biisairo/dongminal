//! 워크스페이스 되돌리기 (Go `handlers_workspace_revert.go`, M5 `G4-7`).
//!
//! 상태 파일마다 세대가 남아 있다. 되돌리기는 그중 하나를 `save` 로 올리는 것이 전부다 — 그러면
//! 직전 판이 세대 사슬의 맨 앞으로 들어가 되돌리기도 되돌릴 수 있다.

use std::path::PathBuf;

use http::StatusCode;
use otter_gocompat::json;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::{self as otterlog, Value};
use otter_shared_platform::STATE_FILE_GENERATIONS;
use otter_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::httperr::{http_err, read_body_err};
use crate::req::Req;
use crate::tools_api::off_thread;

#[derive(Serialize)]
struct RevisionEntry {
    #[serde(rename = "gen")]
    generation: i64,
    bytes: i64,
    modified: String,
}

#[derive(Serialize)]
struct RevisionsBody {
    rev: u64,
    generations: Vec<RevisionEntry>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RevertReq {
    #[serde(rename = "gen")]
    generation: i64,
}

#[derive(Serialize)]
struct RevertBody {
    #[serde(rename = "gen")]
    generation: i64,
    rev: u64,
}

/// `2006-01-02T15:04:05Z` 꼴의 UTC 시각이다.
fn utc_seconds(t: std::time::SystemTime) -> String {
    let t = time::OffsetDateTime::from(t);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

fn gen_path(base: &std::path::Path, gen_: i64) -> PathBuf {
    let mut s = base.as_os_str().to_owned();
    s.push(format!(".bak.{gen_}"));
    PathBuf::from(s)
}

impl Server {
    /// Go `apiWorkspaceRevisions`: 되돌릴 수 있는 자리를 보인다. 읽히는지까지는 묻지 않는다 —
    /// 깨진 세대의 거절은 되돌리는 순간에 일어난다.
    pub(crate) async fn api_workspace_revisions(&self, _r: &mut Req) -> Response {
        let mut out = RevisionsBody {
            rev: self.work().map_or(0, |w| w.current_rev()),
            generations: Vec::new(),
        };
        let path = self.workspace_path();
        for i in 1..=STATE_FILE_GENERATIONS as i64 {
            let Ok(st) = std::fs::metadata(gen_path(&path, i)) else {
                continue;
            };
            out.generations.push(RevisionEntry {
                generation: i,
                bytes: i64::try_from(st.len()).unwrap_or(i64::MAX),
                modified: st.modified().map(utc_seconds).unwrap_or_default(),
            });
        }
        httpresp::json(StatusCode::OK, &out)
    }

    /// Go `apiWorkspaceRevert`: 세대 하나를 현재로 올린다.
    pub(crate) async fn api_workspace_revert(&self, r: &mut Req) -> Response {
        let Some(work) = self.deps.work.clone() else {
            return http_err(
                "workspace unavailable",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_WORK_UNREADY,
            );
        };
        let body = match r.read_body(0).await {
            Ok(b) => b,
            Err(e) => return read_body_err(&e),
        };
        let Ok(req) = json::unmarshal::<RevertReq>(&body) else {
            return http_err(
                "invalid json",
                StatusCode::BAD_REQUEST,
                apierr::CODE_INVALID_JSON,
            );
        };
        // 파일을 만지기 전에 범위를 본다 — 번호로 경로를 짓게 하지 않는다.
        if req.generation < 1 || req.generation > STATE_FILE_GENERATIONS as i64 {
            return http_err(
                &format!("gen must be 1..{STATE_FILE_GENERATIONS}"),
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
            );
        }
        let Ok(blob) = std::fs::read(gen_path(&self.workspace_path(), req.generation)) else {
            return http_err(
                "generation not found",
                StatusCode::NOT_FOUND,
                apierr::CODE_NOT_FOUND,
            );
        };
        // 깨진 세대를 올리지 않는다 — 되돌리기가 빈 판을 만들면 그것이 `FE-2` 다.
        if !json::valid(&blob) {
            return http_err(
                "generation is not valid JSON",
                StatusCode::CONFLICT,
                apierr::CODE_CONFLICT,
            );
        }
        // `ifMatch` 를 비우는 것은 의도다 — 되돌리기는 지금 판을 버리는 것이다.
        let rev = match off_thread(move || work.save(&blob, "")).await {
            Some(Ok(rev)) => rev,
            _ => {
                return http_err("revert failed", StatusCode::CONFLICT, apierr::CODE_CONFLICT);
            }
        };
        otterlog::info(
            r.rid(),
            "workspace reverted",
            &[
                ("gen", Value::from(req.generation)),
                ("rev", Value::from(rev)),
            ],
        );
        httpresp::json(
            StatusCode::OK,
            &RevertBody {
                generation: req.generation,
                rev,
            },
        )
    }

    /// Go `workspacePath`: `data_dir` 이 비면 작업 디렉터리다.
    fn workspace_path(&self) -> PathBuf {
        if self.cfg.data_dir.as_os_str().is_empty() {
            return PathBuf::from(otter_shared_otterenv::WORKSPACE_FILE);
        }
        self.cfg
            .data_dir
            .join(otter_shared_otterenv::WORKSPACE_FILE)
    }
}
