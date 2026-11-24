//! darwin 어댑터 — 외부 CLI(lsof·ps·pgrep)로 읽는다 (FR-XPI-3). 실행기를 주입받아 어느 OS 에서나 시험한다.
#![cfg_attr(windows, allow(dead_code))]

use std::collections::HashMap;
use std::io;

use super::{
    ProcInfo, atoi, children_from_pairs, dedup_positive, first_foreign_pid, remote_port, self_pid,
};

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
                    dm_gocompat::strconv::quote(name)
                )
            } else {
                dm_gocompat::oserr::go_error_string(&e)
            },
        },
    }
}

pub(crate) struct DarwinProcInfo<R> {
    pub run: R,
}

#[cfg_attr(any(target_os = "linux", windows), allow(dead_code))]
pub(crate) fn current() -> &'static dyn ProcInfo {
    static D: DarwinProcInfo<fn(&str, &[&str]) -> RunOut> = DarwinProcInfo { run: exec_run };
    &D
}

impl<R: Fn(&str, &[&str]) -> RunOut> DarwinProcInfo<R> {
    fn run(&self, name: &str, args: &[&str]) -> RunOut {
        (self.run)(name, args)
    }

    fn ps_pairs(&self) -> Option<Vec<(i32, i32)>> {
        let out = self.run("ps", &["-A", "-o", "pid=,ppid="]);
        out.ok
            .then(|| parse_pid_ppid(&String::from_utf8_lossy(&out.stdout)))
    }
}

fn join_pids(pids: &[i32]) -> String {
    pids.iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

impl<R: Fn(&str, &[&str]) -> RunOut + Send + Sync> ProcInfo for DarwinProcInfo<R> {
    fn has_children(&self, pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let out = self.run("pgrep", &["-P", &pid.to_string()]);
        out.ok && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    }

    /// `ps` 를 한 번 띄워 모든 프로세스의 부모를 읽는다.
    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool> {
        let pids = dedup_positive(pids);
        if pids.is_empty() {
            return HashMap::new();
        }
        match self.ps_pairs() {
            Some(pairs) => children_from_pairs(&pairs, &pids),
            None => HashMap::new(),
        }
    }

    fn cwd(&self, pid: i32) -> Option<String> {
        if pid <= 0 {
            return None;
        }
        let out = self.run("lsof", &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]);
        if !out.ok {
            return None;
        }
        parse_lsof_cwd(&String::from_utf8_lossy(&out.stdout))
    }

    /// `lsof` 를 한 번 띄운다. 일부 pid 가 사라져 비정상 종료해도 나온 만큼 읽는다.
    fn cwds(&self, pids: &[i32]) -> HashMap<i32, String> {
        let pids = dedup_positive(pids);
        if pids.is_empty() {
            return HashMap::new();
        }
        let list = join_pids(&pids);
        let out = self.run("lsof", &["-a", "-p", &list, "-d", "cwd", "-Fpn"]);
        parse_lsof_cwds(&String::from_utf8_lossy(&out.stdout))
    }

    /// `ps` 한 번. 일부 pid 가 사라져 비정상 종료해도 나온 만큼 읽는다.
    fn names(&self, pids: &[i32]) -> HashMap<i32, String> {
        let pids = dedup_positive(pids);
        if pids.is_empty() {
            return HashMap::new();
        }
        let list = join_pids(&pids);
        let out = self.run("ps", &["-o", "pid=,comm=", "-p", &list]);
        parse_ps_comm_output(&String::from_utf8_lossy(&out.stdout))
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
        let out = self.run("ps", &["-o", "ppid=", "-p", &pid.to_string()]);
        if !out.ok {
            return None;
        }
        atoi(String::from_utf8_lossy(&out.stdout).trim()).filter(|&p| p > 0)
    }

    fn parents(&self) -> Option<HashMap<i32, i32>> {
        self.ps_pairs().map(|pairs| pairs.into_iter().collect())
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

/// `ps -o pid=,ppid=` 의 줄들을 (pid, ppid) 쌍으로 읽는다.
fn parse_pid_ppid(out: &str) -> Vec<(i32, i32)> {
    out.split('\n')
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            match f.as_slice() {
                [a, b] => Some((atoi(a)?, atoi(b)?)),
                _ => None,
            }
        })
        .collect()
}

/// `lsof -Fp` 의 p 필드들.
fn parse_lsof_pid_fields(out: &str) -> Vec<i32> {
    out.split('\n')
        .filter_map(|line| atoi(line.trim().strip_prefix('p')?).filter(|&n| n > 0))
        .collect()
}

/// `lsof -Fpn` 을 pid → 경로 표로 읽는다. 앞에 `p` 가 없는 `n` 은 버린다.
fn parse_lsof_cwds(out: &str) -> HashMap<i32, String> {
    let mut res = HashMap::new();
    let mut cur = 0;
    for line in out.split('\n') {
        if line.len() < 2 {
            continue;
        }
        let (kind, rest) = line.split_at(1);
        match kind {
            "p" => cur = atoi(rest.trim()).filter(|&n| n > 0).unwrap_or(0),
            "n" if cur > 0 => {
                res.insert(cur, rest.trim().to_owned());
            }
            _ => {}
        }
    }
    res
}

/// `lsof -Fn` 에서 첫 이름 필드.
fn parse_lsof_cwd(out: &str) -> Option<String> {
    out.split('\n')
        .find(|l| l.starts_with('n') && l.len() > 1)
        .map(|l| l[1..].trim().to_owned())
}

/// `ps -o pid=,comm=` 을 pid → 이름 표로. 이름에 공백이 있을 수 있어 첫 공백에서만 자른다.
fn parse_ps_comm_output(out: &str) -> HashMap<i32, String> {
    let mut res = HashMap::new();
    for line in out.split('\n') {
        let line = line.trim();
        let Some(sp) = line.find(' ').filter(|&i| i > 0) else {
            continue;
        };
        let Some(pid) = atoi(&line[..sp]) else {
            continue;
        };
        let name = line[sp + 1..].trim();
        if !name.is_empty() {
            res.insert(pid, name.to_owned());
        }
    }
    res
}

/// 공백으로 나뉜 양의 정수들.
fn parse_pid_lines(out: &str) -> Vec<i32> {
    out.split_whitespace()
        .filter_map(|f| atoi(f).filter(|&n| n > 0))
        .collect()
}

#[cfg(test)]
mod tests;
