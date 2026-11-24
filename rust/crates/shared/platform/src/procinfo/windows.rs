//! Windows 어댑터 — 외부 프로세스를 띄우지 않는다 (FR-XPI-4). 프로세스 조회는 toolhelp
//! 스냅샷 한 번, 포트 조회는 iphlpapi 표 한 번이다. 표 해석과 스냅샷 캐시는 cfg 없이
//! 컴파일되어 어느 호스트에서도 검증된다 (§4.2).
#![cfg_attr(not(windows), allow(dead_code))]

use std::io;
use std::sync::Mutex;
use std::time::Duration;

/// 프로세스 스냅샷 한 줄.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProcEntry {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
}

/// 스냅샷 캐시의 수명. 전경 조회의 주기(`fgRefreshInterval`)와 같은 값이어야 한다 (HOST_PARITY_SRS D-6).
const WIN_SNAP_TTL: Duration = Duration::from_secs(2);

// MIB_TCPROW_OWNER_PID 는 DWORD 6개, MIB_TCP6ROW_OWNER_PID 는 주소 16바이트 둘에 DWORD 6개다.
const TCP_ROW_V4_SIZE: usize = 24;
const TCP_ROW_V6_SIZE: usize = 56;
const TCP_V4_PORT_OFF: usize = 8;
const TCP_V4_PID_OFF: usize = 20;
const TCP_V6_PORT_OFF: usize = 20;
const TCP_V6_PID_OFF: usize = 52;
const TCP_TABLE_HEADER_SIZE: usize = 4;

/// 프로세스 스냅샷의 짧은 수명 캐시 (HOST_PARITY_SRS FR-HPR-12·13).
/// 잠금을 쥔 채로 뜬다(single-flight). 실패는 캐시하지 않는다.
pub(crate) struct SnapCache<N, L> {
    ttl: Duration,
    now: N,
    load: L,
    state: Mutex<Option<(Duration, Vec<ProcEntry>)>>,
}

impl<N, L> SnapCache<N, L>
where
    N: Fn() -> Duration,
    L: Fn() -> io::Result<Vec<ProcEntry>>,
{
    pub(crate) const fn new(ttl: Duration, now: N, load: L) -> Self {
        SnapCache {
            ttl,
            now,
            load,
            state: Mutex::new(None),
        }
    }

    pub(crate) fn get(&self) -> io::Result<Vec<ProcEntry>> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        if let Some((at, data)) = st.as_ref()
            && now.saturating_sub(*at) < self.ttl
        {
            return Ok(data.clone());
        }
        let data = (self.load)()?;
        *st = Some((now, data.clone()));
        Ok(data)
    }
}

/// 포트 DWORD 는 하위 2바이트에 네트워크 바이트 순서로 실려 있다.
fn net_port(dw: u32) -> u16 {
    (dw as u16).swap_bytes()
}

fn le32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// GetExtendedTcpTable 의 버퍼에서 port 를 점유한 pid. 표가 이미 상태로 걸러져 있다.
fn parse_tcp_table(
    buf: &[u8],
    port: u16,
    row_size: usize,
    port_off: usize,
    pid_off: usize,
) -> Vec<i32> {
    if buf.len() < TCP_TABLE_HEADER_SIZE {
        return Vec::new();
    }
    let n = le32(buf, 0) as usize;
    let mut seen = std::collections::HashSet::new();
    let mut pids = Vec::new();
    for i in 0..n {
        let off = TCP_TABLE_HEADER_SIZE + i * row_size;
        if off + row_size > buf.len() {
            break;
        }
        let row = &buf[off..off + row_size];
        if net_port(le32(row, port_off)) != port {
            continue;
        }
        let pid = le32(row, pid_off) as i32;
        if pid > 0 && seen.insert(pid) {
            pids.push(pid);
        }
    }
    pids
}

fn parse_tcp_table_v4(buf: &[u8], port: u16) -> Vec<i32> {
    parse_tcp_table(buf, port, TCP_ROW_V4_SIZE, TCP_V4_PORT_OFF, TCP_V4_PID_OFF)
}

fn parse_tcp_table_v6(buf: &[u8], port: u16) -> Vec<i32> {
    parse_tcp_table(buf, port, TCP_ROW_V6_SIZE, TCP_V6_PORT_OFF, TCP_V6_PID_OFF)
}

#[cfg(windows)]
pub(crate) use sys::current;

#[cfg(windows)]
mod sys {
    use std::collections::HashMap;
    use std::io;
    use std::sync::OnceLock;
    use std::time::Instant;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_CLASS, TCP_TABLE_OWNER_PID_ALL, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    use super::super::{
        ProcInfo, atoi, children_from_pairs, dedup_positive, first_foreign_pid, remote_port,
        self_pid,
    };
    use super::*;

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    type Cache = SnapCache<fn() -> Duration, fn() -> io::Result<Vec<ProcEntry>>>;

    fn since_start() -> Duration {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed()
    }

    static SNAPS: Cache = SnapCache::new(WIN_SNAP_TTL, since_start, process_snapshot);

    pub(crate) struct WindowsProcInfo;

