//! `/api/fs/*`·`/api/editors/*` 의 공용 방언·루트 가드와 `GET /api/fs/list` (Go `handlers_fs.go`,
//! EDITOR_TAB_SRS §3.11 FR-EDT-108~119). 나머지 탐색기 종단은 `fs_*` 모듈에 있다.

use std::fmt::Display;

use dm_gocompat::filepath;
use dm_shared_dmlog::infof;
use dm_shared_httpreq::{self as httpreq, DecodeError, Empty};
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr::{self as apierr, Classify};
use dm_webserver_domain_wsentry::normalize_path;
use http::StatusCode;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::Server;
use crate::ansi::go_string;
use crate::fs_stamp::fs_stamp_of;
use crate::httperr::mark;
use crate::req::Req;

pub(crate) const FS_ERR_BAD_REQUEST: &str = apierr::CODE_BAD_REQUEST;
pub(crate) const FS_ERR_NOT_FOUND: &str = apierr::CODE_NOT_FOUND;
pub(crate) const FS_ERR_EXISTS: &str = apierr::CODE_EXISTS;
pub(crate) const FS_ERR_OUTSIDE_ROOT: &str = apierr::CODE_OUTSIDE_ROOT;
pub(crate) const FS_ERR_PERMISSION: &str = apierr::CODE_PERMISSION;
pub(crate) const FS_ERR_IO: &str = apierr::CODE_IO;
/// 전송에만 있는 코드다 (FR-FTR-5).
pub(crate) const FS_ERR_TOO_LARGE: &str = apierr::CODE_TOO_LARGE;

/// 코드와 사유를 묶는다 (Go `fsError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FsError {
    pub(crate) code: &'static str,
    pub(crate) msg: String,
}

impl FsError {
    pub(crate) fn new(code: &'static str, msg: &str) -> FsError {
        FsError {
            code,
            msg: msg.to_owned(),
        }
    }
}

/// Go `fsStatus`: 표는 `apierr::fs_status` 가 소유한다 (FR-DPN-6).
pub(crate) fn fs_status(code: &str) -> StatusCode {
    StatusCode::from_u16(apierr::fs_status(code)).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// Go `fsFail`: 탐색기 방언의 오류 하나다(`{code,message}`). 코드가 헤더로도 나간다 (FR-ERR-7).
pub(crate) fn fs_fail(code: &str, msg: &str) -> Response {
    httpresp::fail_code(fs_status(code), code, msg)
}

/// Go `fsFailBody`: 본문을 호출자가 만드는 실패다 (F-e).
pub(crate) fn fs_fail_body<T: Serialize + ?Sized>(code: &str, body: &T) -> Response {
    httpresp::fail_json(fs_status(code), code, body)
}

/// Go `fsFailErr`.
pub(crate) fn fs_fail_err(e: &FsError) -> Response {
    fs_fail(e.code, &e.msg)
}

/// 분류되지 않는 아래 계층의 실패다 (Go `fsFailErr` 의 `fsError` 가 아닌 갈래).
pub(crate) fn fs_other(err: &dyn Display) -> FsError {
    infof!(None, "fs 오류 {FS_ERR_IO}: {err}");
    FsError::new(FS_ERR_IO, fs_os_msg(FS_ERR_IO))
}

/// Go `fsFromOS`: 시스템 콜의 실패를 코드로 옮긴다. 판정은 `apierr::FS` 가 소유한다.
pub(crate) fn fs_from_os<E: Classify + Display + ?Sized>(err: &E) -> FsError {
    let code = apierr::FS.lookup(err).map_or(FS_ERR_IO, |(_, c)| c);
    fs_cause(code, err)
}

/// [`fs_from_os`] 의 `io::Error` 판. 로그의 문구를 Go 의 os 오류와 맞춘다.
pub(crate) fn fs_from_io(err: &std::io::Error) -> FsError {
    // Go `fs.ErrExist` 는 ENOTEMPTY 도 받는다 (syscall `Errno.Is`).
    let code = if err.kind() == std::io::ErrorKind::DirectoryNotEmpty {
        FS_ERR_EXISTS
    } else {
        apierr::FS.lookup(err).map_or(FS_ERR_IO, |(_, c)| c)
    };
    fs_cause(code, &dm_gocompat::oserr::go_error_string(err))
}

/// Go `fsCause`: 아래 계층의 오류를 코드의 문구로 바꾸고 전문을 로그로 보낸다.
pub(crate) fn fs_cause(code: &'static str, err: &(impl Display + ?Sized)) -> FsError {
    infof!(None, "fs 오류 {code}: {err}");
    FsError::new(code, fs_os_msg(code))
}

/// Go `fsOSMsg`.
pub(crate) fn fs_os_msg(code: &str) -> &'static str {
    match code {
        FS_ERR_NOT_FOUND => "경로를 찾을 수 없다",
        FS_ERR_EXISTS => "이미 있다",
        FS_ERR_PERMISSION => "권한이 없다",
        FS_ERR_BAD_REQUEST => "잘못된 경로다",
        _ => "파일 작업에 실패했다",
    }
}

