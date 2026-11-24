//! git 방언의 응답 (GIT_SRS §3.8 FR-GIT-60~63). 모든 실패는 JSON 본문이며 `X-Error-Code` 를 싣는다.

use std::collections::BTreeMap;
use std::fmt;

use http::StatusCode;
use otter_gocompat::json::{RawMessage, marshal};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_webserver_apierr::{self as apierr, Classify, Sentinel};
use otter_webserver_domain_git_core as core;
use serde::Serialize;

pub(crate) const ERR_BAD_REQUEST: &str = apierr::CODE_BAD_REQUEST;
pub(crate) const ERR_EXISTS: &str = apierr::CODE_EXISTS;
pub(crate) const ERR_UNAVAILABLE: &str = apierr::CODE_UNAVAILABLE;
pub(crate) const ERR_FAILED: &str = apierr::CODE_FAILED;
pub(crate) const ERR_CONFIRM_REQUIRED: &str = apierr::CODE_CONFIRM_REQUIRED;

/// 오류 본문에 실을 메시지 길이 상한이다. git 의 stderr 는 1MiB 까지 보존된다 (FR-GIT-6).
const MESSAGE_MAX: usize = 2048;

/// Go `map[string]any`. 키는 Go 처럼 바이트 순으로 나간다.
pub(crate) type Obj = BTreeMap<String, RawMessage>;

/// 값 하나를 Go 인코딩 그대로 담는다.
pub(crate) fn raw<T: Serialize + ?Sized>(v: &T) -> RawMessage {
    RawMessage(marshal(v).unwrap_or_default())
}

macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = $crate::reply::Obj::new();
        $( m.insert(String::from($k), $crate::reply::raw(&$v)); )*
        m
    }};
}
pub(crate) use obj;

/// Go 의 "필드 몇 개 + 임베드 구조체" 응답이다. 필드 순서를 그대로 지킨다 — 임베드 값은
/// 앞 필드 뒤에 펼친다. 임베드 값은 JSON 객체여야 한다.
pub(crate) fn embed(head: &[(&str, RawMessage)], inner: &RawMessage) -> RawMessage {
    let mut out = Vec::from(&b"{"[..]);
    for (i, (k, v)) in head.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(&marshal(k).unwrap_or_default());
        out.push(b':');
        out.extend_from_slice(if v.0.is_empty() { b"null" } else { &v.0 });
    }
    let body = inner.0.strip_prefix(b"{").unwrap_or(b"}");
    if body != b"}" && !head.is_empty() {
        out.push(b',');
    }
    out.extend_from_slice(body);
    RawMessage(out)
}

pub(crate) fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) fn git_json<T: Serialize + ?Sized>(code: StatusCode, body: &T) -> Response {
    httpresp::json(code, body)
}

/// git 방언 오류 응답의 하나뿐인 문이다 (SAFETY_CORRECTNESS_SRS FR-SAF-10). 본문은 호출자가
/// 만들고 헤더는 여기가 세운다.
pub(crate) fn git_err_json(code: StatusCode, name: &str, body: &Obj) -> Response {
    httpresp::fail_json(code, name, body)
}

pub(crate) fn git_fail(code: StatusCode, name: &str, msg: &str) -> Response {
    git_err_json(code, name, &obj! {"error" => name, "message" => msg})
}

/// git 표면만 닫는다.
pub(crate) fn git_unavailable() -> Response {
    git_fail(
        StatusCode::SERVICE_UNAVAILABLE,
        ERR_UNAVAILABLE,
        "git 서비스가 구성되지 않았다",
    )
}

/// 판정은 `apierr::GIT` 표가 소유한다 (DEEPENING_REFACTOR_SRS FR-DPN-2). 여기 남는 것은 미분류
/// 실패의 기본값 하나다.
pub(crate) fn git_error_code<E: Classify + ?Sized>(err: &E) -> (StatusCode, &'static str) {
    match apierr::GIT.lookup(err) {
        Some((code, name)) => (status(code), name),
        None => (StatusCode::INTERNAL_SERVER_ERROR, ERR_FAILED),
    }
}

pub(crate) fn git_error<E: Classify + fmt::Display + ?Sized>(err: &E) -> Response {
    let (code, name) = git_error_code(err);
    git_fail(code, name, &git_tail(&err.to_string()))
}

/// 뒤쪽을 남긴다 — git 의 실패 이유는 stderr 끝에 있다 (FR-DRC-9).
pub(crate) fn git_tail(msg: &str) -> String {
    otter_shared_diagtail::cut_str(msg, MESSAGE_MAX)
}

/// 이 표면이 다루는 도메인 오류다. 쓰기 실패 응답이 오류의 모양(부분 적용·이름 충돌)을 읽는다.
pub(crate) trait GitErr: Classify + fmt::Display + Send + Sync + 'static {
    /// Go `errors.As(err, &*write.BatchError)` 이고 `Partial()`.
    fn batch_partial(&self) -> bool {
        false
    }
    /// Go `errors.As(err, &*write.BranchExistsError)` 의 이름.
    fn branch_exists(&self) -> Option<&str> {
        None
    }
}

pub(crate) type WErr = Box<dyn GitErr>;

impl<E: GitErr> From<E> for WErr {
    fn from(e: E) -> Self {
        Box::new(e)
    }
}

impl GitErr for core::Error {}
impl GitErr for otter_webserver_domain_git_query::Error {}
impl GitErr for otter_webserver_domain_git_jobs::Error {}
impl GitErr for otter_webserver_domain_wsentry::Error {}
impl GitErr for otter_webserver_domain_worktree::Error {}
impl GitErr for std::io::Error {}
impl GitErr for otter_webserver_domain_git_write::Error {
    fn batch_partial(&self) -> bool {
        self.batch().is_some_and(|b| b.partial())
    }
    fn branch_exists(&self) -> Option<&str> {
        otter_webserver_domain_git_write::Error::branch_exists(self)
    }
}

/// Go 의 맨 sentinel(`core.ErrCanceled` 등). 문구는 sentinel 이름 그대로다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Bare(pub(crate) core::Kind);

impl fmt::Display for Bare {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.as_str())
    }
}

impl Classify for Bare {
    fn is(&self, s: &Sentinel) -> bool {
        *s == Sentinel::Core(self.0)
    }
}

impl GitErr for Bare {}
