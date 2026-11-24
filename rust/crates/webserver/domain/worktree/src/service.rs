//! 소비자(Run 격리, Worktrees 탭)가 관리자에 요구하는 표면이다 (M8 GO-44). 핸들러 시험은 이것을
//! 가짜로 채워 git 없이 돈다.

use std::future::Future;
use std::pin::Pin;

use otter_webserver_domain_git_core::Ctx;

use crate::error::Error;
use crate::manager::{ExecSpec, Manager, Repo, Spec};
use crate::parse::Entry;
use crate::remove::{RemoveResult, RemoveSpec};

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Service: Send + Sync {
    fn root(&self) -> &str;
    fn path(&self, run_short: &str, leaf: &str) -> String;
    fn resolve<'a>(
        &'a self,
        ctx: &'a Ctx,
        cwd: &'a str,
        base: &'a str,
    ) -> Fut<'a, Result<Repo, Error>>;
    fn create<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, Result<(), Error>>;
    fn rollback<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, ()>;
    fn remove<'a>(&'a self, ctx: &'a Ctx, s: &'a RemoveSpec) -> Fut<'a, RemoveResult>;
    fn remove_listed<'a>(&'a self, ctx: &'a Ctx, s: &'a RemoveSpec) -> Fut<'a, RemoveResult>;
    fn branch_exists<'a>(&'a self, ctx: &'a Ctx, repo: &'a str, branch: &'a str) -> Fut<'a, bool>;
    fn current_branch<'a>(&'a self, ctx: &'a Ctx, dir: &'a str) -> Fut<'a, String>;
    fn main_root<'a>(&'a self, ctx: &'a Ctx, dir: &'a str) -> Fut<'a, Result<String, Error>>;
    fn list<'a>(&'a self, ctx: &'a Ctx, repo: &'a str) -> Fut<'a, Result<Vec<Entry>, Error>>;
    /// worktree add 를 잡으로 돌리는 호출자의 두 절반 — 검증·argv 와 완료 뒤 설정. 잠금은
    /// 호출자가 쥔다.
    fn add_spec(&self, s: &Spec) -> Result<ExecSpec, Error>;
    fn configure<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, ()>;
}

impl Service for Manager {
    fn root(&self) -> &str {
        Manager::root(self)
    }
    fn path(&self, run_short: &str, leaf: &str) -> String {
        Manager::path(self, run_short, leaf)
    }
    fn resolve<'a>(
        &'a self,
        ctx: &'a Ctx,
        cwd: &'a str,
        base: &'a str,
    ) -> Fut<'a, Result<Repo, Error>> {
        Box::pin(Manager::resolve(self, ctx, cwd, base))
    }
    fn create<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, Result<(), Error>> {
        Box::pin(Manager::create(self, ctx, s))
    }
    fn rollback<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, ()> {
        Box::pin(Manager::rollback(self, ctx, s))
    }
    fn remove<'a>(&'a self, ctx: &'a Ctx, s: &'a RemoveSpec) -> Fut<'a, RemoveResult> {
        Box::pin(Manager::remove(self, ctx, s))
    }
    fn remove_listed<'a>(&'a self, ctx: &'a Ctx, s: &'a RemoveSpec) -> Fut<'a, RemoveResult> {
        Box::pin(Manager::remove_listed(self, ctx, s))
    }
    fn branch_exists<'a>(&'a self, ctx: &'a Ctx, repo: &'a str, branch: &'a str) -> Fut<'a, bool> {
        Box::pin(Manager::branch_exists(self, ctx, repo, branch))
    }
    fn current_branch<'a>(&'a self, ctx: &'a Ctx, dir: &'a str) -> Fut<'a, String> {
        Box::pin(Manager::current_branch(self, ctx, dir))
    }
    fn main_root<'a>(&'a self, ctx: &'a Ctx, dir: &'a str) -> Fut<'a, Result<String, Error>> {
        Box::pin(Manager::main_root(self, ctx, dir))
    }
    fn list<'a>(&'a self, ctx: &'a Ctx, repo: &'a str) -> Fut<'a, Result<Vec<Entry>, Error>> {
        Box::pin(Manager::list(self, ctx, repo))
    }
    fn add_spec(&self, s: &Spec) -> Result<ExecSpec, Error> {
        Manager::add_spec(self, s)
    }
    fn configure<'a>(&'a self, ctx: &'a Ctx, s: &'a Spec) -> Fut<'a, ()> {
        Box::pin(Manager::configure(self, ctx, s))
    }
}
