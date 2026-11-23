//! 언어 서버 프로세스. 자손까지 한 묶음으로 띄우고, 멈출 때 묶음째 죽인다.

use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;

use dm_gocompat::oserr::path_error;

/// 띄운 서버와의 연결. `stop` 은 서버(와 자손)를 끝내고 거둔다.
pub struct Conn {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub stop: Box<dyn FnOnce() + Send>,
}

/// 서버를 띄운다 (exe, args, 작업 디렉터리). 검사가 바꿔 끼운다.
pub type Starter = Arc<dyn Fn(&str, &[String], &str) -> io::Result<Conn> + Send + Sync>;

/// 실제 프로세스. stdin·stdout 을 잇고 stderr 는 버린다.
pub fn start_process(exe: &str, args: &[String], dir: &str) -> io::Result<Conn> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let group = dm_shared_platform::current().process.new_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| path_error("fork/exec", exe, e))?;
    if let Err(e) = group.bind(&child) {
        let _ = group.kill();
        let _ = child.wait();
        let _ = group.close();
        return Err(e);
    }
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = group.kill();
        let _ = child.wait();
        let _ = group.close();
        return Err(io::Error::other("lsp: 파이프를 얻지 못했습니다"));
    };
    let stop = move || {
        let _ = group.kill();
        let _ = child.wait();
        let _ = group.close();
    };
    Ok(Conn {
        reader: Box::new(stdout),
        writer: Box::new(stdin),
        stop: Box::new(stop),
    })
}
