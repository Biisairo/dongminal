//! darwin 어댑터 (FR-XPI-3). 프로세스 표(이름·cwd·자식·부모)는 커널에서 libproc·sysctl 로 읽어
//! 외부 프로세스를 띄우지 않는다. 연결·포트 조회만 `lsof` 를 띄운다. 커널 접근과 실행기를 주입받아
//! 어느 OS 에서나 시험한다.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use std::io;

use super::{ProcInfo, atoi, dedup_positive, first_foreign_pid, remote_port, self_pid};

/// 외부 명령의 결과. Go `exec.Command(..).Output()` 처럼 비정상 종료에도 stdout 을 남긴다.
pub(crate) struct RunOut {
    pub stdout: Vec<u8>,
    /// 띄웠고 0 으로 끝났다.
    pub ok: bool,
    /// ok 가 아닐 때의 Go 형식 문구(`exit status 1`, `exec: "ps": executable file not found in $PATH` 등).
    pub err: String,
}

pub(crate) fn exec_run(name: &str, args: &[&str]) -> RunOut {
    let prog = match crate::command_path(name) {
        Ok(p) => p,
        Err(err) => {
            return RunOut {
                stdout: Vec::new(),
                ok: false,
                err,
            };
        }
    };
    match std::process::Command::new(&prog)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(o) if o.status.success() => RunOut {
            stdout: o.stdout,
            ok: true,
            err: String::new(),
        },
        Ok(o) => RunOut {
            stdout: o.stdout,
            ok: false,
            err: crate::exit_status_text(&o.status),
        },
        Err(e) => RunOut {
            stdout: Vec::new(),
            ok: false,
            err: if e.kind() == io::ErrorKind::NotFound {
                format!(
                    "exec: {}: executable file not found in $PATH",
                    otter_gocompat::strconv::quote(name)
                )
            } else {
                otter_gocompat::oserr::go_error_string(&e)
            },
        },
    }
}

/// 커널의 프로세스 표 읽기. 외부 프로세스를 띄우지 않는다. 읽지 못하면 None 이다.
pub(crate) trait Kernel {
    /// `ps -o comm=` 과 같은 이름 — argv[0], 읽지 못하면 커널의 프로세스 이름.
    fn name(&self, pid: i32) -> Option<String>;
    fn cwd(&self, pid: i32) -> Option<String>;
    fn parent(&self, pid: i32) -> Option<i32>;
    /// 살아 있는 모든 pid.
    fn pids(&self) -> Option<Vec<i32>>;
    /// 직계 자식 pid 들.
    fn children(&self, pid: i32) -> Option<Vec<i32>>;
}

pub(crate) struct DarwinProcInfo<R, K> {
    pub run: R,
    pub kernel: K,
}

/// 실제 실행기.
type ExecRun = fn(&str, &[&str]) -> RunOut;

#[cfg(target_os = "macos")]
pub(crate) fn current() -> &'static dyn ProcInfo {
    static D: DarwinProcInfo<ExecRun, libproc::Libproc> = DarwinProcInfo {
        run: exec_run,
        kernel: libproc::Libproc,
    };
    &D
}

impl<R: Fn(&str, &[&str]) -> RunOut, K> DarwinProcInfo<R, K> {
    fn run(&self, name: &str, args: &[&str]) -> RunOut {
        (self.run)(name, args)
    }
}

