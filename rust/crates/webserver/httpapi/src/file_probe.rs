//! `/api/file/{probe,raw}` (Go `handlers_file_probe.go`, EDITOR_GIT_UX_SRS 묶음 V) — 편집기가
//! "이 파일을 열 수 있는가" 를 묻는 자리다.

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};

use dm_shared_editorlimit::BINARY_SNIFF_BYTES;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_shared_mimeprobe as mimeprobe;
use dm_webserver_apierr as apierr;
use http::{HeaderValue, StatusCode, header};
use serde::Serialize;

use crate::Server;
use crate::files_rw::{Opened, open_stat, too_large};
use crate::httperr::{http_err, write_json};
use crate::req::Req;

const FILE_KIND_TEXT: &str = "text";
const FILE_KIND_IMAGE: &str = "image";
const FILE_KIND_BINARY: &str = "binary";

/// `http.DetectContentType` 이 보는 만큼.
const SNIFF_LEN: usize = 512;

#[derive(Serialize)]
struct ProbeResp {
    kind: &'static str,
    #[serde(rename = "maxBytes")]
    max_bytes: i64,
    mime: &'static str,
    size: u64,
}

/// Go `probeFile`: 내용이 우선이다 (FR-EVW-2). SVG 는 텍스트로 남는다 (FR-DRV-14).
fn probe_file(f: &mut File) -> std::io::Result<(&'static str, &'static str, Vec<u8>)> {
    let mut head = Vec::with_capacity(BINARY_SNIFF_BYTES);
    f.by_ref()
        .take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut head)?;
    let mime = mimeprobe::detect_content_type(&head[..head.len().min(SNIFF_LEN)]);
    let kind = if mime.starts_with("image/") {
        FILE_KIND_IMAGE
    } else if is_binary(&head) {
        FILE_KIND_BINARY
    } else {
        FILE_KIND_TEXT
    };
    Ok((kind, mime, head))
}

/// Go `isBinary`: 앞 `BINARY_SNIFF_BYTES` 바이트에 NUL 이 있으면 이진이다 (FR-EGS-5). UTF-16
/// BOM 이면 NUL 이 있어도 텍스트다 (§3A-1). 편집기(probe)와 검색이 같이 쓴다 (FR-RDG-9).
pub(crate) fn is_binary(head: &[u8]) -> bool {
    let head = &head[..head.len().min(BINARY_SNIFF_BYTES)];
    if dm_shared_textenc::has_utf16_bom(head) {
        return false;
    }
    head.contains(&0)
}

fn cannot_read() -> Response {
    http_err(
        "cannot read file",
        StatusCode::FORBIDDEN,
        apierr::CODE_PERMISSION,
    )
}

/// Go `openRegularFile`: 절대경로의 일반 파일을 연다 (FR-FAB-11).
fn open_regular_file(fp: &str) -> Result<(File, Metadata), Response> {
    match open_stat(fp) {
        Opened::File(f, m) => Ok((f, m)),
        Opened::NotFound => Err(http_err(
            "file not found",
            StatusCode::NOT_FOUND,
            apierr::CODE_NOT_FOUND,
        )),
        Opened::NotAFile | Opened::StatFailed(_) => Err(http_err(
            "not a file",
            StatusCode::BAD_REQUEST,
            apierr::CODE_NOT_A_FILE,
        )),
    }
}

async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    match tokio::task::spawn_blocking(f).await {
        Ok(res) => res,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

impl Server {
    /// GET /api/file/probe?path=<abs> — {kind, mime, size, maxBytes} (FR-EVW-1, FR-FAB-9).
    pub(crate) async fn api_file_probe(&self, r: &mut Req) -> Response {
        let fp = match self.file_guard(&r.q("path")) {
            Ok(p) => p,
            Err(res) => return res,
        };
        let max = self.limits.file_read_max;
        blocking(move || {
            let (mut f, st) = match open_regular_file(&fp) {
                Ok(v) => v,
                Err(res) => return res,
            };
            let Ok((kind, mime, _)) = probe_file(&mut f) else {
                return cannot_read();
            };
            write_json(&ProbeResp {
                kind,
                max_bytes: max,
                mime,
                size: st.len(),
            })
        })
        .await
    }

    /// GET /api/file/raw?path=<abs> — 이미지(와 잠금장치를 단 SVG)만 인라인으로 (FR-EVW-5·6,
    /// FR-DRV-24).
    pub(crate) async fn api_file_raw(&self, r: &mut Req) -> Response {
        let fp = match self.file_guard(&r.q("path")) {
            Ok(p) => p,
            Err(res) => return res,
        };
        let max = self.limits.file_read_max;
        blocking(move || file_raw(&fp, max)).await
    }
}

fn file_raw(fp: &str, max: i64) -> Response {
    let (mut f, st) = match open_regular_file(fp) {
        Ok(v) => v,
        Err(res) => return res,
    };
    // FR-FAB-8: 크기 판정이 종류 판정보다 앞이다.
    let size = i64::try_from(st.len()).unwrap_or(i64::MAX);
    if size > max {
        return too_large(size, max);
    }
    let Ok((kind, mime, head)) = probe_file(&mut f) else {
        return cannot_read();
    };
    let svg = kind == FILE_KIND_TEXT && mimeprobe::looks_like_svg(&head);
    if kind != FILE_KIND_IMAGE && !svg {
        return http_err(
            "not an image",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            apierr::CODE_NOT_AN_IMAGE,
        );
    }
    if f.seek(SeekFrom::Start(0)).is_err() {
        return cannot_read();
    }
    let mut body = Vec::new();
    // 본문은 Content-Length 만큼이다.
    let _ = f.take(st.len()).read_to_end(&mut body);
    let mut res = http::Response::new(httpresp::full(body));
    let h = res.headers_mut();
    let mime = if svg { mimeprobe::SVG_MIME } else { mime };
    if svg {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox"),
        );
    }
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(st.len()));
    res
}
