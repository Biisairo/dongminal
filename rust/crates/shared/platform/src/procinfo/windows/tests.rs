use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::*;

fn build_tcp_table(
    row_size: usize,
    port_off: usize,
    pid_off: usize,
    rows: &[(u16, u32)],
) -> Vec<u8> {
    let mut buf = vec![0u8; TCP_TABLE_HEADER_SIZE + rows.len() * row_size];
    buf[..4].copy_from_slice(&(rows.len() as u32).to_le_bytes());
    for (i, &(port, pid)) in rows.iter().enumerate() {
        let off = TCP_TABLE_HEADER_SIZE + i * row_size;
        buf[off + port_off..off + port_off + 4]
            .copy_from_slice(&u32::from(port.swap_bytes()).to_le_bytes());
        buf[off + pid_off..off + pid_off + 4].copy_from_slice(&pid.to_le_bytes());
    }
    buf
}

#[test]
fn net_port_swaps_bytes() {
    assert_eq!(net_port(0x22E3), 58146);
}

#[test]
fn tcp_table_v4() {
    let buf = build_tcp_table(
        TCP_ROW_V4_SIZE,
        TCP_V4_PORT_OFF,
        TCP_V4_PID_OFF,
        &[(58146, 4321), (8080, 999), (58146, 4321)],
    );
    assert_eq!(parse_tcp_table_v4(&buf, 58146), vec![4321]);
    assert_eq!(parse_tcp_table_v4(&buf, 8080), vec![999]);
    assert!(parse_tcp_table_v4(&buf, 1).is_empty());
}

#[test]
fn tcp_table_v6() {
    let buf = build_tcp_table(
        TCP_ROW_V6_SIZE,
        TCP_V6_PORT_OFF,
        TCP_V6_PID_OFF,
        &[(58146, 777)],
    );
    assert_eq!(parse_tcp_table_v6(&buf, 58146), vec![777]);
}

#[test]
fn tcp_table_truncated() {
    let mut buf = vec![0u8; TCP_TABLE_HEADER_SIZE + TCP_ROW_V4_SIZE];
    buf[..4].copy_from_slice(&99u32.to_le_bytes());
    assert!(parse_tcp_table_v4(&buf, 58146).is_empty());
    assert!(parse_tcp_table_v4(&[], 58146).is_empty());
}

fn entry(pid: i32) -> ProcEntry {
    ProcEntry {
        pid,
        ppid: 0,
        name: String::new(),
    }
}

#[test]
fn snap_cache_serves_within_ttl() {
    let calls = AtomicUsize::new(0);
    let now = Mutex::new(Duration::ZERO);
    let c = SnapCache::new(
        Duration::from_secs(2),
        || *now.lock().unwrap(),
        || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![ProcEntry {
                pid: 1,
                ppid: 0,
                name: "init".into(),
            }])
        },
    );
    c.get().unwrap();
    *now.lock().unwrap() += Duration::from_millis(1900);
    c.get().unwrap();
    assert_eq!(
        calls.load(Ordering::Relaxed),
        1,
        "수명 안에서는 한 번이어야 한다"
    );
    *now.lock().unwrap() += Duration::from_millis(200);
    c.get().unwrap();
    assert_eq!(
        calls.load(Ordering::Relaxed),
        2,
        "수명이 지났는데 다시 뜨지 않았다"
    );
}

#[test]
fn snap_cache_does_not_cache_failure() {
    let calls = AtomicUsize::new(0);
    let c = SnapCache::new(
        Duration::from_secs(2),
        || Duration::ZERO,
        || {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                Err(io::Error::other("snapshot failed"))
            } else {
                Ok(vec![entry(7)])
            }
        },
    );
    assert!(c.get().is_err());
    assert_eq!(
        c.get().unwrap(),
        vec![entry(7)],
        "두 번째 조회가 실패를 물려받았다"
    );
}

#[test]
fn snap_cache_single_flight() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c = {
        let calls = calls.clone();
        Arc::new(SnapCache::new(
            Duration::from_secs(1),
            || Duration::ZERO,
            move || {
                calls.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(10));
                Ok(vec![entry(1)])
            },
        ))
    };
    let hs: Vec<_> = (0..20)
        .map(|_| {
            let c = c.clone();
            std::thread::spawn(move || {
                let _ = c.get();
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1, "겹쳐 뜨면 안 된다");
}

#[test]
fn snap_ttl_is_two_seconds() {
    assert_eq!(WIN_SNAP_TTL, Duration::from_secs(2));
}
