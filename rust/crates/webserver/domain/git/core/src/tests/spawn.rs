//! REPO_FIX 01 P-1·P-3 — 기동 헬퍼 하나가 신호 시퀀스를 갖는다. POSIX 만.
#![cfg(unix)]

use std::io::Read;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::support::*;
use crate::spawn::{Activity, spawn_with};
use crate::{Consumer, Ctx};

const GRACE: Duration = Duration::from_millis(200);

fn buf() -> (Arc<Mutex<Vec<u8>>>, Consumer) {
    let b = Arc::new(Mutex::new(Vec::new()));
    let b2 = b.clone();
    let c: Consumer = Box::new(move |mut r| {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                return;
            }
            b2.lock().unwrap().extend_from_slice(&chunk[..n]);
        }
    });
    (b, c)
}

fn sh(script: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.args(["-c", script]);
    c
}

fn alive(pid: i32) -> bool {
    otter_shared_platform::current().process.alive(pid)
}

fn read_pid(path: &std::path::Path) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(s) = std::fs::read_to_string(path)
            && let Ok(p) = s.trim().parse::<i32>()
            && p > 0
        {
            return p;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("자손 pid 를 얻지 못했다");
}

fn wait_dead(pid: i32, d: Duration) -> bool {
    let deadline = Instant::now() + d;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    !alive(pid)
}

// P-3 B: 파이프를 쥔 백그라운드 자식이 있어도 반환은 리더 종료 + 2G 안이다.
#[tokio::test]
async fn spawn_normal_exit_returns_despite_pipe_holder() {
    let dir = temp_dir();
    let pid_file = std::path::Path::new(&dir.path).join("bg.pid");
    let cmd = sh(&format!(
        "sleep 30 & echo $! > {}; echo done",
        pid_file.display()
    ));
    let (o, oc) = buf();
    let (_, ec) = buf();
    let act = Activity::new();
    let start = Instant::now();
    let st = spawn_with(&bg(), cmd, None, oc, ec, GRACE, &act)
        .await
        .unwrap();
    assert_eq!(st.code(), Some(0));
    assert!(String::from_utf8_lossy(&o.lock().unwrap()).contains("done"));
    assert!(start.elapsed() <= 2 * GRACE + Duration::from_secs(1));
    assert!(wait_dead(read_pid(&pid_file), Duration::from_secs(2)));
}

// P-3 A: 시한이 지나면 그룹 전체가 끝난다.
#[tokio::test]
async fn spawn_deadline_kills_whole_group() {
    let dir = temp_dir();
    let pid_file = std::path::Path::new(&dir.path).join("gc.pid");
    let ctx: Ctx = bg().with_timeout(Duration::from_millis(300));
    let cmd = sh(&format!(
        "trap '' TERM; sleep 30 & echo $! > {}; sleep 30",
        pid_file.display()
    ));
    let (_, oc) = buf();
    let (_, ec) = buf();
    let act = Activity::new();
    let start = Instant::now();
    let _ = spawn_with(&ctx, cmd, None, oc, ec, GRACE, &act).await;
    assert!(start.elapsed() <= Duration::from_millis(300) + 2 * GRACE + Duration::from_secs(1));
    assert!(wait_dead(read_pid(&pid_file), Duration::from_secs(2)));
}

#[tokio::test]
async fn spawn_stdin() {
    let (o, oc) = buf();
    let (_, ec) = buf();
    let act = Activity::new();
    spawn_with(&bg(), sh("cat"), Some("hello".into()), oc, ec, GRACE, &act)
        .await
        .unwrap();
    assert_eq!(&*o.lock().unwrap(), b"hello");
}

// REPO_FIX 01 §8: drain 은 떠 있는 프로세스가 모두 끝날 때까지 기다린다.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drain_waits_for_spawned() {
    static ACT: Activity = Activity::new();
    let ctx = bg().with_cancel();
    let c2 = ctx.clone();
    let h = tokio::spawn(async move {
        let (_, oc) = buf();
        let (_, ec) = buf();
        let _ = spawn_with(&c2, sh("sleep 30"), None, oc, ec, GRACE, &ACT).await;
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while ACT.wait(Duration::ZERO).await && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!ACT.wait(Duration::from_millis(50)).await);
    ctx.cancel();
    assert!(ACT.wait(2 * GRACE + Duration::from_secs(1)).await);
    h.await.unwrap();
    assert!(crate::drain(Duration::from_secs(10)).await);
}
