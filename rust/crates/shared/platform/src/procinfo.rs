//! 프로세스·포트에 대한 읽기 전용 조회 (FR-XPI-1).
//!
//! 조회는 모두 실패할 수 있고, 실패는 오류가 아니라 "모름" 이다. 호출자는 추측으로
//! 채우지 않고 해당 기능만 비운다 (NFR-XP-6). 어댑터의 판단 로직은 cfg 없이 컴파일되어
//! 가짜 실행기·가짜 /proc 으로 어느 호스트에서도 검증된다 (§4.2).

mod darwin;
mod linux;
mod windows;

use std::collections::HashMap;
use std::io;

/// 프로세스·포트 조회.
pub trait ProcInfo: Send + Sync {
    /// pid 에 직계 자식이 있는지. 도구 busy 판정의 근거다. 읽지 못하면 false.
    fn has_children(&self, pid: i32) -> bool;
    /// pid 들의 has_children 을 한 번에 (FR-OPT-8-3). 읽지 못하면 빈 표다.
    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool>;
    /// 현재 작업 디렉터리.
    fn cwd(&self, pid: i32) -> Option<String>;
    /// pid 들의 cwd 를 한 번에 (FR-PRF-76). 읽지 못한 pid 는 표에 없다.
    fn cwds(&self, pids: &[i32]) -> HashMap<i32, String>;
    /// pid 들의 프로세스 이름을 한 번에 (NFR-XP-4).
    fn names(&self, pids: &[i32]) -> HashMap<i32, String>;
    /// TCP 포트를 LISTEN 으로 점유한 pid 들. 접속만 한 클라이언트는 넣지 않는다.
    fn listener_pids(&self, port: &str) -> Vec<i32>;
    /// pid 의 부모 (FR-XPI-7).
    fn parent_pid(&self, pid: i32) -> Option<i32>;
    /// 모든 프로세스의 pid → 부모 pid 표 (FR-RRC-10). 읽지 못하면 None — 빈 표와 "모름" 을 가른다.
    fn parents(&self) -> Option<HashMap<i32, i32>>;
    /// 이 서버에 붙은 로컬 TCP 연결의 반대쪽 끝을 소유한 프로세스. remote_addr 는 "host:port".
    /// 서버 자신은 뺀다.
    fn connection_owner_pid(&self, remote_addr: &str) -> Option<i32>;
}

pub(crate) fn current() -> &'static dyn ProcInfo {
    #[cfg(target_os = "linux")]
    {
        linux::current()
    }
    #[cfg(windows)]
    {
        windows::current()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        darwin::current()
    }
}

/// 실행 중인 프로세스의 명령줄 목록 (CLAUDE_ACCOUNTS_SRS FR-CAC-75). 읽지 못하면 오류다 —
/// 호출자는 "모름" 으로 다룬다. Windows 는 읽지 않고 빈 목록이다.
pub fn command_lines() -> io::Result<Vec<String>> {
    #[cfg(windows)]
    {
        Ok(Vec::new())
    }
    #[cfg(not(windows))]
    {
        darwin::command_lines_with(&darwin::exec_run)
    }
}

/// Go `net.SplitHostPort` 의 포트 쪽만 — "host:port", "[v6]:port".
fn split_port(addr: &str) -> Option<&str> {
    if let Some(rest) = addr.strip_prefix('[') {
        let end = rest.find(']')?;
        let after = &rest[end + 1..];
        if rest[..end].contains('[') || rest[..end].contains(']') {
            return None;
        }
        return after.strip_prefix(':');
    }
    let i = addr.rfind(':')?;
    let host = &addr[..i];
    if host.contains(':') || host.contains('[') || host.contains(']') {
        return None;
    }
    Some(&addr[i + 1..])
}

/// "host:port" 에서 포트를 뽑는다. 1..=65535 만 받는다.
fn remote_port(remote_addr: &str) -> Option<u16> {
    let n: i64 = split_port(remote_addr)?.parse().ok()?;
    u16::try_from(n).ok().filter(|p| *p >= 1)
}

