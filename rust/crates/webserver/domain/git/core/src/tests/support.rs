//! 시험 보조. gittest·testpath(1.5)가 들어오면 그것으로 바꾼다.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;

use crate::{Ctx, Error, Output, Runner, WriteRunner};

/// Go `testpath.Abs`: 어느 OS 에서도 절대경로가 되는 경로.
pub(crate) fn abs(parts: &[&str]) -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    otter_gocompat::filepath::join(&[&[root], parts].concat())
}

pub(crate) fn abs_r() -> String {
    abs(&["r"])
}
pub(crate) fn abs_repo() -> String {
    abs(&["repo"])
}
pub(crate) fn abs_tmp_repo() -> String {
    abs(&["tmp", "repo"])
}
pub(crate) fn abs_user_repo() -> String {
    abs(&["Users", "x", "repo"])
}

/// Go `gittest.Path`. git 이 없으면 None — 시험은 건너뛴다.
pub(crate) fn git_path() -> Option<String> {
    otter_shared_platform::look_path("git")
}

/// Go `gittest.Run`.
pub(crate) fn git_run(dir: &str, args: &[&str]) -> String {
    let git = git_path().expect("git");
    let out = Command::new(git)
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", null_device())
        .env("GIT_CONFIG_SYSTEM", null_device())
        .output()
        .expect("git 실행");
    assert!(
        out.status.success(),
        "git {}: {}\n{}",
        args.join(" "),
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// 임시 디렉터리와 그 경로(심링크를 푼 것).
pub(crate) struct Temp {
    _dir: TempDir,
    pub(crate) path: String,
}

pub(crate) fn temp_dir() -> Temp {
    let dir = TempDir::new().expect("tempdir");
    let path = otter_gocompat::filepath::eval_symlinks(&dir.path().to_string_lossy())
        .expect("eval_symlinks");
    Temp { _dir: dir, path }
}

/// Go `gittest.Init`.
pub(crate) fn git_init() -> Temp {
    let t = temp_dir();
    git_run(&t.path, &["init", "-q", "-b", "main"]);
    git_run(&t.path, &["config", "user.email", "t@example.com"]);
    git_run(&t.path, &["config", "user.name", "tester"]);
    git_run(&t.path, &["config", "commit.gpgsign", "false"]);
    t
}

/// Go `gittest.Repo`: 커밋 하나를 가진 저장소.
pub(crate) fn git_repo() -> Temp {
    let t = git_init();
    std::fs::write(Path::new(&t.path).join("README.md"), "x\n").expect("write");
    git_run(&t.path, &["add", "."]);
    git_run(&t.path, &["commit", "-q", "-m", "init"]);
    t
}

/// 동기 결과를 내는 가짜 runner.
pub(crate) fn runner(
    f: impl Fn(Ctx, String, Vec<String>) -> Result<Output, Error> + Send + Sync + 'static,
) -> Runner {
    Arc::new(move |c, d, a| {
        let r = f(c, d, a);
        Box::pin(async move { r })
    })
}

/// 동기 결과를 내는 가짜 쓰기 runner.
pub(crate) fn write_runner(
    f: impl Fn(Ctx, String, Vec<String>, String) -> Result<Output, Error> + Send + Sync + 'static,
) -> WriteRunner {
    Arc::new(move |c, d, a, s| {
        let r = f(c, d, a, s);
        Box::pin(async move { r })
    })
}

pub(crate) fn out(stdout: &str, stderr: &str, exit_code: i32) -> Output {
    Output {
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.to_owned(),
        exit_code,
        ..Output::default()
    }
}

pub(crate) fn bg() -> Ctx {
    Ctx::background()
}