/// Go `fsDecode`.
pub(crate) async fn fs_decode<T: DeserializeOwned + Send + 'static>(
    r: &Req,
) -> Result<T, Response> {
    match r.decode_json::<T>(0, Empty::NotJson).await {
        Ok(v) => Ok(v),
        Err(err) => {
            let (code, prefix) = match &err {
                DecodeError::Read(e) => (apierr::body_read_code(e), "본문을 읽지 못했다"),
                DecodeError::NotJson(_) => (FS_ERR_BAD_REQUEST, "본문이 JSON 이 아니다"),
            };
            let msg = httpreq::message(r.rid(), r.method.as_str(), &r.path, prefix, &err);
            let res = fs_fail(code, &msg);
            Err(match &err {
                DecodeError::Read(e) => mark(e, res),
                DecodeError::NotJson(_) => res,
            })
        }
    }
}

impl Server {
    /// Go `fsRoot`: 클라이언트가 보낸 root 를 대조한 뒤에만 기준으로 쓴다 (FR-EDT-113).
    pub(crate) fn fs_root(&self, raw: &str) -> Result<String, Response> {
        self.fs_root_of(raw).map_err(|e| fs_fail_err(&e))
    }

    /// Go `fsRootOf`: `fs_root` 의 판정만이다.
    pub(crate) fn fs_root_of(&self, raw: &str) -> Result<String, FsError> {
        if raw.is_empty() {
            return Err(FsError::new(FS_ERR_BAD_REQUEST, "root 가 없다"));
        }
        if !filepath::is_abs(raw) {
            return Err(FsError::new(
                FS_ERR_BAD_REQUEST,
                "root 는 절대경로여야 한다",
            ));
        }
        let roots = self.entries.roots().map_err(|e| fs_other(&e))?;
        let norm = normalize_path(raw);
        // roots 는 정규화된 목록이다 (FR-OPT-8-2).
        if roots.contains(&norm) {
            return Ok(norm);
        }
        Err(FsError::new(
            FS_ERR_OUTSIDE_ROOT,
            "root 가 Editor 목록에 없다",
        ))
    }
}

/// Go `fsResolveExisting`: 실재하는 경로를 전부 풀어 루트 아래인지 본다.
pub(crate) fn fs_resolve_existing(root: &str, p: &str) -> Result<String, FsError> {
    if !filepath::is_abs(p) {
        return Err(FsError::new(
            FS_ERR_BAD_REQUEST,
            "path 는 절대경로여야 한다",
        ));
    }
    let resolved = filepath::eval_symlinks(&filepath::clean(p)).map_err(|e| fs_resolve_err(&e))?;
    fs_under_root(root, &resolved)
}

/// Go `fsResolveTarget`: 이름을 가리키는 경로를 푼다 — 부모만 풀고 마지막 조각은 그대로 붙인다.
/// 링크 자체를 지우거나 옮길 수 있고, 중간 디렉터리 링크로 루트를 벗어나는 경우는 걸린다 (FR-EDT-112).
pub(crate) fn fs_resolve_target(root: &str, p: &str) -> Result<String, FsError> {
    if !filepath::is_abs(p) {
        return Err(FsError::new(
            FS_ERR_BAD_REQUEST,
            "path 는 절대경로여야 한다",
        ));
    }
    let cleaned = filepath::clean(p);
    let parent =
        filepath::eval_symlinks(&filepath::dir(&cleaned)).map_err(|e| fs_resolve_err(&e))?;
    fs_under_root(root, &filepath::join(&[parent, filepath::base(&cleaned)]))
}

/// Go `fsOK`.
pub(crate) fn fs_ok() -> Response {
    httpresp::json(StatusCode::OK, &serde_json::json!({"ok": true}))
}

impl Server {
    /// Go `fsRootTarget`: root 를 먼저 확정한 뒤에만 경로를 푼다 (FR-DRC-11).
    pub(crate) fn fs_root_target(
        &self,
        req_root: &str,
        req_path: &str,
    ) -> Result<(String, String), Response> {
        let root = self.fs_root(req_root)?;
        let target = fs_target_in(&root, req_path)?;
        Ok((root, target))
    }
}

/// Go `fsTargetIn`: 이미 확정된 root 아래의 또 다른 경로다.
pub(crate) fn fs_target_in(root: &str, p: &str) -> Result<String, Response> {
    fs_resolve_target(root, p).map_err(|e| fs_fail_err(&e))
}

/// Go `fsResolveErr`: 권한과 부재를 가른다 (FR-EDT-117).
pub(crate) fn fs_resolve_err(err: &std::io::Error) -> FsError {
    let msg = dm_gocompat::oserr::go_error_string(err);
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return fs_cause(FS_ERR_PERMISSION, &msg);
    }
    fs_cause(FS_ERR_NOT_FOUND, &msg)
}

