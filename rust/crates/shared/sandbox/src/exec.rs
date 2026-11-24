//! Go `exec.Command(..).CombinedOutput()` 과 같은 실행: stdout·stderr 를 한 파이프로 모으고,
//! 실패 문구는 Go `*exec.ExitError`·`fork/exec` 와 같다.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const WAIT_POLL: Duration = Duration::from_millis(10);

/// 실행 결과다. `err` 는 Go `err.Error()` 이고 성공이면 `None` 이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunOutput {
    pub out: String,
    pub err: Option<String>,
}

impl RunOutput {
    pub fn ok(out: impl Into<String>) -> Self {
        Self {
            out: out.into(),
            err: None,
        }
    }

    pub fn fail(out: impl Into<String>, err: impl Into<String>) -> Self {
        Self {
            out: out.into(),
            err: Some(err.into()),
        }
    }
}

/// path 를 args 로 실행하고 합친 출력을 돌려준다. timeout 이 지나면 죽인다(`signal: killed`).
pub fn combined_output(path: &str, args: &[String], timeout: Option<Duration>) -> RunOutput {
    let (mut reader, writer) = match std::io::pipe() {
        Ok(p) => p,
        Err(e) => return RunOutput::fail("", otter_gocompat::oserr::go_error_string(&e)),
    };
    let werr = match writer.try_clone() {
        Ok(w) => w,
        Err(e) => return RunOutput::fail("", otter_gocompat::oserr::go_error_string(&e)),
    };
    let mut cmd = Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(writer)
        .stderr(werr);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunOutput::fail("", format!("fork/exec {path}: {}", spawn_err_text(&e))),
    };
    drop(cmd);
    let collector = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        buf
    });
    let status = wait(&mut child, timeout);
    let out = String::from_utf8_lossy(&collector.join().unwrap_or_default()).into_owned();
    match status {
        Ok(st) if st.success() => RunOutput::ok(out),
        Ok(st) => RunOutput::fail(out, exit_text(&st)),
        Err(e) => RunOutput::fail(out, otter_gocompat::oserr::go_error_string(&e)),
    }
}

fn wait(child: &mut std::process::Child, timeout: Option<Duration>) -> std::io::Result<ExitStatus> {
    let Some(t) = timeout else {
        return child.wait();
    };
    let deadline = Instant::now() + t;
    loop {
        if let Some(st) = child.try_wait()? {
            return Ok(st);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return child.wait();
        }
        std::thread::sleep(WAIT_POLL);
    }
}

fn spawn_err_text(e: &std::io::Error) -> String {
    e.raw_os_error()
        .map_or_else(|| e.to_string(), otter_gocompat::oserr::errno_string)
}

/// Go `*exec.ExitError` 의 문구(`exit status N`, `signal: killed` 등).
pub fn exit_text(st: &ExitStatus) -> String {
    otter_shared_platform::exit_status_text(st)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn combined_output_and_errors() {
        let sh = "/bin/sh".to_string();
        let r = combined_output(&sh, &["-c".into(), "echo out; echo err 1>&2".into()], None);
        assert_eq!(r.err, None);
        assert!(r.out.contains("out\n") && r.out.contains("err\n"));
        let r = combined_output(&sh, &["-c".into(), "echo x; exit 3".into()], None);
        assert_eq!(r, RunOutput::fail("x\n", "exit status 3"));
        let r = combined_output(
            &sh,
            &["-c".into(), "sleep 5".into()],
            Some(Duration::from_millis(100)),
        );
        assert_eq!(r.err.as_deref(), Some("signal: killed"));
        let r = combined_output("/no/such/bin", &[], None);
        assert_eq!(
            r.err.as_deref(),
            Some("fork/exec /no/such/bin: no such file or directory")
        );
    }
}
