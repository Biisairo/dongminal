//! 파일 종단의 경로 가드(`safe_resolve`·`unique_path`)와 실패 형식 (Go `handlers_files.go`).
//! 종단은 주제별 파일에 있다 — 업로드·다운로드·cwd(`files_transfer`)·표식(`files_stamp`)·
//! 읽기·쓰기(`files_rw`).

use http::StatusCode;
use otter_gocompat::filepath;
use otter_shared_httpresp::Response;

use crate::httperr::http_err;

/// Go `uniquePath`: 같은 이름이 있으면 `이름 (n).확장자` 로 비켜 간다 (api.md 의 공개 계약).
pub(crate) fn unique_path(dir: &str, name: &str) -> String {
    let p = filepath::join(&[dir, name]);
    if std::fs::metadata(&p).is_err() {
        return p;
    }
    let ext = filepath::ext(name);
    let base = name.strip_suffix(ext).unwrap_or(name);
    let mut i = 1u64;
    loop {
        let p = filepath::join(&[dir, &format!("{base} ({i}){ext}")]);
        if std::fs::metadata(&p).is_err() {
            return p;
        }
        i += 1;
    }
}

/// Go `safeResolve`: userPath 가 baseDir 아래로 풀리는지 본다. 베이스가 파일시스템 루트면
/// 제한이 없다는 뜻이다 — 전송 종단은 `safe_resolve("/", …)` 로 부른다 (FR-WTP-7).
pub(crate) fn safe_resolve(base_dir: &str, user_path: &str) -> Result<String, String> {
    let mut cleaned = filepath::clean(user_path);
    if !filepath::is_abs(&cleaned) {
        cleaned = filepath::abs(&cleaned).map_err(|e| e.to_string())?;
    }
    if is_filesystem_root(base_dir) {
        return Ok(cleaned);
    }
    let rel = filepath::rel(base_dir, &cleaned)?;
    if rel.starts_with("..") {
        return Err("path escapes base directory".to_owned());
    }
    Ok(cleaned)
}

/// Go `isFilesystemRoot`: POSIX 는 "/", Windows 는 `\` 와 `C:\` 류다.
pub(crate) fn is_filesystem_root(p: &str) -> bool {
    let c = filepath::clean(p);
    let sep = std::path::MAIN_SEPARATOR_STR;
    c == sep || c == filepath::volume_name(&c) + sep
}

/// 전송 종단의 실패 형식이다 (Go `failFn`). 두 표면이 다른 것은 이것뿐이다 — 터미널은
/// text/plain(`textFail`), 탐색기는 JSON 코드(`jsonFail`, FR-EDT-117).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Fail {
    Text,
    Json,
}

impl Fail {
    pub(crate) fn fail(self, status: StatusCode, code: &str, msg: &str) -> Response {
        match self {
            // 본문에 서버 경로를 싣지 않는다 (FR-FTR-3). 코드는 헤더로 간다 (FR-ERR-4).
            Fail::Text => http_err(msg, status, code),
            Fail::Json => otter_shared_httpresp::fail_code(status, code, msg),
        }
    }
}