    pub(crate) fn current() -> &'static dyn ProcInfo {
        &WindowsProcInfo
    }

    /// 전체 프로세스 목록을 한 번에 읽는다.
    fn process_snapshot() -> io::Result<Vec<ProcEntry>> {
        // SAFETY: 포인터 인자가 없다.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            let e = io::Error::last_os_error();
            return Err(io::Error::new(
                e.kind(),
                format!(
                    "process snapshot: {}",
                    otter_gocompat::oserr::go_error_string(&e)
                ),
            ));
        }
        // SAFETY: 0 으로 채운 PROCESSENTRY32W 는 유효한 값이다.
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = Vec::new();
        // SAFETY: snap 은 유효한 스냅샷이고 e 의 dwSize 를 채웠다.
        let mut more = unsafe { Process32FirstW(snap, &mut e) } != 0;
        while more {
            let len = e
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(e.szExeFile.len());
            out.push(ProcEntry {
                pid: e.th32ProcessID as i32,
                ppid: e.th32ParentProcessID as i32,
                name: String::from_utf16_lossy(&e.szExeFile[..len]),
            });
            // SAFETY: 위와 같다.
            more = unsafe { Process32NextW(snap, &mut e) } != 0;
        }
        // SAFETY: snap 을 한 번만 닫는다.
        unsafe { CloseHandle(snap) };
        Ok(out)
    }

    /// 표를 통째로 받는다. 크기를 먼저 묻고 그 크기로 다시 부르는 것이 이 API 의 규약이다.
    fn extended_tcp_table(family: u32, class: TCP_TABLE_CLASS) -> Option<Vec<u8>> {
        let mut size = 0u32;
        // SAFETY: null 버퍼와 size 포인터로 필요한 크기만 묻는다.
        unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, family, class, 0) };
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        // SAFETY: buf 는 size 바이트이고, size 는 그 길이를 담는다.
        let ret =
            unsafe { GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, family, class, 0) };
        (ret == NO_ERROR).then_some(buf)
    }

    /// 그 로컬 포트를 가진 소켓의 주인들. v4·v6 를 모두 훑는다.
    fn pids_on_local_port(port: u16, class: TCP_TABLE_CLASS) -> Vec<i32> {
        let mut pids = Vec::new();
        if let Some(buf) = extended_tcp_table(AF_INET, class) {
            pids.extend(parse_tcp_table_v4(&buf, port));
        }
        if let Some(buf) = extended_tcp_table(AF_INET6, class) {
            pids.extend(parse_tcp_table_v6(&buf, port));
        }
        pids
    }

    impl ProcInfo for WindowsProcInfo {
        fn has_children(&self, pid: i32) -> bool {
            pid > 0
                && SNAPS
                    .get()
                    .is_ok_and(|es| es.iter().any(|e| e.ppid == pid && e.pid != pid))
        }

        fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool> {
            let pids = dedup_positive(pids);
            let Ok(es) = SNAPS.get() else {
                return HashMap::new();
            };
            let pairs: Vec<(i32, i32)> = es.iter().map(|e| (e.pid, e.ppid)).collect();
            children_from_pairs(&pairs, &pids)
        }

        /// 다른 프로세스의 작업 디렉터리는 조회하지 않는다 (FR-XPI-6).
        fn cwd(&self, _: i32) -> Option<String> {
            None
        }

        fn cwds(&self, _: &[i32]) -> HashMap<i32, String> {
            HashMap::new()
        }

        fn names(&self, pids: &[i32]) -> HashMap<i32, String> {
            let want: std::collections::HashSet<i32> = dedup_positive(pids).into_iter().collect();
            if want.is_empty() {
                return HashMap::new();
            }
            let Ok(es) = SNAPS.get() else {
                return HashMap::new();
            };
            es.into_iter()
                .filter(|e| want.contains(&e.pid) && !e.name.is_empty())
                .map(|e| (e.pid, e.name))
                .collect()
        }

        fn listener_pids(&self, port: &str) -> Vec<i32> {
            match atoi(port)
                .and_then(|n| u16::try_from(n).ok())
                .filter(|&n| n >= 1)
            {
                Some(n) => dedup_positive(&pids_on_local_port(n, TCP_TABLE_OWNER_PID_LISTENER)),
                None => Vec::new(),
            }
        }

        fn parent_pid(&self, pid: i32) -> Option<i32> {
            if pid <= 0 {
                return None;
            }
            SNAPS
                .get()
                .ok()?
                .into_iter()
                .find(|e| e.pid == pid && e.ppid > 0)
                .map(|e| e.ppid)
        }

        fn parents(&self) -> Option<HashMap<i32, i32>> {
            Some(
                SNAPS
                    .get()
                    .ok()?
                    .into_iter()
                    .map(|e| (e.pid, e.ppid))
                    .collect(),
            )
        }

        /// 클라이언트 소켓은 접속 중이므로 LISTENER 표에 없다. 전체 표를 본다.
        fn connection_owner_pid(&self, remote_addr: &str) -> Option<i32> {
            let port = remote_port(remote_addr)?;
            first_foreign_pid(
                &pids_on_local_port(port, TCP_TABLE_OWNER_PID_ALL),
                self_pid(),
            )
        }
    }
}

#[cfg(test)]
mod tests;
