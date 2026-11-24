//! 인가를 지나지 않는 실행 진입점 (FR-GXU-1~5).
//!
//! 이 진입점의 안전은 호출처 화이트리스트가 진다 (FR-GXU-12, `tests/static_gate.rs`).

use std::sync::Arc;
use std::time::Duration;

use crate::ctx::Ctx;
use crate::error::{Error, Kind};
use crate::exec::{
    BoxFut, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT, Output, Service, check_cwd, default_write_runner,
    finish_exec, reject,
};
use crate::record::new_record;

/// 인가를 건너뛰는 실행 한 번의 요청이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UnguardedSpec {
    pub argv: Vec<String>,
    /// 내용은 기록에 남지 않는다 — 바이트 수만 남는다.
    pub stdin: String,
    /// Service 기본 마감을 대신한다. 0 이면 기본이다 (FR-GXU-3).
    pub timeout: Duration,
    /// 왜 인가를 건너뛰는가. 비어 있을 수 없다.
    pub reason: String,
}

/// 결과 텍스트의 다듬기 (FR-SUB-2). `str::trim` 이나 `|s| s` 를 넘긴다.
pub type Trim = fn(&str) -> &str;

/// `exec_unguarded_text` 의 실패. 실패에도 진단 텍스트(stdout 다음 stderr)가 있다.
#[derive(Clone, Debug)]
pub struct TextFailure {
    pub text: String,
    pub err: Error,
}

/// 화이트리스트를 지나지 않고 git 을 실행한다 (FR-GXU-1). 수신자가 없어도 안전하다
/// (FR-GXU-4) — 기록만 생략한다.
pub async fn exec_unguarded(
    svc: Option<&Service>,
    ctx: &Ctx,
    dir: &str,
    spec: &UnguardedSpec,
) -> Result<Output, Error> {
    let rec = |out: &Output, err: Option<&Error>| {
        if let Some(s) = svc {
            s.record_unguarded(dir, spec, out, err);
        }
    };
    if spec.reason.trim().is_empty() {
        let e = Error::new(
            Kind::UnsafeArgument,
            "Reason 이 비었다 — 인가를 건너뛰는 사유를 적어야 한다",
        );
        return reject(e, rec);
    }
    if spec.argv.is_empty() {
        return reject(Error::new(Kind::UnsafeArgument, "인자가 없다"), rec);
    }
    if let Err(e) = check_cwd(dir) {
        return reject(e, rec);
    }
    let d = if !spec.timeout.is_zero() {
        spec.timeout
    } else {
        svc.map_or(DEFAULT_TIMEOUT, |s| s.timeout)
    };
    let ctx2 = ctx.with_timeout(d);
    let runner = match svc {
        Some(s) => s
            .injected_write_runner()
            .unwrap_or_else(|| default_write_runner(s.max_output, s.path_env())),
        None => default_write_runner(DEFAULT_MAX_OUTPUT, None),
    };
    let res = runner(
        ctx2.clone(),
        dir.to_owned(),
        spec.argv.clone(),
        spec.stdin.clone(),
    )
    .await;
    let res = finish_exec(&ctx2, dir, &spec.argv, res);
    match &res {
        Ok(out) => rec(out, None),
        Err(e) => rec(e.output().unwrap_or(&Output::default()), Some(e)),
    }
    res
}

/// 결과를 도메인의 단일 문자열로 되돌린다 (FR-GXU-8). 성공은 stdout 만, 실패는 stdout
/// 다음 stderr 를 진단으로 준다.
pub fn unguarded_text<S: AsRef<str>>(
    argv: &[S],
    res: Result<Output, Error>,
    trim: Trim,
) -> Result<String, TextFailure> {
    match res {
        Ok(out) => Ok(trim(&out.stdout_str()).to_owned()),
        Err(err) => {
            let joined = match err.output() {
                Some(o) => format!("{}{}", o.stdout_str(), o.stderr),
                None => String::new(),
            };
            let argv: Vec<&str> = argv.iter().map(AsRef::as_ref).collect();
            Err(TextFailure {
                text: trim(&joined).to_owned(),
                err: err.wrap(format!("git {}", argv.join(" "))),
            })
        }
    }
}

/// exec_unguarded 와 unguarded_text 를 잇는다 (FR-RDG-61). git 부재면 텍스트를 비우고
/// 오류를 감싸지 않고 돌려준다 — 호출자가 자기 사유로 바꾼다.
pub async fn exec_unguarded_text(
    svc: Option<&Service>,
    ctx: &Ctx,
    dir: &str,
    spec: &UnguardedSpec,
    trim: Trim,
) -> Result<String, TextFailure> {
    let res = exec_unguarded(svc, ctx, dir, spec).await;
    if let Err(e) = &res
        && e.is(Kind::GitMissing)
    {
        return Err(TextFailure {
            text: String::new(),
            err: e.clone(),
        });
    }
    unguarded_text(&spec.argv, res, trim)
}

/// 도메인의 실행기 꼴(dir 과 위치 인자)로 묶은 exec_unguarded_text (FR-QG-50).
pub type TextRunner =
    Arc<dyn Fn(Ctx, String, Vec<String>) -> BoxFut<Result<String, TextFailure>> + Send + Sync>;

/// 마감·사유·다듬기를 붙인 실행기다. 수신자가 없어도 된다 (FR-GXU-4).
pub fn unguarded_text_runner(
    svc: Option<Arc<Service>>,
    timeout: Duration,
    reason: &str,
    trim: Trim,
) -> TextRunner {
    let reason = reason.to_owned();
    Arc::new(move |ctx, dir, args| {
        let svc = svc.clone();
        let spec = UnguardedSpec {
            argv: args,
            timeout,
            reason: reason.clone(),
            ..UnguardedSpec::default()
        };
        Box::pin(async move { exec_unguarded_text(svc.as_deref(), &ctx, &dir, &spec, trim).await })
    })
}

impl Service {
    /// `exec_unguarded(Some(self), ..)`.
    pub async fn exec_unguarded(
        &self,
        ctx: &Ctx,
        dir: &str,
        spec: &UnguardedSpec,
    ) -> Result<Output, Error> {
        exec_unguarded(Some(self), ctx, dir, spec).await
    }

    /// `exec_unguarded_text(Some(self), ..)`.
    pub async fn exec_unguarded_text(
        &self,
        ctx: &Ctx,
        dir: &str,
        spec: &UnguardedSpec,
        trim: Trim,
    ) -> Result<String, TextFailure> {
        exec_unguarded_text(Some(self), ctx, dir, spec, trim).await
    }

    /// 인가를 호출자가 진 실행을 기록에 남긴다 — 표식과 사유를 든다 (FR-GXU-5).
    pub fn record_unguarded(
        &self,
        dir: &str,
        spec: &UnguardedSpec,
        out: &Output,
        err: Option<&Error>,
    ) {
        let mut rec = new_record(dir, &spec.argv, out, err);
        rec.unguarded = true;
        rec.reason = spec.reason.clone();
        rec.stdin_bytes = spec.stdin.len();
        self.rec.add(rec);
    }
}
