//! Go 기준선 `dongminal/internal/shared/dmlog` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 이 제품의 로그가 지나는 한 자리다 (OBSERVABILITY_SRS 묶음 L·R). 줄의 바이트는
//! Go `log/slog` 의 출력과 같다.
//!
//! - `init` 을 부른 프로세스: slog `TextHandler` 형식
//!   (`time=… level=INFO msg=… reqId=… k=v`).
//! - `init` 을 부르지 않은 프로세스(헬퍼): slog 기본 핸들러 형식
//!   (`2006/01/02 15:04:05 INFO msg k=v`), stderr, `info` 이상.

mod format;

use std::io::Write;
use std::sync::Mutex;

/// 요청 ID 를 주고받는 헤더.
pub const REQ_ID_HEADER: &str = "X-Request-Id";

/// 받아들일 요청 ID 의 최대 길이.
const REQ_ID_MAX: usize = 64;

/// 로그 수준. 순서가 하한 비교에 쓰인다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    /// Go `slog.Level.String()`.
    fn go_name(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// Go 의 `context.Context` 자리다. 요청 ID 가 있으면 `Some`.
pub type ReqCtx<'a> = Option<&'a str>;

/// `init` 의 입력.
#[derive(Default)]
pub struct Options {
    /// `debug`·`info`·`warn`·`error`. 알 수 없는 값은 `info` 다 (FR-OBS-2).
    pub level: String,
    /// 비면 stderr 다.
    pub out: Option<Box<dyn Write + Send>>,
}

struct Logger {
    min: Level,
    name: &'static str,
    out: Box<dyn Write + Send>,
}

static LOGGER: Mutex<Option<Logger>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Logger>> {
    LOGGER.lock().unwrap_or_else(|e| e.into_inner())
}

fn parse_level(s: &str) -> (Level, &'static str) {
    match s.trim().to_lowercase().as_str() {
        "debug" => (Level::Debug, "debug"),
        "warn" | "warning" => (Level::Warn, "warn"),
        "error" => (Level::Error, "error"),
        // 빈 값도 알 수 없는 값도 "정하지 않았다" 이다.
        _ => (Level::Info, "info"),
    }
}

/// 로그 계층을 세운다. 기동에서 부른다.
pub fn init(o: Options) {
    let (min, name) = parse_level(&o.level);
    let out = o.out.unwrap_or_else(|| Box::new(std::io::stderr()));
    *lock() = Some(Logger { min, name, out });
}

/// 검사가 쓰는 되돌리기. Go 와 같이 `init(Options::default())` 다.
pub fn reset() {
    init(Options::default());
}

/// 지금 하한의 이름. `config show` 와 진단이 읽는다.
pub fn level() -> &'static str {
    lock().as_ref().map_or("info", |l| l.name)
}

/// 밖에서 온 요청 ID 를 받아들일지 판정한다 (FR-OBS-7). 빈 문자열이 거절이다.
pub fn sanitize_req_id(s: &str) -> &str {
    let ok = !s.is_empty()
        && s.len() <= REQ_ID_MAX
        && s.bytes()
            .all(|c| c == b'-' || c == b'_' || c.is_ascii_alphanumeric());
    if ok { s } else { "" }
}

/// 새 요청 ID. 9바이트 난수의 base64(RawURL)이며 12자다.
pub fn new_req_id() -> String {
    use base64::Engine;
    let mut b = [0u8; 9];
    rand::fill(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// 키-값 호출의 값. 서식은 slog `TextHandler` 규칙을 따른다.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    Int(i64),
    Uint(u64),
    Bool(bool),
}

impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::Str(v.to_owned())
    }
}
impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::Str(v)
    }
}
impl From<i64> for Value {
    fn from(v: i64) -> Self {
        Value::Int(v)
    }
}
impl From<i32> for Value {
    fn from(v: i32) -> Self {
        Value::Int(v.into())
    }
}
impl From<u64> for Value {
    fn from(v: u64) -> Self {
        Value::Uint(v)
    }
}
impl From<u32> for Value {
    fn from(v: u32) -> Self {
        Value::Uint(v.into())
    }
}
impl From<usize> for Value {
    fn from(v: usize) -> Self {
        Value::Uint(v as u64)
    }
}
impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Bool(v)
    }
}

/// 한 줄을 낸다. 요청 ID 가 비었으면 그 필드를 싣지 않는다.
pub fn log(level: Level, ctx: ReqCtx<'_>, msg: &str, attrs: &[(&str, Value)]) {
    let req_id = ctx.filter(|id| !id.is_empty());
    let mut guard = lock();
    match guard.as_mut() {
        Some(lg) => {
            if level < lg.min {
                return;
            }
            let line = format::text_line(dm_gocompat::time::now_local(), level, msg, req_id, attrs);
            let _ = lg.out.write_all(line.as_bytes());
        }
        None => {
            drop(guard);
            if level < Level::Info {
                return;
            }
            let line =
                format::default_line(dm_gocompat::time::now_local(), level, msg, req_id, attrs);
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }
}

pub fn debug(ctx: ReqCtx<'_>, msg: &str, attrs: &[(&str, Value)]) {
    log(Level::Debug, ctx, msg, attrs);
}
pub fn info(ctx: ReqCtx<'_>, msg: &str, attrs: &[(&str, Value)]) {
    log(Level::Info, ctx, msg, attrs);
}
pub fn warn(ctx: ReqCtx<'_>, msg: &str, attrs: &[(&str, Value)]) {
    log(Level::Warn, ctx, msg, attrs);
}
pub fn error(ctx: ReqCtx<'_>, msg: &str, attrs: &[(&str, Value)]) {
    log(Level::Error, ctx, msg, attrs);
}

/// 옛 `log.Printf` 가 옮겨 앉는 자리 (D-OBS-1). `debugf!(ctx, "fmt", args..)`.
#[macro_export]
macro_rules! debugf {
    ($ctx:expr, $($arg:tt)+) => {
        $crate::log($crate::Level::Debug, $ctx, &::std::format!($($arg)+), &[])
    };
}
#[macro_export]
macro_rules! infof {
    ($ctx:expr, $($arg:tt)+) => {
        $crate::log($crate::Level::Info, $ctx, &::std::format!($($arg)+), &[])
    };
}
#[macro_export]
macro_rules! warnf {
    ($ctx:expr, $($arg:tt)+) => {
        $crate::log($crate::Level::Warn, $ctx, &::std::format!($($arg)+), &[])
    };
}
#[macro_export]
macro_rules! errorf {
    ($ctx:expr, $($arg:tt)+) => {
        $crate::log($crate::Level::Error, $ctx, &::std::format!($($arg)+), &[])
    };
}

#[cfg(test)]
mod tests;
