//! Go 기준선 `otterminal/internal/webserver/domain/submodule` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 저장소 안에 등록된 서브모듈의 목록과 그 조작이다 (UX_BATCH5_SRS 묶음 D, FR-SUB-1~5). 별도
//! 패키지인 이유는 화이트리스트의 판정 단위다 (D-9) — `submodule status`(읽기)와 `submodule
//! update`(쓰기)는 argv[0] 이 같다. `submodule add`·`deinit` 는 하지 않는다 (§7 비목표 7).

#![forbid(unsafe_code)]

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{
    self as core, BoxFut, Ctx, MANAGER_WRITE_TIMEOUT, Service as GitService, unguarded_text_runner,
};
use serde::Serialize;

/// 거부 사유.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    UnsafePath,
    Failed,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::UnsafePath => "unsafe_path",
            Kind::Failed => "submodule_failed",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// submodule 의 오류. 실행 실패는 Failed 와 원인(core 의 분류)을 둘 다 든다 — 화면 문구는
/// Failed 가, index_locked·git_timeout 판정은 원인이 한다 (REPO_FIX 01 §5.6).
#[derive(Clone, Debug)]
pub struct Error {
    msg: String,
    kind: Option<Kind>,
    core: Option<core::Error>,
}

impl Error {
    pub fn new(kind: Kind, detail: impl fmt::Display) -> Self {
        Error {
            msg: format!("{kind}: {detail}"),
            kind: Some(kind),
            core: None,
        }
    }

    pub fn other(msg: impl Into<String>) -> Self {
        Error {
            msg: msg.into(),
            kind: None,
            core: None,
        }
    }

    pub fn is(&self, k: Kind) -> bool {
        self.kind == Some(k)
    }

    pub fn is_core(&self, k: core::Kind) -> bool {
        self.core.as_ref().is_some_and(|c| c.is(k))
    }

    pub fn kind(&self) -> Option<Kind> {
        self.kind
    }

    pub fn core(&self) -> Option<&core::Error> {
        self.core.as_ref()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

impl From<core::Error> for Error {
    fn from(e: core::Error) -> Self {
        Error {
            msg: e.message().to_owned(),
            kind: None,
            core: Some(e),
        }
    }
}

/// git 한 번의 실패. 실패에도 진단 텍스트(stdout 다음 stderr)가 있다.
#[derive(Clone, Debug)]
pub struct Failure {
    pub text: String,
    pub err: Error,
}

/// 서브모듈 상태 (FR-SUB-2). `git submodule status` 의 접두 문자에서 온다.
pub const STATE_OK: &str = "ok";
pub const STATE_UNINITIALIZED: &str = "uninitialized";
pub const STATE_MODIFIED: &str = "modified";
pub const STATE_CONFLICT: &str = "conflict";

fn state_by_prefix(b: u8) -> Option<&'static str> {
    match b {
        b' ' => Some(STATE_OK),
        b'-' => Some(STATE_UNINITIALIZED),
        b'+' => Some(STATE_MODIFIED),
        b'U' => Some(STATE_CONFLICT),
        _ => None,
    }
}

/// git 한 번의 상한이다. `submodule update` 는 원격에서 받아올 수 있어 짧게 둘 수 없다.
const OP_TIMEOUT: Duration = MANAGER_WRITE_TIMEOUT;

/// `ErrFailed` 에 감싸 올릴 진단의 길이 상한이다.
const FAIL_MAX: usize = 2000;

/// 실행 기록에 남는 사유다 (GIT_EXEC_UNIFY_SRS FR-GXU-1).
pub const UNGUARDED_REASON: &str = "submodule 도메인 — 화이트리스트가 argv[0] 으로 키잉되어 status 와 update 를 가를 수 없다 (D-9)";

/// git 한 번이다. ctx 는 호출자의 것이다 (REPO_FIX 01 §5.6).
pub type Runner =
    Arc<dyn Fn(Ctx, String, Vec<String>) -> BoxFut<Result<String, Failure>> + Send + Sync>;

/// 서브모듈 하나다 (FR-SUB-1). 경로는 저장소 안의 상대경로다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub path: String,
    pub oid: String,
    pub state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub describe: String,
}