/// 0 이하와 중복을 걷어낸 pid 목록. 원래 순서를 지킨다.
fn dedup_positive(pids: &[i32]) -> Vec<i32> {
    let mut seen = std::collections::HashSet::with_capacity(pids.len());
    pids.iter()
        .copied()
        .filter(|&p| p > 0 && seen.insert(p))
        .collect()
}

/// (pid, ppid) 표에서 want 각각에 자식이 있는지. 자기 자신을 부모로 적은 항목은 세지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
fn children_from_pairs(pairs: &[(i32, i32)], want: &[i32]) -> HashMap<i32, bool> {
    let mut out: HashMap<i32, bool> = want.iter().map(|&p| (p, false)).collect();
    for &(pid, ppid) in pairs {
        if pid != ppid
            && let Some(v) = out.get_mut(&ppid)
        {
            *v = true;
        }
    }
    out
}

/// self 가 아닌 첫 pid. 서버 자신도 그 소켓의 한쪽 끝을 쥐고 있으므로 거른다.
fn first_foreign_pid(pids: &[i32], self_pid: i32) -> Option<i32> {
    pids.iter().copied().find(|&p| p > 0 && p != self_pid)
}

fn self_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap_or(i32::MAX)
}

/// Go `strconv.Atoi` 로 pid 를 읽는다. i32 를 넘으면 실패다.
fn atoi(s: &str) -> Option<i32> {
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup() {
        assert_eq!(dedup_positive(&[5, 0, 5, -1, 7]), vec![5, 7]);
    }

    #[test]
    fn first_foreign_skips_self() {
        assert_eq!(first_foreign_pid(&[42, 77], 42), Some(77));
        assert_eq!(first_foreign_pid(&[42], 42), None);
    }

    #[test]
    fn remote_port_rules() {
        for (addr, want) in [
            ("127.0.0.1:54321", Some(54321)),
            ("[::1]:8080", Some(8080)),
            ("host:0", None),
            ("host:65536", None),
            ("host:abc", None),
            ("a:b:c", None),
            ("주소아님", None),
            ("[::1]", None),
            (":80", Some(80)),
            ("h:+80", Some(80)),
        ] {
            assert_eq!(remote_port(addr), want, "{addr:?}");
        }
    }

    #[test]
    fn children_pairs() {
        let pairs = [(1, 0), (200, 100), (300, 1), (400, 400)];
        let got = children_from_pairs(&pairs, &[100, 300, 400]);
        let want: HashMap<i32, bool> = [(100, true), (300, false), (400, false)].into();
        assert_eq!(got, want);
    }

    /// 실제 OS 로 자기 자신을 조회한다.
    #[cfg(unix)]
    #[test]
    fn real_self_lookup() {
        let info = current();
        let me = self_pid();
        // SAFETY: getppid 는 메모리를 건드리지 않는다.
        let ppid = unsafe { libc::getppid() };
        assert_eq!(info.parent_pid(me), Some(ppid));
        assert!(info.names(&[me]).get(&me).is_some_and(|n| !n.is_empty()));
        assert!(info.parents().is_some_and(|m| m.get(&me) == Some(&ppid)));
        let cwd = std::env::current_dir().unwrap();
        let got = info.cwd(me).map(std::path::PathBuf::from);
        assert_eq!(
            got.map(|p| p.canonicalize().unwrap()),
            Some(cwd.canonicalize().unwrap())
        );
        assert!(info.children_of(&[me]).contains_key(&me));
    }

    #[cfg(not(windows))]
    #[test]
    fn command_lines_includes_self() {
        let lines = command_lines().unwrap();
        let exe = std::env::current_exe().unwrap();
        let me = exe.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            lines.iter().any(|l| l.contains(&me)),
            "자기 프로세스 {me:?} 가 없다 ({} 줄)",
            lines.len()
        );
    }
}
