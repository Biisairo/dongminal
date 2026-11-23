//! 시험 보조. gittest·testpath(1.5)가 들어오면 그것으로 바꾼다.

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use dm_webserver_domain_git_core::{Ctx, Error, Output, Runner, Service};
use tempfile::TempDir;

pub(crate) fn abs(parts: &[&str]) -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    dm_gocompat::filepath::join(&[&[root], parts].concat())
}

pub(crate) fn abs_r() -> String {
    abs(&["r"])
}
pub(crate) fn abs_repo() -> String {
    abs(&["repo"])
}

pub(crate) fn git_path() -> Option<String> {
    dm_shared_platform::look_path("git")
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// Go `gittest.Run`.
pub(crate) fn git_run(dir: &str, args: &[&str]) -> String {
    let out = Command::new(git_path().expect("git"))
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

pub(crate) struct Temp {
    _dir: TempDir,
    pub(crate) path: String,
}

pub(crate) fn temp_dir() -> Temp {
    let dir = TempDir::new().expect("tempdir");
    let path =
        dm_gocompat::filepath::eval_symlinks(&dir.path().to_string_lossy()).expect("eval_symlinks");
    Temp { _dir: dir, path }
}

pub(crate) fn git_init() -> Temp {
    let t = temp_dir();
    git_run(&t.path, &["init", "-q", "-b", "main"]);
    git_run(&t.path, &["config", "user.email", "t@example.com"]);
    git_run(&t.path, &["config", "user.name", "tester"]);
    git_run(&t.path, &["config", "commit.gpgsign", "false"]);
    t
}

/// Go `gittest.Repo`: 커밋 하나(README.md)를 가진 저장소. git 이 없으면 None.
pub(crate) fn git_repo() -> Option<Temp> {
    git_path()?;
    let t = git_init();
    write_file(&t.path, "README.md", "x\n");
    git_run(&t.path, &["add", "."]);
    git_run(&t.path, &["commit", "-q", "-m", "init"]);
    Some(t)
}

pub(crate) fn write_file(dir: &str, name: &str, body: &str) {
    let p = Path::new(dir).join(name);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, body).unwrap();
}

pub(crate) fn runner(
    f: impl Fn(Ctx, String, Vec<String>) -> Result<Output, Error> + Send + Sync + 'static,
) -> Runner {
    Arc::new(move |c, d, a| {
        let r = f(c, d, a);
        Box::pin(async move { r })
    })
}

/// 고정 출력을 내고 받은 argv 를 모두 남기는 Service.
pub(crate) fn fake(o: Output) -> (Service, Arc<Mutex<Vec<Vec<String>>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let s = Service::builder()
        .runner(runner(move |_, _, a| {
            s2.lock().unwrap().push(a);
            Ok(o.clone())
        }))
        .build();
    (s, seen)
}

/// argv[0..] 로 출력을 고르는 Service.
pub(crate) fn fake_by(f: impl Fn(&[String]) -> Output + Send + Sync + 'static) -> Service {
    Service::builder()
        .runner(runner(move |_, _, a| Ok(f(&a))))
        .build()
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

pub(crate) fn json<T: serde::Serialize>(v: &T) -> String {
    String::from_utf8(dm_gocompat::json::marshal(v).unwrap()).unwrap()
}
