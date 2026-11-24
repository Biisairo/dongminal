//! 시험 보조 (Go `fixture_test.go`·`testpaths_test.go` 와 각 파일의 픽스처).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use otter_shared_gittest::{self as gittest, TempDir};
use otter_webserver_domain_git_core::{self as core, Ctx, Output, Runner, Service, WriteRunner};

pub(crate) fn bg() -> Ctx {
    Ctx::background()
}

pub(crate) fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

fn abs(seg: &[&str]) -> String {
    otter_shared_testpath::abs(seg)
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn abs_etc_passwd() -> String {
    abs(&["etc", "passwd"])
}
pub(crate) fn abs_repo() -> String {
    abs(&["repo"])
}
pub(crate) fn abs_repo_other() -> String {
    abs(&["repo-other"])
}
pub(crate) fn abs_tmp_repo() -> String {
    abs(&["tmp", "repo"])
}
pub(crate) fn abs_work_repo() -> String {
    abs(&["work", "repo"])
}

pub(crate) fn out(stdout: &str, stderr: &str, exit_code: i32) -> Output {
    Output {
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.to_owned(),
        exit_code,
        ..Output::default()
    }
}

/// 동기 결과를 내는 읽기 runner.
pub(crate) fn runner(f: impl Fn(&[String]) -> Output + Send + Sync + 'static) -> Runner {
    Arc::new(move |_, _, a| {
        let r = Ok(f(&a));
        Box::pin(async move { r })
    })
}

/// 동기 결과를 내는 쓰기 runner.
pub(crate) fn write_runner(
    f: impl Fn(&[String], &str) -> Output + Send + Sync + 'static,
) -> WriteRunner {
    Arc::new(move |_, _, a, stdin| {
        let r = Ok(f(&a, &stdin));
        Box::pin(async move { r })
    })
}

/// Go `headRunner`: HEAD 가 있는 저장소를 흉내 내는 읽기 실행기.
pub(crate) fn head_runner() -> Runner {
    runner(|_| Output::default())
}

/// Go `writeFake`: 쓰기 실행기를 대신해 argv 와 stdin 을 모은다.
#[derive(Clone, Default)]
pub(crate) struct WriteFake {
    argvs: Arc<Mutex<Vec<Vec<String>>>>,
    stdins: Arc<Mutex<Vec<String>>>,
}

impl WriteFake {
    pub(crate) fn runner(&self) -> WriteRunner {
        let (a, s) = (self.argvs.clone(), self.stdins.clone());
        write_runner(move |argv, stdin| {
            a.lock().unwrap().push(argv.to_vec());
            s.lock().unwrap().push(stdin.to_owned());
            Output::default()
        })
    }

    pub(crate) fn argvs(&self) -> Vec<Vec<String>> {
        self.argvs.lock().unwrap().clone()
    }
}

/// 쓰기만 가짜인 Service (읽기는 실제 git).
pub(crate) fn svc_w(f: &WriteFake) -> Service {
    Service::builder().write_runner(f.runner()).build()
}

/// 읽기·쓰기를 모두 주입한 Service.
pub(crate) fn svc_rw(r: Runner, f: &WriteFake) -> Service {
    Service::builder()
        .runner(r)
        .write_runner(f.runner())
        .build()
}

/// Go `realReader`: 읽기만 실제 git 으로 보내는 Runner.
pub(crate) fn real_reader() -> Runner {
    let real = Arc::new(Service::new());
    Arc::new(move |ctx, dir, args| {
        let real = real.clone();
        Box::pin(async move { real.exec(&ctx, &dir, &args).await })
    })
}

/// Go `stashWriteFake`: stash 의 읽기 하위 동작(list·show)만 실제 git 으로 보낸다.
pub(crate) fn stash_write_fake() -> (WriteRunner, Arc<Mutex<Vec<Vec<String>>>>) {
    let real = Arc::new(Service::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let r: WriteRunner = Arc::new(move |ctx, dir, args, _| {
        let real = real.clone();
        let seen = s2.clone();
        Box::pin(async move {
            if args.len() > 1 && (args[1] == "list" || args[1] == "show") {
                let spec = core::WriteSpec {
                    argv: args,
                    ..core::WriteSpec::default()
                };
                return real.exec_write(&ctx, &dir, &spec).await;
            }
            seen.lock().unwrap().push(args);
            Ok(Output::default())
        })
    });
    (r, seen)
}

/// 실제 git 저장소 픽스처. 놓으면 지워진다.
pub(crate) struct Fx {
    _repo: Option<gittest::Repo>,
    _tmp: Vec<TempDir>,
    path: String,
}

impl Fx {
    pub(crate) fn p(&self) -> &str {
        &self.path
    }

    pub(crate) fn dir(&self) -> &Path {
        Path::new(&self.path)
    }

    pub(crate) fn join(&self, rel: &str) -> PathBuf {
        self.dir().join(rel)
    }

    /// 픽스처가 끝날 때 함께 지울 임시 디렉터리를 붙인다.
    pub(crate) fn keep(&mut self, t: TempDir) {
        self._tmp.push(t);
    }
}

/// 심볼릭 링크를 푼 임시 디렉터리와 그 경로.
pub(crate) fn temp_dir() -> (TempDir, PathBuf) {
    let t = TempDir::new("otter-write-test-");
    let p = std::fs::canonicalize(t.path()).unwrap();
    (t, p)
}

fn pin_config(dir: &Path) {
    git_run(dir, &["config", "commit.gpgsign", "false"]);
    git_run(dir, &["config", "tag.gpgsign", "false"]);
}

/// Go `tempRepo`: 커밋 하나를 가진 임시 저장소. git 이 없으면 None.
pub(crate) fn temp_repo() -> Option<Fx> {
    let r = gittest::repo()?;
    pin_config(r.path());
    let path = r.path().to_string_lossy().into_owned();
    Some(Fx {
        _repo: Some(r),
        _tmp: Vec::new(),
        path,
    })
}

/// 임시 디렉터리 자체를 픽스처로 감싼다(저장소가 아닐 수도 있다).
pub(crate) fn temp_fx() -> Fx {
    let (t, p) = temp_dir();
    Fx {
        _repo: None,
        _tmp: vec![t],
        path: p.to_string_lossy().into_owned(),
    }
}

/// Go `tempRepoNoCommit`: 커밋 0개 + staged 1개(a.txt).
pub(crate) fn temp_repo_no_commit() -> Option<Fx> {
    gittest::path()?;
    let fx = temp_fx();
    git_run(fx.dir(), &["init", "-b", "main"]);
    git_run(fx.dir(), &["config", "user.email", "t@example.com"]);
    git_run(fx.dir(), &["config", "user.name", "tester"]);
    pin_config(fx.dir());
    write_file(fx.dir(), "a.txt", "staged before first commit\n");
    git_run(fx.dir(), &["add", "a.txt"]);
    Some(fx)
}

/// Go `tempEmptyRepo`: 커밋이 하나도 없는 저장소.
pub(crate) fn temp_empty_repo() -> Option<Fx> {
    gittest::path()?;
    let fx = temp_fx();
    git_run(fx.dir(), &["init", "-b", "main"]);
    Some(fx)
}

/// Go `tempRepoWithBranch`.
pub(crate) fn temp_repo_with_branch(branch: &str) -> Option<Fx> {
    let fx = temp_repo()?;
    git_run(fx.dir(), &["branch", branch]);
    Some(fx)
}

/// Go `tempRepoWithRemote`: bare 원격 + `origin/feat` 만 있고 로컬 feat 는 없다.
pub(crate) fn temp_repo_with_remote() -> Option<Fx> {
    let mut fx = temp_repo()?;
    let (t, base) = temp_dir();
    let bare = base.join("remote.git");
    let bare = bare.to_str().unwrap();
    git_run(&base, &["init", "-q", "--bare", bare]);
    let d = fx.dir().to_path_buf();
    git_run(&d, &["remote", "add", "origin", bare]);
    git_run(&d, &["checkout", "-q", "-b", "feat"]);
    git_run(&d, &["push", "-q", "origin", "feat"]);
    git_run(&d, &["checkout", "-q", "main"]);
    git_run(&d, &["branch", "-D", "feat"]);
    git_run(&d, &["fetch", "-q", "origin"]);
    fx.keep(t);
    Some(fx)
}

/// Go `gitRun`·`gitIn`: 준비 단계의 git (전역·시스템 설정 차단).
pub(crate) fn git_run(dir: &Path, args: &[&str]) -> String {
    gittest::run(dir, args)
}

pub(crate) fn write_file(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

/// 실제 git 으로 실행하면서 Service 가 띄운 git 의 argv 를 센다
/// (Go `gittest.Count` 대응 — 프로세스 대신 runner 경계에서 센다).
#[derive(Clone, Default)]
pub(crate) struct Count {
    calls: Arc<Mutex<Vec<String>>>,
}

impl Count {
    pub(crate) fn service(&self) -> Service {
        let real = Arc::new(Service::new());
        let (r1, c1) = (real.clone(), self.calls.clone());
        let (r2, c2) = (real, self.calls.clone());
        Service::builder()
            .runner(Arc::new(move |ctx, dir, args| {
                let (real, calls) = (r1.clone(), c1.clone());
                Box::pin(async move {
                    calls.lock().unwrap().push(args.join(" "));
                    real.exec(&ctx, &dir, &args).await
                })
            }))
            .write_runner(Arc::new(move |ctx, dir, args, stdin| {
                let (real, calls) = (r2.clone(), c2.clone());
                Box::pin(async move {
                    calls.lock().unwrap().push(args.join(" "));
                    let spec = core::WriteSpec {
                        argv: args,
                        destructive: false,
                        stdin,
                    };
                    real.exec_write(&ctx, &dir, &spec).await
                })
            }))
            .build()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    pub(crate) fn n(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    pub(crate) fn reset(&self) {
        self.calls.lock().unwrap().clear();
    }
}

pub(crate) fn has_arg(call: &str, arg: &str) -> bool {
    call.split_whitespace().any(|f| f == arg)
}
