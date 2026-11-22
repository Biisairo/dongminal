//! linux 어댑터 — 전량 /proc 으로 읽는다. 외부 프로세스를 띄우지 않는다 (FR-XPI-2).
//! 파일 접근을 주입받아 가짜 /proc 트리로 어느 OS 에서나 시험한다.

use std::collections::{HashMap, HashSet};
use std::io;

use super::{ProcInfo, atoi, dedup_positive, first_foreign_pid, remote_port, self_pid};

/// /proc 접근. 경로는 언제나 `/` 로 잇는다 — 호스트의 구분자가 아니다 (FR-WTP-40).
pub(crate) trait ProcFs {
    fn read(&self, path: &str) -> io::Result<Vec<u8>>;
    fn read_link(&self, path: &str) -> io::Result<String>;
    /// 디렉터리의 항목 이름들(순서 무관).
    fn list(&self, dir: &str) -> io::Result<Vec<String>>;
    /// 경로가 있는가(링크를 따라가지 않는다).
    fn exists(&self, path: &str) -> bool;
}

pub(crate) struct RealFs;

impl ProcFs for RealFs {
    fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }
    fn read_link(&self, path: &str) -> io::Result<String> {
        Ok(std::fs::read_link(path)?.to_string_lossy().into_owned())
    }
    fn list(&self, dir: &str) -> io::Result<Vec<String>> {
        std::fs::read_dir(dir)?
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect()
    }
    fn exists(&self, path: &str) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }
}

pub(crate) struct LinuxProcInfo<F> {
    pub fs: F,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn current() -> &'static dyn ProcInfo {
    static L: LinuxProcInfo<RealFs> = LinuxProcInfo { fs: RealFs };
    &L
}

const PROC_ROOT: &str = "/proc";
/// /proc/net/tcp 의 st 열이 LISTEN 임을 나타내는 값.
const TCP_LISTEN_STATE: &str = "0A";

fn proc_path(elem: &[&str]) -> String {
    let mut s = PROC_ROOT.to_owned();
    for e in elem {
        s.push('/');
        s.push_str(e);
    }
    s
}

// ── Go filepath.Glob 의 부분 이식 ───────────────────────
// 쓰는 패턴은 `*` 와 `[0-9]` 류의 문자 범주뿐이다. 결과 순서는 Go 와 같이 디렉터리마다
// 이름의 바이트 순서다.

fn has_meta(s: &str) -> bool {
    s.contains(['*', '?', '[', '\\'])
}

/// Go `path.Match` 중 `*`·`?`·`[lo-hi…]`(부정 `^` 포함)만.
fn glob_match(pat: &[u8], name: &[u8]) -> bool {
    match pat.split_first() {
        None => name.is_empty(),
        Some((b'*', rest)) => (0..=name.len()).any(|i| glob_match(rest, &name[i..])),
        Some((b'?', rest)) => !name.is_empty() && glob_match(rest, &name[1..]),
        Some((b'[', rest)) => {
            let Some(close) = rest.iter().position(|&c| c == b']') else {
                return false;
            };
            let Some((&c, tail)) = name.split_first() else {
                return false;
            };
            let (neg, class) = match rest[..close].split_first() {
                Some((b'^', cl)) => (true, cl),
                _ => (false, &rest[..close]),
            };
            let mut hit = false;
            let mut i = 0;
            while i < class.len() {
                if i + 2 < class.len() && class[i + 1] == b'-' {
                    hit |= class[i] <= c && c <= class[i + 2];
                    i += 3;
                } else {
                    hit |= class[i] == c;
                    i += 1;
                }
            }
            hit != neg && glob_match(&rest[close + 1..], tail)
        }
        Some((&p, rest)) => name.first() == Some(&p) && glob_match(rest, &name[1..]),
    }
}

fn glob(fs: &impl ProcFs, pattern: &str) -> Vec<String> {
    if !has_meta(pattern) {
        return if fs.exists(pattern) {
            vec![pattern.to_owned()]
        } else {
            Vec::new()
        };
    }
    let (dir, file) = match pattern.rfind('/') {
        Some(0) => ("/", &pattern[1..]),
        Some(i) => (&pattern[..i], &pattern[i + 1..]),
        None => (".", pattern),
    };
    let dirs = if has_meta(dir) {
        glob(fs, dir)
    } else {
        vec![dir.to_owned()]
    };
    let mut out = Vec::new();
    for d in dirs {
        let Ok(mut names) = fs.list(&d) else {
            continue;
        };
        names.sort();
        for n in names {
            if glob_match(file.as_bytes(), n.as_bytes()) {
                out.push(if d == "/" {
                    format!("/{n}")
                } else {
                    format!("{d}/{n}")
                });
            }
        }
    }
    out
}

