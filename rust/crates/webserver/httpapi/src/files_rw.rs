//! 파일 종단의 읽기·쓰기 (Go `handlers_files_rw.go`, `/api/file/{read,write}`) 와 그 동작 답.

use std::collections::BTreeMap;
use std::fs::{File, Metadata};
use std::io::Read;
use std::path::Path;

use bytes::Bytes;
use dm_gocompat::{filepath, json};
use dm_shared_dmlog::{errorf, infof};
use dm_shared_httpresp::{self as httpresp, Response};
use dm_shared_textenc::{self as textenc, Decoded, Encoded, Unmappable};
use dm_webserver_action::{self as action, Answer};
use dm_webserver_apierr as apierr;
use dm_webserver_domain_lsp::{FileEvent, WATCH_CHANGED, WATCH_CREATED};
use http::{HeaderValue, StatusCode, header};
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::files_stamp::{FILE_STAMP_HEADER, file_stamp, invalid_json, stamp_of_path};
use crate::httperr::{http_err, read_body_err, write_json};
use crate::req::Req;

/// 읽기 응답이 문서의 동작 답을 싣는 헤더다 (SERVER_DRIVEN_ACTIONS_SRS X-e).
pub(crate) const FILE_ACTIONS_HEADER: &str = "X-File-Actions";

const TEXT_PLAIN: &str = "text/plain; charset=utf-8";

/// Go `fileWriteReq`.
#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fileWriteReq")]
struct FileWriteReq {
    path: String,
    content: String,
    encoding: String,
    bom: bool,
    stamp: String,
    #[serde(rename = "convertFrom")]
    convert_from: String,
}

#[derive(Serialize)]
struct WriteOk {
    actions: BTreeMap<&'static str, Answer>,
    ok: bool,
    stamp: String,
}

#[derive(Serialize)]
struct UnmappableBody<'a> {
    char: &'a str,
    col: usize,
    error: &'static str,
    line: usize,
}

/// 413 too_large 의 평문이다 (FR-FAB-8). 실제 크기를 싣는다.
pub(crate) fn too_large(size: i64, max: i64) -> Response {
    http_err(
        &format!("file too large: {size} bytes (max {max})"),
        StatusCode::PAYLOAD_TOO_LARGE,
        apierr::CODE_TOO_LARGE,
    )
}

fn size_of(fi: &Metadata) -> i64 {
    i64::try_from(fi.len()).unwrap_or(i64::MAX)
}

/// 헤더 값으로 쓸 수 없는 바이트가 있으면 그 헤더를 싣지 않는다.
fn set(res: &mut Response, name: &'static str, v: &str) {
    if let Ok(v) = HeaderValue::from_str(v) {
        res.headers_mut().insert(name, v);
    }
}

fn text_response(body: impl Into<Bytes>) -> Response {
    let mut res = http::Response::new(httpresp::full(body));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(TEXT_PLAIN));
    res
}

/// Go `os.Open` 의 실패 갈래. Windows 의 `os.Open` 은 디렉터리도 열므로 디렉터리면 "열렸다" 로 본다.
pub(crate) enum Opened {
    File(File, Metadata),
    NotFound,
    NotAFile,
    StatFailed(std::io::Error),
}

pub(crate) fn open_stat(fp: &str) -> Opened {
    let f = match File::open(fp) {
        Ok(f) => f,
        Err(_) => {
            return match std::fs::metadata(fp) {
                Ok(m) if m.is_dir() => Opened::NotAFile,
                _ => Opened::NotFound,
            };
        }
    };
    match f.metadata() {
        Ok(m) if m.is_dir() => Opened::NotAFile,
        Ok(m) => Opened::File(f, m),
        Err(e) => Opened::StatFailed(e),
    }
}

fn file_not_found() -> Response {
    http_err(
        "file not found",
        StatusCode::NOT_FOUND,
        apierr::CODE_NOT_FOUND,
    )
}

fn not_a_file() -> Response {
    http_err(
        "not a file",
        StatusCode::BAD_REQUEST,
        apierr::CODE_NOT_A_FILE,
    )
}

