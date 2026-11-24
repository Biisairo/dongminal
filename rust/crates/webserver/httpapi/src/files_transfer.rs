//! 파일 종단의 업로드·다운로드와 그 기준 경로(cwd) (Go `handlers_files_transfer.go`,
//! FILE_TRANSFER_SRS). 경로 가드는 `files` 에 있다.

use std::collections::BTreeMap;
use std::io::Write;

use futures_util::TryStreamExt;
use http::{HeaderValue, StatusCode, header};
use http_body_util::{BodyExt, StreamBody};
use otter_gocompat::filepath;
use otter_shared_httpreq::{ReadError, mark_response};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use serde::Serialize;

use crate::Server;
use crate::files::{Fail, safe_resolve, unique_path};
use crate::fs::{
    FS_ERR_BAD_REQUEST, FS_ERR_EXISTS, FS_ERR_IO, FS_ERR_NOT_FOUND, FS_ERR_PERMISSION,
    FS_ERR_TOO_LARGE, FsError, fs_status,
};
use crate::fs_transfer::fs_upload_target;
use crate::httperr::{http_err, write_json};
use crate::multipart::{Form, FormError, Spool, read_form};
use crate::req::Req;

/// `/api/cwd` 의 `source` 두 값.
pub(crate) const CWD_SOURCE_TOOL: &str = "tool";
pub(crate) const CWD_SOURCE_SERVER: &str = "server";

/// 업로드가 놓일 자리를 정한다 — 터미널은 자동 개명하고 탐색기는 거부한다 (FR-FTR-16, D-3).
pub(crate) type Pick<'a> = &'a (dyn Fn(&str, &str, &Form) -> Result<String, FsError> + Sync);

#[derive(Serialize)]
struct UploadResp {
    name: String,
    path: String,
    size: u64,
}

#[derive(Serialize)]
struct CwdResp {
    actions: BTreeMap<&'static str, Answer>,
    cwd: String,
    source: &'static str,
}