impl<F: ProcFs> LinuxProcInfo<F> {
    /// 그 로컬 포트를 가진 소켓의 주인들. state 가 비면 상태를 가리지 않는다.
    fn pids_owning_local_port(&self, port: u16, state: &str) -> Vec<i32> {
        let mut inodes = HashSet::new();
        for name in ["tcp", "tcp6"] {
            if let Ok(blob) = self.fs.read(&proc_path(&["net", name])) {
                inodes.extend(parse_tcp_inodes(
                    &String::from_utf8_lossy(&blob),
                    port,
                    state,
                ));
            }
        }
        if inodes.is_empty() {
            return Vec::new();
        }
        let mut seen = HashSet::new();
        let mut pids = Vec::new();
        for fd in glob(&self.fs, &proc_path(&["*", "fd", "*"])) {
            let Ok(target) = self.fs.read_link(&fd) else {
                continue;
            };
            let Some(ino) = socket_inode(&target) else {
                continue;
            };
            if !inodes.contains(ino) {
                continue;
            }
            if let Some(pid) = pid_from_fd_path(&fd)
                && seen.insert(pid)
            {
                pids.push(pid);
            }
        }
        pids
    }
}

impl<F: ProcFs + Send + Sync> ProcInfo for LinuxProcInfo<F> {
    /// 스레드마다 있는 children 목록을 훑는다. 하나라도 비어 있지 않으면 참이다.
    fn has_children(&self, pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        glob(
            &self.fs,
            &proc_path(&[&pid.to_string(), "task", "*", "children"]),
        )
        .iter()
        .any(|t| {
            self.fs.read(t).is_ok_and(|b| {
                String::from_utf8_lossy(&b)
                    .split_whitespace()
                    .next()
                    .is_some()
            })
        })
    }

    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool> {
        dedup_positive(pids)
            .into_iter()
            .map(|p| (p, self.has_children(p)))
            .collect()
    }

    fn cwd(&self, pid: i32) -> Option<String> {
        if pid <= 0 {
            return None;
        }
        self.fs
            .read_link(&proc_path(&[&pid.to_string(), "cwd"]))
            .ok()
            .filter(|c| !c.is_empty())
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
            .filter_map(|p| {
                let blob = self.fs.read(&proc_path(&[&p.to_string(), "comm"])).ok()?;
                let name = String::from_utf8_lossy(&blob).trim().to_owned();
                (!name.is_empty()).then_some((p, name))
            })
            .collect()
    }

    /// /proc/net/tcp{,6} 에서 LISTEN 소켓의 inode 를 모으고, /proc/*/fd/* 의
    /// socket:[inode] 링크로 주인을 역추적한다.
    fn listener_pids(&self, port: &str) -> Vec<i32> {
        match atoi(port)
            .and_then(|n| u16::try_from(n).ok())
            .filter(|&n| n >= 1)
        {
            Some(n) => self.pids_owning_local_port(n, TCP_LISTEN_STATE),
            None => Vec::new(),
        }
    }

    fn parent_pid(&self, pid: i32) -> Option<i32> {
        if pid <= 0 {
            return None;
        }
        let blob = self.fs.read(&proc_path(&[&pid.to_string(), "stat"])).ok()?;
        parse_stat_ppid(&String::from_utf8_lossy(&blob))
    }

    /// /proc/<pid>/stat 을 훑는다. 그 사이 끝난 프로세스는 표에 없다.
    fn parents(&self) -> Option<HashMap<i32, i32>> {
        let mut out = HashMap::new();
        for st in glob(&self.fs, &proc_path(&["[0-9]*", "stat"])) {
            let Some(pid) = st.rsplit('/').nth(1).and_then(atoi) else {
                continue;
            };
            let Ok(blob) = self.fs.read(&st) else {
                continue;
            };
            if let Some(ppid) = parse_stat_ppid(&String::from_utf8_lossy(&blob)) {
                out.insert(pid, ppid);
            }
        }
        Some(out)
    }

    /// 클라이언트 소켓은 그 포트를 로컬 포트로 갖는다. 상태는 가리지 않는다.
    fn connection_owner_pid(&self, remote_addr: &str) -> Option<i32> {
        let port = remote_port(remote_addr)?;
        first_foreign_pid(&self.pids_owning_local_port(port, ""), self_pid())
    }
}

/// /proc/<pid>/stat 의 부모 pid. comm 에 공백·괄호가 올 수 있어 마지막 ')' 뒤부터 읽는다.
fn parse_stat_ppid(content: &str) -> Option<i32> {
    let i = content.rfind(')')?;
    let f: Vec<&str> = content[i + 1..].split_whitespace().collect();
    f.get(1).and_then(|s| atoi(s)).filter(|&p| p > 0)
}

/// /proc/net/tcp{,6} 에서 로컬 포트가 port 인 줄의 inode(열 9). state 가 있으면 그 상태만.
fn parse_tcp_inodes(content: &str, port: u16, state: &str) -> Vec<String> {
    content
        .split('\n')
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || (!state.is_empty() && f[3] != state) {
                return None;
            }
            let (_, hex) = f[1].rsplit_once(':')?;
            (u16::from_str_radix(hex, 16).ok()? == port).then(|| f[9].to_owned())
        })
        .collect()
}

/// `socket:[12345]` 에서 inode.
fn socket_inode(target: &str) -> Option<&str> {
    target
        .strip_prefix("socket:[")?
        .strip_suffix(']')
        .filter(|s| !s.is_empty())
}

/// /proc/<pid>/fd/<n> 에서 pid.
fn pid_from_fd_path(p: &str) -> Option<i32> {
    let parts: Vec<&str> = p.split('/').collect();
    let i = parts.iter().position(|&s| s == "proc")?;
    parts.get(i + 1).and_then(|s| atoi(s)).filter(|&n| n > 0)
}

#[cfg(test)]
mod tests;