async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    match tokio::task::spawn_blocking(f).await {
        Ok(res) => res,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

impl Server {
    /// GET /api/file/read (FR-CAPI-11, FR-FAB-8·11, FR-EXC-11).
    pub(crate) async fn api_file_read(&self, r: &mut Req) -> Response {
        let fp = match self.file_guard(&r.q("path")) {
            Ok(p) => p,
            Err(res) => return res,
        };
        let max = self.limits.file_read_max;
        let decode = r.q("decode") == "1";
        let want = r.q("encoding");
        blocking(move || file_read(&fp, max, decode, &want)).await
    }

    /// POST /api/file/write (FR-FAB-1, FR-EXC-5·7·11, §3A-2·4).
    pub(crate) async fn api_file_write(&self, r: &mut Req) -> Response {
        let (req, target) = match self.parse_file_write(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        // 표식 검사부터 새 표식까지 같은 경로는 한 번에 하나다 (FR-RD3-20).
        let _g = self.fs.writes.lock(&target).await;
        let max = self.limits.file_read_max;
        let t = target.clone();
        let (res, existed) = match tokio::task::spawn_blocking(move || {
            if let Err(res) = admit_file_write(&req, &t) {
                return (res, None);
            }
            commit_file_write(&req, &t, max)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        };
        if let (Some(existed), Some(lsp)) = (existed, &self.deps.lsp) {
            // FR-CMR-110: 그 경로가 루트 아래인 통로에 알린다.
            lsp.notify_files(vec![FileEvent {
                path: target,
                typ: lsp_watch_type(existed),
            }]);
        }
        res
    }

    async fn parse_file_write(&self, r: &Req) -> Result<(FileWriteReq, String), Response> {
        // FR-OPT-15-2: 파일 상한을 JSON 문자열로 실은 최악의 크기다.
        let limit = dm_shared_editorlimit::body_max_bytes(self.limits.file_read_max);
        let body = r.read_body(limit).await.map_err(|e| read_body_err(&e))?;
        let req: FileWriteReq = json::unmarshal(&body).map_err(|e| invalid_json(r, e))?;
        let target = self.file_guard(&req.path)?;
        // §3A-4: 심링크는 따라가 대상에 쓴다 — 링크는 그대로 남는다.
        let target = write_target(&target);
        if !req.encoding.is_empty() && !textenc::valid(&req.encoding) {
            return Err(http_err(
                &format!("unknown encoding: {}", req.encoding),
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
            ));
        }
        Ok((req, target))
    }
}

fn file_read(fp: &str, max: i64, decode: bool, want: &str) -> Response {
    let (f, stat) = match open_stat(fp) {
        Opened::File(f, m) => (f, m),
        Opened::NotFound => return file_not_found(),
        Opened::NotAFile => return not_a_file(),
        Opened::StatFailed(e) => {
            errorf!(
                None,
                "file stat error: {}",
                dm_gocompat::oserr::go_error_string(&e)
            );
            return http_err(
                "stat failed",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_IO,
            );
        }
    };
    if size_of(&stat) > max {
        return too_large(size_of(&stat), max);
    }
    let mut raw = Vec::new();
    // 판정 뒤에도 상한을 지난다 — Stat 과 읽기 사이에 파일이 자랄 수 있다.
    let read = f
        .take(u64::try_from(max).unwrap_or(0))
        .read_to_end(&mut raw);
    if decode {
        if let Err(e) = read {
            errorf!(
                None,
                "file read error: {}",
                dm_gocompat::oserr::go_error_string(&e)
            );
            return http_err(
                "read failed",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_IO,
            );
        }
        return file_read_decoded(&raw, &stat, want);
    }
    if let Err(e) = read {
        // 헤더는 이미 나간 것으로 본다(Go 는 복사 중의 실패를 기록만 한다).
        infof!(
            None,
            "file read: copy {fp}: {}",
            dm_gocompat::oserr::go_error_string(&e)
        );
    }
    let mut res = text_response(raw);
    set(&mut res, FILE_STAMP_HEADER, &file_stamp(&stat));
    res
}

/// Go `fileReadDecoded` (§3A-1). `encoding=` 이 있으면 그것으로 엄격 디코드한다.
fn file_read_decoded(raw: &[u8], stat: &Metadata, want: &str) -> Response {
    let d: Decoded = if want.is_empty() {
        textenc::detect(raw)
    } else {
        match textenc::decode_as(raw, want) {
            Some(d) => d,
            None => {
                return http_err(
                    &format!("cannot decode as {want}"),
                    StatusCode::UNPROCESSABLE_ENTITY,
                    apierr::CODE_ENCODING_UNDECODABLE,
                );
            }
        }
    };
    let mut res = text_response(d.text.clone());
    set(&mut res, FILE_STAMP_HEADER, &file_stamp(stat));
    set(&mut res, "X-File-Encoding", d.enc);
    set(&mut res, "X-File-BOM", bool_flag(d.bom));
    set(&mut res, "X-File-Decodable", bool_flag(d.decodable));
    set(
        &mut res,
        FILE_ACTIONS_HEADER,
        &file_actions_json(raw, d.enc),
    );
    res
}

/// Go `admitFileWrite`: 디스크의 지금 상태로 저장을 받을지 본다. 경로 잠금 안에서 부른다.
fn admit_file_write(req: &FileWriteReq, target: &str) -> Result<(), Response> {
    // FR-EXC-5·7: 우리가 읽은 뒤 디스크가 바뀌었으면 덮지 않는다.
    if !req.stamp.is_empty() && stamp_conflict(&req.stamp, &stamp_of_path(target)) {
        return Err(http_err(
            "file changed on disk",
            StatusCode::CONFLICT,
            apierr::CODE_FILE_CHANGED,
        ));
    }
    // X-e: 변환은 디스크의 바이트로 판정한다. 읽지 못하면 판정하지 않는다.
    if !req.convert_from.is_empty()
        && let Ok(raw) = std::fs::read(target)
    {
        let a = convert_utf8_answer(&raw, &req.convert_from);
        if !a.ok {
            return Err(http_err(&a.why, status_of(a.status), &a.why));
        }
    }
    Ok(())
}

fn status_of(s: u16) -> StatusCode {
    StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// Go `stampConflict`: 파일이 없을 때(cur 가 빔)는 경합이 아니다 (FR-EXC-10a).
pub(crate) fn stamp_conflict(want: &str, cur: &str) -> bool {
    !cur.is_empty() && cur != want
}

/// Go `commitFileWrite`: 인코딩·상한을 지나 원자적으로 쓰고 새 표식으로 답한다. 쓴 경우에만
/// 둘째 값이 그 전에 파일이 있었는가다.
fn commit_file_write(req: &FileWriteReq, target: &str, max: i64) -> (Response, Option<bool>) {
    let (data, perm) = match file_write_bytes(target, req) {
        Err(e) => {
            return (
                http_err(
                    &format!("encode failed: {e}"),
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_BAD_REQUEST,
                ),
                None,
            );
        }
        Ok(WriteBytes::Unmappable(un)) => {
            // §3A-2: 조용한 손실 금지 — 첫 위치를 싣고 아무것도 쓰지 않는다.
            return (unmappable(&un), None);
        }
        Ok(WriteBytes::Data(data, perm)) => (data, perm),
    };
    let len = i64::try_from(data.len()).unwrap_or(i64::MAX);
    if len > max {
        return (too_large(len, max), None);
    }
    let existed = std::fs::metadata(target).is_ok();
    // 원자적으로 쓴다 (FR-CAF-11). 잘리는 것은 사용자가 쓰던 원본이다.
    if let Err(e) = dm_shared_platform::write_file_atomic(Path::new(target), &data, perm) {
        errorf!(
            None,
            "file write error: {}",
            dm_gocompat::oserr::go_error_string(&e)
        );
        return (
            http_err(
                "write failed",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_IO,
            ),
            None,
        );
    }
    // FR-EXC-11: 새 표식을 함께 준다. X-e: 방금 쓴 바이트의 답을 함께 준다.
    let res = write_json(&WriteOk {
        actions: file_actions(&data, &req.encoding),
        ok: true,
        stamp: stamp_of_path(target),
    });
    (res, Some(existed))
}

fn unmappable(un: &Unmappable) -> Response {
    httpresp::fail_json(
        StatusCode::UNPROCESSABLE_ENTITY,
        apierr::CODE_ENCODING_UNMAPPABLE,
        &UnmappableBody {
            char: &un.ch,
            col: un.col,
            error: apierr::CODE_ENCODING_UNMAPPABLE,
            line: un.line,
        },
    )
}

/// Go `lspWatchType` (FR-CMR-110).
pub(crate) fn lsp_watch_type(existed: bool) -> i64 {
    if existed {
        WATCH_CHANGED
    } else {
        WATCH_CREATED
    }
}

/// Go `convertUTF8Answer` (X-e · D-SDA-10): 디스크 바이트를 문서를 연 인코딩으로 엄격 디코드한다.
pub(crate) fn convert_utf8_answer(raw: &[u8], from: &str) -> Answer {
    let Some(d) = textenc::decode_as(raw, from) else {
        return action::deny(422, apierr::CODE_ENCODING_UNDECODABLE, None);
    };
    if d.enc == textenc::UTF8 && !d.bom {
        return action::deny(409, apierr::CODE_ALREADY_UTF8, None);
    }
    action::allow()
}

/// Go `fileActions`: 문서 하나의 동작 답이다.
fn file_actions(raw: &[u8], enc: &str) -> BTreeMap<&'static str, Answer> {
    let enc = if enc.is_empty() { textenc::UTF8 } else { enc };
    BTreeMap::from([(action::FILE_CONVERT_UTF8, convert_utf8_answer(raw, enc))])
}

fn file_actions_json(raw: &[u8], enc: &str) -> String {
    let b = json::marshal(&file_actions(raw, enc)).unwrap_or_default();
    String::from_utf8(b).unwrap_or_default()
}

fn bool_flag(b: bool) -> &'static str {
    if b { "1" } else { "0" }
}

/// Go `writeTarget` (§3A-4): 심링크면 대상 파일, 끊어진 링크면 링크가 가리키는 경로(상대면 링크
/// 디렉터리 기준)다.
pub(crate) fn write_target(p: &str) -> String {
    if let Ok(real) = filepath::eval_symlinks(p) {
        return real;
    }
    match std::fs::symlink_metadata(p) {
        Ok(fi) if fi.file_type().is_symlink() => {}
        _ => return p.to_owned(),
    }
    let Ok(dest) = std::fs::read_link(p) else {
        return p.to_owned();
    };
    let mut dest = dest.to_string_lossy().into_owned();
    if !filepath::is_abs(&dest) {
        dest = filepath::join(&[filepath::dir(p).as_str(), &dest]);
    }
    filepath::clean(&dest)
}

enum WriteBytes {
    Data(Vec<u8>, u32),
    Unmappable(Unmappable),
}

/// Go `Mode().Perm()`.
fn perm_of(fi: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fi.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if fi.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

/// Go `fileWriteBytes`: 기존 파일은 권한 비트를 보존하고 문서의 인코딩으로 되돌려 쓴다. 새
/// 파일은 0644·UTF-8·BOM 없음이다.
fn file_write_bytes(target: &str, req: &FileWriteReq) -> Result<WriteBytes, textenc::EncodeError> {
    let Ok(st) = std::fs::metadata(target) else {
        return Ok(WriteBytes::Data(req.content.clone().into_bytes(), 0o644));
    };
    let perm = perm_of(&st);
    if req.encoding.is_empty() {
        return Ok(WriteBytes::Data(req.content.clone().into_bytes(), perm));
    }
    Ok(
        match textenc::encode(&req.content, &req.encoding, req.bom)? {
            Encoded::Bytes(b) => WriteBytes::Data(b, perm),
            Encoded::Unmappable(u) => WriteBytes::Unmappable(u),
        },
    )
}