impl Server {
    /// Go `uploadInto`: multipart 의 `file` 하나를 dir 에 받는다. 두 표면이 공유한다 (FR-FTR-4).
    /// 성공이면 놓인 경로와 바이트 수다.
    pub(crate) async fn upload_into(
        &self,
        r: &Req,
        dir: &str,
        pick: Pick<'_>,
        fail: Fail,
    ) -> Result<(String, u64), Response> {
        // 상한은 폼을 읽는 동안 선다 — 넘는 본문을 디스크에 떨어뜨리기 전에 멈춘다 (FR-FTR-5).
        let form = match read_form(r, self.limits.upload_max_bytes).await {
            Ok(f) => f,
            Err(FormError::TooLarge) => {
                let mut res = fail.fail(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    FS_ERR_TOO_LARGE,
                    "upload too large",
                );
                mark_response(&ReadError::TooLarge, &mut res);
                return Err(res);
            }
            Err(FormError::Bad) => {
                return Err(fail.fail(
                    StatusCode::BAD_REQUEST,
                    FS_ERR_BAD_REQUEST,
                    "no file in request",
                ));
            }
        };
        // FR-FTR-6: 대상은 실재하는 디렉터리여야 한다. 만들지 않는다.
        if !std::fs::metadata(dir).is_ok_and(|st| st.is_dir()) {
            return Err(fail.fail(
                StatusCode::BAD_REQUEST,
                FS_ERR_BAD_REQUEST,
                "upload directory not found",
            ));
        }
        let name = filepath::base(&form.file.filename);
        let out_path =
            pick(dir, &name, &form).map_err(|e| fail.fail(fs_status(e.code), e.code, &e.msg))?;
        let data = form.file.data;
        let p = out_path.clone();
        let res = tokio::task::spawn_blocking(move || place(&p, data, fail)).await;
        match res {
            Ok(Ok(n)) => Ok((out_path, n)),
            Ok(Err(res)) => Err(res),
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }

    /// POST /api/upload?dir=…[&tool=…] — 터미널 표면이다. `(1)`·`(2)` 자동 개명은 공개 계약이다.
    pub(crate) async fn api_upload(&self, r: &mut Req) -> Response {
        let mut dir = r.q("dir");
        // X-c: `tool` 이 있으면 그 순간의 도구 cwd 로 받는다 — `dir` 은 보지 않는다.
        let tool_id = r.q("tool");
        if !tool_id.is_empty() {
            let (cwd, source) = self.tool_cwd(&tool_id).await;
            let a = term_upload_answer(&cwd, source);
            if !a.ok {
                return http_err(&a.why, status_of(a.status), &a.why);
            }
            dir = cwd;
        }
        if dir.is_empty() {
            dir = ".".to_owned();
        }
        // 베이스 "/" 는 "어디든" 이다 — 정규화와 절대화가 목적이다.
        let Ok(safe_dir) = safe_resolve("/", &dir) else {
            return http_err("forbidden", StatusCode::FORBIDDEN, apierr::CODE_FORBIDDEN);
        };
        let pick = |d: &str, n: &str, form: &Form| -> Result<String, FsError> {
            // FR-TFD-30: `relPath` 가 있으면 탐색기와 같은 함수가 자리를 정한다. 경계는 `d` 자신이다.
            let rel = form.value("relPath");
            if rel.is_empty() {
                return Ok(unique_path(d, n));
            }
            let target = fs_upload_target(d, d, &rel, n)?;
            // 자동 개명은 마지막 조각에만 건다 (FR-ETR-19·20).
            Ok(unique_path(
                &filepath::dir(&target),
                &filepath::base(&target),
            ))
        };
        match self.upload_into(r, &safe_dir, &pick, Fail::Text).await {
            Ok((out, size)) => write_json(&UploadResp {
                name: filepath::base(&out),
                path: out,
                size,
            }),
            Err(res) => res,
        }
    }

    /// GET /api/download?path=… — 터미널 표면이다.
    pub(crate) async fn api_download(&self, r: &mut Req) -> Response {
        let mut fp = r.q("path");
        if fp.is_empty() {
            return http_err(
                "missing path",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        }
        if !filepath::is_abs(&fp) {
            match filepath::abs(&fp) {
                Ok(a) => fp = a,
                Err(_) => {
                    return http_err(
                        "invalid path",
                        StatusCode::BAD_REQUEST,
                        apierr::CODE_BAD_REQUEST,
                    );
                }
            }
        }
        serve_download(&fp, Fail::Text).await
    }

    /// GET /api/cwd[?tool=…] — 근거와 드롭 업로드의 답을 함께 싣는다 (FR-FTR-7, X-c).
    pub(crate) async fn api_cwd(&self, r: &mut Req) -> Response {
        let (cwd, source) = self.tool_cwd(&r.q("tool")).await;
        let answer = term_upload_answer(&cwd, source);
        write_json(&CwdResp {
            actions: BTreeMap::from([(action::TERM_UPLOAD, answer)]),
            cwd,
            source,
        })
    }

    /// Go `toolCwd`: 그 도구의 cwd 와 근거다. 모르면 서버 프로세스의 cwd 로 폴백한다 (D-4).
    pub(crate) async fn tool_cwd(&self, tool_id: &str) -> (String, &'static str) {
        let mut cwd = String::new();
        if !tool_id.is_empty()
            && let Some(hub) = self.deps.tools.clone()
        {
            let id = tool_id.to_owned();
            cwd = tokio::task::spawn_blocking(move || hub.cwd(&id))
                .await
                .unwrap_or_default();
        }
        if cwd.is_empty() {
            return (getwd(), CWD_SOURCE_SERVER);
        }
        (cwd, CWD_SOURCE_TOOL)
    }
}

fn status_of(s: u16) -> StatusCode {
    StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// Go `termUploadAnswer`: 도구의 것이 아닌 cwd 에는 놓지 않는다 (FR-FTR-11).
pub(crate) fn term_upload_answer(cwd: &str, source: &str) -> Answer {
    if source != CWD_SOURCE_TOOL || cwd.is_empty() {
        return action::deny(409, apierr::CODE_UPLOAD_NO_TOOL_CWD, None);
    }
    action::allow()
}

/// Go `os.Getwd`: `$PWD` 가 지금 디렉터리를 가리키면 그것을 쓴다.
fn getwd() -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(pwd) = std::env::var("PWD")
            && pwd.starts_with('/')
            && let (Ok(a), Ok(b)) = (std::fs::metadata(&pwd), std::fs::metadata("."))
            && a.dev() == b.dev()
            && a.ino() == b.ino()
        {
            return pwd;
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 받은 파일을 이름을 원자적으로 잡아(O_EXCL) 놓는다.
fn place(out_path: &str, data: Spool, fail: Fail) -> Result<u64, Response> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o644);
    }
    let mut out = match opts.open(out_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(fail.fail(
                StatusCode::CONFLICT,
                FS_ERR_EXISTS,
                "대상에 같은 이름이 이미 있다",
            ));
        }
        Err(_) => {
            return Err(fail.fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                FS_ERR_IO,
                "cannot create file",
            ));
        }
    };
    let written = match &data {
        Spool::Mem(b) => out.write_all(b).map(|_| b.len() as u64),
        Spool::Disk(t) => {
            std::fs::File::open(&t.0).and_then(|mut f| std::io::copy(&mut f, &mut out))
        }
    };
    match written {
        Ok(n) => Ok(n),
        Err(_) => {
            drop(out);
            // 반쯤 받은 파일을 남기지 않는다.
            let _ = std::fs::remove_file(out_path);
            Err(fail.fail(StatusCode::INTERNAL_SERVER_ERROR, FS_ERR_IO, "write failed"))
        }
    }
}

