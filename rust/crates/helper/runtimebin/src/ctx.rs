//! 헬퍼 한 번의 실행 맥락 — 표준 입출력과 환경. 시험이 프로세스 환경을 건드리지 않고
//! 주소·홈·브라우저 열기를 바꿀 수 있게 한 자리다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// 이 컴퓨터의 브라우저로 URL 을 연다. 시험은 stdout 에 기록하는 것으로 바꾼다.
pub(crate) type OpenLocal = fn(&mut dyn Write, &str) -> Result<(), String>;

/// 에이전트 셈이 진짜 명령을 실행하는 자리다 (경로, argv, 환경). 시험은 기록하는 것으로 바꾼다.
pub(crate) type ShimExec = Arc<dyn Fn(&str, &[String], &[String]) -> i32 + Send + Sync>;

/// 환경변수와 시험용 바꿔 끼우기.
#[derive(Clone, Default)]
pub struct Env {
    vars: Option<HashMap<String, String>>,
    pub(crate) fallback_home: Option<PathBuf>,
    pub(crate) container_addr_file: Option<PathBuf>,
    pub(crate) open_local: Option<OpenLocal>,
    pub(crate) rename_window: Option<Duration>,
    pub(crate) rename_interval: Option<Duration>,
    pub(crate) shim_exec: Option<ShimExec>,
    pub(crate) shim_budget: Option<Duration>,
}

impl Env {
    /// 프로세스 환경을 읽는다.
    pub fn process() -> Self {
        Self::default()
    }

    /// 주어진 변수만 있는 환경이다. 나머지 변수는 빈 값으로 읽힌다.
    pub fn with_vars<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            vars: Some(
                vars.into_iter()
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect(),
            ),
            ..Self::default()
        }
    }

    /// Go `os.Getenv` — 없으면 빈 문자열이다.
    pub fn get(&self, key: &str) -> String {
        match &self.vars {
            Some(m) => m.get(key).cloned().unwrap_or_default(),
            None => std::env::var_os(key)
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }

    /// Go `os.Environ()` — `키=값` 목록이다.
    pub fn environ(&self) -> Vec<String> {
        match &self.vars {
            Some(m) => {
                let mut kv: Vec<String> = m.iter().map(|(k, v)| format!("{k}={v}")).collect();
                kv.sort();
                kv
            }
            None => std::env::vars_os()
                .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn set(&mut self, key: &str, value: &str) {
        self.vars
            .get_or_insert_with(HashMap::new)
            .insert(key.to_owned(), value.to_owned());
    }
}

/// 헬퍼 한 번의 입출력과 환경이다.
pub struct Ctx<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub inp: &'a mut dyn Read,
    pub env: &'a Env,
}

impl<'a> Ctx<'a> {
    pub fn new(
        out: &'a mut dyn Write,
        err: &'a mut dyn Write,
        inp: &'a mut dyn Read,
        env: &'a Env,
    ) -> Self {
        Self { out, err, inp, env }
    }
}

/// `fmt.Fprint(stdout, …)` — 쓰기 오류는 Go 처럼 버린다.
macro_rules! outf {
    ($ctx:expr, $($arg:tt)*) => {{
        let _ = write!($ctx.out, $($arg)*);
    }};
}

/// `fmt.Fprint(stderr, …)`.
macro_rules! errf {
    ($ctx:expr, $($arg:tt)*) => {{
        let _ = write!($ctx.err, $($arg)*);
    }};
}

pub(crate) use errf;
pub(crate) use outf;