/// Go `fsUnderRoot`: 경계는 경로 조각으로 판정한다 — `..b` 같은 정상 이름을 거부하지 않는다.
pub(crate) fn fs_under_root(root: &str, resolved: &str) -> Result<String, FsError> {
    let outside = || FsError::new(FS_ERR_OUTSIDE_ROOT, "루트 밖의 경로다");
    let rel = filepath::rel(root, resolved).map_err(|_| outside())?;
    let sep = std::path::MAIN_SEPARATOR;
    if rel == ".." || rel.starts_with(&format!("..{sep}")) {
        return Err(outside());
    }
    Ok(resolved.to_owned())
}

/// 탐색기 행 하나다 (Go `fsEntry`, FR-EDT-108). `dir` 은 링크를 따라가지 않은 값이다 (FR-EDT-60).
#[derive(Serialize, Clone, Debug)]
pub(crate) struct FsEntry {
    pub(crate) name: String,
    pub(crate) dir: bool,
    pub(crate) link: bool,
    #[serde(rename = "linkDir")]
    pub(crate) link_dir: bool,
}

/// Go `strings.ToLower`: 글자마다 하나의 글자로 옮긴다.
fn go_lower(s: &str) -> String {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

#[cfg(unix)]
fn name_bytes(n: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    n.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn name_bytes(n: &std::ffi::OsStr) -> Vec<u8> {
    n.to_string_lossy().into_owned().into_bytes()
}

/// Go `fsListDir`: 한 겹만 읽는다 (FR-EDT-59). 폴더 먼저, 그 다음 이름 오름차순(대소문자 무시)이다
/// (FR-EDT-61). `offset` 이 넘어서면 빈 쪽이다 (FR-FSP-1~4).
pub(crate) fn fs_list_dir(
    dir: &str,
    offset: usize,
    max: usize,
) -> Result<(Vec<FsEntry>, usize, bool), FsError> {
    let rd = std::fs::read_dir(dir).map_err(|e| fs_from_io(&e))?;
    let mut out: Vec<(Vec<u8>, String, FsEntry)> = Vec::new();
    for de in rd {
        let de = de.map_err(|e| fs_from_io(&e))?;
        let raw = name_bytes(&de.file_name());
        let ft = de.file_type().ok();
        let link = ft.is_some_and(|t| t.is_symlink());
        let mut e = FsEntry {
            name: go_string(&raw),
            dir: ft.is_some_and(|t| t.is_dir()),
            link,
            link_dir: false,
        };
        if link && let Ok(st) = std::fs::metadata(de.path()) {
            e.link_dir = st.is_dir();
        }
        let lower = go_lower(&e.name);
        out.push((raw, lower, e));
    }
    out.sort_by(|a, b| {
        b.2.dir
            .cmp(&a.2.dir)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.0.cmp(&b.0))
    });
    let total = out.len();
    if offset >= total {
        return Ok((Vec::new(), total, false));
    }
    let mut entries: Vec<FsEntry> = out.into_iter().skip(offset).map(|(_, _, e)| e).collect();
    let truncated = entries.len() > max;
    entries.truncate(max);
    Ok((entries, total, truncated))
}

#[derive(Serialize)]
struct ListResp {
    entries: Vec<FsEntry>,
    offset: usize,
    path: String,
    stamp: String,
    total: usize,
    truncated: bool,
}

impl Server {
    /// GET /api/fs/list?root=<abs>&path=<abs>[&offset=n] (FR-EDT-108, FR-FSP-1·2, FR-FSL-10).
    pub(crate) async fn api_fs_list(&self, r: &mut Req) -> Response {
        let root = match self.fs_root(&r.q("root")) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let p = r.q("path");
        if p.is_empty() {
            return fs_fail(FS_ERR_BAD_REQUEST, "path 가 없다");
        }
        let target = match fs_resolve_existing(&root, &p) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        let st = match std::fs::metadata(&target) {
            Ok(st) => st,
            Err(e) => return fs_fail_err(&fs_from_io(&e)),
        };
        if !st.is_dir() {
            return fs_fail(FS_ERR_BAD_REQUEST, "디렉터리가 아니다");
        }
        // FR-FSP-1: 음수·정수 아님은 0 으로 떨어진다.
        let offset = r
            .q("offset")
            .parse::<i64>()
            .ok()
            .filter(|v| *v > 0)
            .map_or(0, |v| usize::try_from(v).unwrap_or(usize::MAX));
        let max = self.limits.fs_list;
        let dir = target.clone();
        let listed = match tokio::task::spawn_blocking(move || fs_list_dir(&dir, offset, max)).await
        {
            Ok(v) => v,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        };
        let (entries, total, truncated) = match listed {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        httpresp::json(
            StatusCode::OK,
            &ListResp {
                entries,
                offset,
                path: target,
                stamp: fs_stamp_of(&st),
                total,
                truncated,
            },
        )
    }
}