/// Go `attachmentDisposition`: 이름을 두 벌로 싣는다 (FR-FTR-1).
pub(crate) fn attachment_disposition(name: &str) -> String {
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        ascii_fallback_name(name),
        rfc5987_escape(name)
    )
}

/// Go `asciiFallbackName`: 바꾸는 단위는 글자다.
fn ascii_fallback_name(name: &str) -> String {
    let out: String = name
        .chars()
        .map(|r| {
            if (r as u32) < 0x20 || (r as u32) > 0x7e || r == '"' || r == '\\' {
                '_'
            } else {
                r
            }
        })
        .collect();
    if out.trim().is_empty() {
        return "download".to_owned();
    }
    out
}

/// Go `rfc5987Escape`: RFC 5987 §3.2 의 attr-char 만 남긴다.
fn rfc5987_escape(name: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut b = String::with_capacity(name.len());
    for &c in name.as_bytes() {
        if c.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&c) {
            b.push(c as char);
        } else {
            b.push('%');
            b.push(HEX[usize::from(c >> 4)] as char);
            b.push(HEX[usize::from(c & 0x0f)] as char);
        }
    }
    b
}

/// Go `serveDownload`: 파일 하나를 첨부로 흘려보낸다. 헤더를 쓰기 전에 판정을 끝낸다 (§2.1).
pub(crate) async fn serve_download(fp: &str, fail: Fail) -> Response {
    let st = match tokio::fs::metadata(fp).await {
        Ok(st) => st,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return fail.fail(StatusCode::FORBIDDEN, FS_ERR_PERMISSION, "cannot read file");
        }
        Err(_) => return fail.fail(StatusCode::NOT_FOUND, FS_ERR_NOT_FOUND, "not found"),
    };
    if st.is_dir() {
        return fail.fail(StatusCode::BAD_REQUEST, FS_ERR_BAD_REQUEST, "not a file");
    }
    let Ok(f) = tokio::fs::File::open(fp).await else {
        return fail.fail(StatusCode::FORBIDDEN, FS_ERR_PERMISSION, "cannot read file");
    };
    let name = filepath::base(fp);
    let log_name = name.clone();
    let stream = tokio_util::io::ReaderStream::new(f)
        .map_ok(hyper::body::Frame::data)
        .map_err(move |e| {
            // 헤더는 이미 나갔다 — 남길 수 있는 것은 로그뿐이다.
            infof!(
                None,
                "download {log_name}: {}",
                otter_gocompat::oserr::go_error_string(&e)
            );
            Box::new(e) as httpresp::BoxError
        });
    let mut res = http::Response::new(StreamBody::new(stream).boxed());
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&attachment_disposition(&name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(st.len()));
    res
}
