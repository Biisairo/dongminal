//! 파일 종단의 표식 (Go `handlers_files_stamp.go`) — 저장 경합을 가르는 `X-File-Stamp` 와 여러
//! 파일의 표식 조회 (EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-11, EDITOR_LIVE_RELOAD_SRS 묶음 E).
//!
//! 표식은 클라이언트에게 불투명한 문자열이다. 재료는 mtime(나노초)+크기다.

use std::collections::BTreeMap;
use std::fs::Metadata;
use std::time::SystemTime;

use dm_gocompat::json;
use dm_shared_httpreq::{self as httpreq, DecodeError};
use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::httperr::{http_err, read_body_err, write_json};
use crate::req::Req;

pub(crate) const FILE_STAMP_HEADER: &str = "X-File-Stamp";

/// 한 요청이 볼 수 있는 파일 수다 (FR-ELR-6).
pub(crate) const FILE_STAMPS_MAX: usize = 512;

/// Go `time.Time.UnixNano`.
pub(crate) fn unix_nano(t: SystemTime) -> i64 {
    match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_nanos()).unwrap_or(i64::MAX),
        Err(e) => i64::try_from(e.duration().as_nanos()).map_or(i64::MIN, |n| -n),
    }
}

pub(crate) fn mod_nano(fi: &Metadata) -> i64 {
    fi.modified().map(unix_nano).unwrap_or(0)
}

/// Go `fmt.Sprintf("%x", int64)`.
fn hex_i64(n: i64) -> String {
    if n < 0 {
        format!("-{:x}", n.unsigned_abs())
    } else {
        format!("{n:x}")
    }
}

/// Go `fileStamp`.
pub(crate) fn file_stamp(fi: &Metadata) -> String {
    format!(
        "{}-{}",
        hex_i64(mod_nano(fi)),
        hex_i64(i64::try_from(fi.len()).unwrap_or(i64::MAX))
    )
}

/// Go `stampOfPath`: 지금 디스크의 표식이다. 파일이 없거나 디렉터리면 빈 문자열이다 (FR-EXC-10a).
pub(crate) fn stamp_of_path(p: &str) -> String {
    match std::fs::metadata(p) {
        Ok(fi) if !fi.is_dir() => file_stamp(&fi),
        _ => String::new(),
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fileStampsReq")]
struct FileStampsReq {
    paths: Option<Vec<String>>,
}

#[derive(Serialize)]
struct StampsResp {
    stamps: BTreeMap<String, String>,
}

impl Server {
    /// POST /api/file/stamps (FR-ELR-1~7).
    pub(crate) async fn api_file_stamps(&self, r: &mut Req) -> Response {
        let body = match r.read_body(0).await {
            Ok(b) => b,
            Err(e) => return read_body_err(&e),
        };
        let req: FileStampsReq = match json::unmarshal(&body) {
            Ok(v) => v,
            Err(e) => return invalid_json(r, e),
        };
        let paths = req.paths.unwrap_or_default();
        if paths.len() > FILE_STAMPS_MAX {
            return http_err(
                &format!("too many paths (max {FILE_STAMPS_MAX})"),
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
            );
        }
        write_json(&StampsResp {
            stamps: self.file_stamps_in(&paths),
        })
    }

    /// Go `fileStampsIn`: `/api/file/stamps` 와 `/api/fs/stamps` 가 같은 함수를 지난다 (FR-ELR-2).
    /// 통과하지 못한 경로·없는 파일·디렉터리는 빠진다 (FR-ELR-5). 키는 보낸 경로 그대로다 (FR-ELR-3).
    pub(crate) fn file_stamps_in(&self, paths: &[String]) -> BTreeMap<String, String> {
        let mut stamps = BTreeMap::new();
        for p in paths {
            let Ok(target) = self.file_allow(p) else {
                continue;
            };
            let st = stamp_of_path(&target);
            if !st.is_empty() {
                stamps.insert(p.clone(), st);
            }
        }
        stamps
    }
}

/// Go `httpErr(w, httpreq.Message(r, "invalid json", err), 400, CodeInvalidJSON)`.
pub(crate) fn invalid_json(r: &Req, e: json::Error) -> Response {
    let msg = httpreq::message(
        r.rid(),
        r.method.as_str(),
        &r.path,
        "invalid json",
        &DecodeError::NotJson(e),
    );
    http_err(&msg, StatusCode::BAD_REQUEST, apierr::CODE_INVALID_JSON)
}