/// 작업 경로에 넘길 실행 명세다 — argv 와 인가 우회의 사유 (M8 D-A-27).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Spec {
    pub argv: Vec<String>,
    pub reason: String,
}

#[derive(Clone)]
pub struct Manager {
    git: Runner,
}

impl fmt::Debug for Manager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Manager").finish_non_exhaustive()
    }
}

impl Manager {
    pub fn new(git: Runner) -> Self {
        Manager { git }
    }

    async fn run(&self, ctx: &Ctx, dir: &str, args: Vec<String>) -> Result<String, Failure> {
        (self.git)(ctx.clone(), dir.to_owned(), args).await
    }

    /// 등록된 서브모듈 전부다 (FR-SUB-1·2). `--recursive` 를 쓰지 않는다 (FR-SUB-3). 빈 출력은
    /// 정상이다 (FR-SUB-10). 실패를 빈 목록으로 낮추지 않는다.
    pub async fn list(&self, ctx: &Ctx, repo: &str) -> Result<Vec<Entry>, Error> {
        check_repo(repo)?;
        let args = vec!["submodule".to_owned(), "status".to_owned()];
        match self.run(ctx, repo, args).await {
            Ok(out) => Ok(parse_status(&out)),
            Err(f) => Err(failed(&f)),
        }
    }

    /// 서브모듈을 등록된 커밋으로 옮긴다 (FR-SUB-4). 파괴적이다 (FR-SUB-5) — 확인은 호출자가
    /// 이미 거쳤다. path 가 비면 전부가 대상이다.
    pub async fn update(
        &self,
        ctx: &Ctx,
        repo: &str,
        path: &str,
        init: bool,
        recursive: bool,
    ) -> Result<(), Error> {
        self.run_path_op(ctx, repo, path, update_args(init, recursive))
            .await
    }

    /// `.gitmodules` 의 URL 을 `.git/config` 로 옮긴다 (FR-SUB-4).
    pub async fn sync(&self, ctx: &Ctx, repo: &str, path: &str) -> Result<(), Error> {
        let args = vec!["submodule".to_owned(), "sync".to_owned()];
        self.run_path_op(ctx, repo, path, args).await
    }

    async fn run_path_op(
        &self,
        ctx: &Ctx,
        repo: &str,
        path: &str,
        args: Vec<String>,
    ) -> Result<(), Error> {
        let args = path_op_args(repo, path, args)?;
        self.run(ctx, repo, args).await.map_err(|f| failed(&f))?;
        Ok(())
    }
}

/// `git submodule status` 한 줄씩을 읽는다. describe 는 끝에서 뗀다(경로에 공백이 있을 수
/// 있다). 알아보지 못한 줄은 버린다.
fn parse_status(out: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for line in out.split('\n') {
        // 앞 공백을 다듬지 않는다 — 첫 글자가 상태다.
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(&first) = line.as_bytes().first() else {
            continue;
        };
        let Some(state) = state_by_prefix(first) else {
            continue;
        };
        let Some((oid, rest)) = line[1..].split_once(' ') else {
            continue;
        };
        if !core::is_oid(oid) {
            continue;
        }
        let (path, describe) = split_describe(rest);
        if path.is_empty() {
            continue;
        }
        entries.push(Entry {
            path: path.to_owned(),
            oid: oid.to_owned(),
            state: state.to_owned(),
            describe: describe.to_owned(),
        });
    }
    entries
}

fn split_describe(s: &str) -> (&str, &str) {
    if !s.ends_with(')') {
        return (s, "");
    }
    match s.rfind(" (") {
        Some(i) => (&s[..i], &s[i + 2..s.len() - 1]),
        None => (s, ""),
    }
}

