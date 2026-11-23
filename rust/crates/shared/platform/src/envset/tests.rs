use std::sync::mpsc;

use super::{ThreadsRunning, set_env_before_threads, thread_count};

/// 스레드 하나를 더 띄워 두고 f 를 부른 뒤 거둔다.
fn with_extra_thread<T>(f: impl FnOnce() -> T) -> T {
    let (tx, rx) = mpsc::channel::<()>();
    let (up_tx, up_rx) = mpsc::channel::<()>();
    let h = std::thread::spawn(move || {
        up_tx.send(()).unwrap();
        let _ = rx.recv();
    });
    up_rx.recv().unwrap();
    let out = f();
    drop(tx);
    h.join().unwrap();
    out
}

/// 자식 프로세스에서 이 시험 하나만 돌 때 켜진다.
const CHILD_ENV: &str = "DM_PLATFORM_ENVSET_THREAD_CHILD";
const CHILD_TEST: &str = "envset::tests::thread_count_sees_new_thread";

// 셀 수 있는 OS 에서는 스레드를 하나 더 띄우면 수가 정확히 하나 는다. 같은 프로세스의 다른 시험
// 스레드가 그 사이에 생기거나 끝나면 흔들리므로, 이 시험 하나만 도는 자식 프로세스에서 잰다.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn thread_count_sees_new_thread() {
    if std::env::var_os(CHILD_ENV).is_some() {
        let before = thread_count().expect("셀 수 있는 OS 다");
        assert!(before >= 1);
        let during = with_extra_thread(|| thread_count().unwrap());
        assert_eq!(during, before + 1, "before={before} during={during}");
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CHILD_TEST, "--test-threads=1"])
        .env(CHILD_ENV, "1")
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "{text}");
    assert!(text.contains("1 passed"), "{text}");
}

// 다른 스레드가 있으면 환경을 바꾸지 않는다.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
fn set_env_refuses_with_other_threads() {
    const KEY: &str = "DM_PLATFORM_ENVSET_TEST";
    let res = with_extra_thread(|| set_env_before_threads(KEY, "x"));
    match res {
        Err(ThreadsRunning(n)) => assert!(n >= 2, "n={n}"),
        Ok(()) => panic!("스레드가 둘 이상인데 환경을 바꿨다"),
    }
    assert!(std::env::var_os(KEY).is_none());
    let msg = ThreadsRunning(3).to_string();
    assert_eq!(msg, "다른 스레드가 있어 환경을 바꾸지 않았다 (스레드 3개)");
}