impl<R: Fn(&str, &[&str]) -> RunOut + Send + Sync, K: Kernel + Send + Sync> ProcInfo
    for DarwinProcInfo<R, K>
{
    /// 자기 자신을 부모로 적은 항목은 세지 않는다.
    fn has_children(&self, pid: i32) -> bool {
        pid > 0
            && self
                .kernel
                .children(pid)
                .is_some_and(|c| c.iter().any(|&c| c != pid))
    }

    /// 읽지 못한 pid 는 표에 없다.
    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool> {
        dedup_positive(pids)
            .into_iter()
            .filter_map(|p| {
                let c = self.kernel.children(p)?;
                Some((p, c.iter().any(|&c| c != p)))
            })
            .collect()
    }

    fn cwd(&self, pid: i32) -> Option<String> {
        if pid <= 0 {
            return None;
        }
        self.kernel.cwd(pid).filter(|c| !c.is_empty())
    }

    fn cwds(&self, pids: &[i32]) -> HashMap<i32, String> {
        dedup_positive(pids)
            .into_iter()
            .filter_map(|p| Some((p, self.cwd(p)?)))
            .collect()
    }

    fn names(&self, pids: &[i32]) -> HashMap<i32, String> {
        dedup_positive(pids)
            .into_iter()
            .filter_map(|p| Some((p, self.kernel.name(p).filter(|n| !n.is_empty())?)))
            .collect()
    }

    fn listener_pids(&self, port: &str) -> Vec<i32> {
        let out = self.run("lsof", &["-ti", &format!(":{port}"), "-sTCP:LISTEN"]);
        if !out.ok {
            return Vec::new();
        }
        parse_pid_lines(&String::from_utf8_lossy(&out.stdout))
    }

    fn parent_pid(&self, pid: i32) -> Option<i32> {
        if pid <= 0 {
            return None;
        }
        self.kernel.parent(pid).filter(|&p| p > 0)
    }

    /// 표를 읽는 사이 끝난 프로세스는 빠진다.
    fn parents(&self) -> Option<HashMap<i32, i32>> {
        let pids = self.kernel.pids()?;
        Some(
            pids.into_iter()
                .filter_map(|p| Some((p, self.kernel.parent(p)?)))
                .collect(),
        )
    }

    /// 정확한 종단으로 먼저 묻고, 그것을 지원하지 않는 lsof 를 위해 포트로 물러선다.
    fn connection_owner_pid(&self, remote_addr: &str) -> Option<i32> {
        let port = remote_port(remote_addr)?;
        let mut out = self.run(
            "lsof",
            &["-i", &format!("tcp@{remote_addr}"), "-n", "-P", "-Fp"],
        );
        if !out.ok {
            out = self.run("lsof", &["-i", &format!("tcp:{port}"), "-n", "-P", "-Fp"]);
            if !out.ok {
                return None;
            }
        }
        first_foreign_pid(
            &parse_lsof_pid_fields(&String::from_utf8_lossy(&out.stdout)),
            self_pid(),
        )
    }
}

/// `ps -axo args=` 의 줄들. 빈 줄은 뺀다.
pub(crate) fn command_lines_with(run: &dyn Fn(&str, &[&str]) -> RunOut) -> io::Result<Vec<String>> {
    let out = run("ps", &["-axo", "args="]);
    if !out.ok {
        return Err(io::Error::other(out.err));
    }
    Ok(parse_command_lines(&out.stdout))
}

fn parse_command_lines(out: &[u8]) -> Vec<String> {
    out.split(|&b| b == b'\n')
        .map(|l| String::from_utf8_lossy(l).trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `lsof -Fp` 의 p 필드들.
fn parse_lsof_pid_fields(out: &str) -> Vec<i32> {
    out.split('\n')
        .filter_map(|line| atoi(line.trim().strip_prefix('p')?).filter(|&n| n > 0))
        .collect()
}

/// `KERN_PROCARGS2` 의 argv[0]. 배치는 argc(i32) · 실행 경로 · NUL 채움 · argv[0] · … 다.
fn parse_procargs_argv0(buf: &[u8]) -> Option<String> {
    let (argc, rest) = buf.split_first_chunk::<4>()?;
    if i32::from_ne_bytes(*argc) < 1 {
        return None;
    }
    let rest = &rest[rest.iter().position(|&b| b == 0)?..];
    let rest = &rest[rest.iter().position(|&b| b != 0)?..];
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

/// 공백으로 나뉜 양의 정수들.
fn parse_pid_lines(out: &str) -> Vec<i32> {
    out.split_whitespace()
        .filter_map(|f| atoi(f).filter(|&n| n > 0))
        .collect()
}

#[cfg(target_os = "macos")]
mod libproc;
#[cfg(test)]
mod tests;
