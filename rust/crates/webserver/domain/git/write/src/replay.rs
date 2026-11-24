//! 실행 기록을 다시 실행한다 (FR-GIT-94).

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::{Ctx, Output, Record, Service, WriteSpec};

use crate::error::{Error, WriteKind, exec, exec_write};

pub async fn replay(s: &Service, ctx: &Ctx, repo: &str, rec: &Record) -> Result<Output, Error> {
    let argv = rec.argv.clone().unwrap_or_default();
    if argv.is_empty() {
        return Err(Error::new(WriteKind::ReplayTarget, "argv 가 비었다"));
    }
    if rec.cwd != repo {
        return Err(Error::new(
            WriteKind::ReplayTarget,
            format!("다른 저장소의 기록이다: {}", quote(&rec.cwd)),
        ));
    }
    if rec.unguarded {
        return Err(Error::new(
            WriteKind::ReplayTarget,
            format!("인가를 지나지 않은 기록이다 ({})", rec.reason),
        ));
    }
    if rec.stdin_bytes > 0 {
        return Err(Error::new(
            WriteKind::ReplayTarget,
            "stdin 으로 넘긴 내용은 기록되지 않아 다시 실행할 수 없다",
        ));
    }
    if rec.write && argv[0] == "stash" {
        return Err(Error::new(
            WriteKind::ReplayTarget,
            "stash 는 위치로 기록돼 지금 다시 실행하면 다른 stash 를 건드릴 수 있다",
        ));
    }
    if rec.write {
        let spec = WriteSpec {
            argv,
            destructive: rec.destructive,
            stdin: String::new(),
        };
        return exec_write(s, ctx, repo, spec).await;
    }
    exec(s, ctx, repo, &argv).await
}