fn update_args(init: bool, recursive: bool) -> Vec<String> {
    let mut args = vec!["submodule".to_owned(), "update".to_owned()];
    if init {
        args.push("--init".to_owned());
    }
    if recursive {
        args.push("--recursive".to_owned());
    }
    args
}

/// `submodule update` 의 작업 명세다. 인가는 이 패키지가, 실행은 jobs 가 한다.
pub fn update_spec(repo: &str, path: &str, init: bool, recursive: bool) -> Result<Spec, Error> {
    let argv = path_op_args(repo, path, update_args(init, recursive))?;
    Ok(Spec {
        argv,
        reason: UNGUARDED_REASON.to_owned(),
    })
}

fn failed(f: &Failure) -> Error {
    let msg = otter_shared_diagtail::of_str(&f.text, Some(&f.err.msg), FAIL_MAX);
    Error {
        msg: format!("{}: {msg}", Kind::Failed),
        kind: Some(Kind::Failed),
        core: f.err.core.clone(),
    }
}

fn path_op_args(repo: &str, path: &str, mut args: Vec<String>) -> Result<Vec<String>, Error> {
    check_repo(repo)?;
    if !path.is_empty() {
        check_path(path)?;
        // `--` 뒤에 둔다 — `-` 로 시작하는 경로가 플래그로 읽히지 않게.
        args.push("--".to_owned());
        args.push(path.to_owned());
    }
    Ok(args)
}

fn check_repo(repo: &str) -> Result<(), Error> {
    if repo.trim().is_empty() || !otter_gocompat::filepath::is_abs(repo) {
        return Err(Error::new(
            Kind::UnsafePath,
            format!("repo 는 절대경로여야 한다: {}", quote(repo)),
        ));
    }
    Ok(())
}

/// 저장소 안의 상대경로만 받는다. 몸통은 core 의 rel_path 이고, `-` 시작과 드라이브 문자를
/// 더 막는다.
fn check_path(p: &str) -> Result<(), Error> {
    if let Err(d) = core::rel_path_detail(p) {
        return Err(Error::new(Kind::UnsafePath, d));
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err(Error::new(
            Kind::UnsafePath,
            format!("드라이브 경로: {}", quote(p)),
        ));
    }
    if p.starts_with('-') {
        return Err(Error::new(
            Kind::UnsafePath,
            format!("플래그로 읽힌다: {}", quote(p)),
        ));
    }
    Ok(())
}

fn trim_trailing_newlines(s: &str) -> &str {
    s.trim_end_matches(['\r', '\n'])
}

/// 실행 기록을 core 와 공유하는 Runner 다 (FR-GXU-10). svc 가 없으면 기록 없이 돈다.
///
/// 뒤의 개행만 다듬는다 — `submodule status` 는 첫 글자가 상태이고 `ok` 의 접두는 공백이다
/// (FR-SUB-2). git 이 없는 환경에서 private 서브모듈 프롬프트가 매달리지 않게 core 의 환경을 쓴다.
pub fn runner_for(svc: Option<Arc<GitService>>) -> Runner {
    let inner = unguarded_text_runner(svc, OP_TIMEOUT, UNGUARDED_REASON, trim_trailing_newlines);
    Arc::new(move |ctx, dir, args| {
        let fut = inner(ctx, dir, args);
        Box::pin(async move {
            fut.await.map_err(|f| {
                let mut err = Error::from(f.err);
                if err.is_core(core::Kind::GitMissing) {
                    err.msg = format!("{}: git 을 찾을 수 없다: {}", Kind::Failed, err.msg);
                    err.kind = Some(Kind::Failed);
                }
                Failure { text: f.text, err }
            })
        })
    })
}

/// Service 없이 도는 기본 실행이다.
pub async fn exec_git(ctx: &Ctx, dir: &str, args: &[&str]) -> Result<String, Failure> {
    let args = args.iter().map(|s| (*s).to_owned()).collect();
    runner_for(None)(ctx.clone(), dir.to_owned(), args).await
}

#[cfg(test)]
mod tests;
