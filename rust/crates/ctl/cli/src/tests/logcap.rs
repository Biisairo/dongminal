use std::fs;
use std::io::Write;
use std::path::Path;

use crate::logcap::{cap_home_logs, cap_log};
use crate::{LOG_CHECK_EVERY, LOG_KEEP_BYTES, LOG_MAX_BYTES};

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn write_log(p: &Path, n: usize) {
    fs::write(p, vec![b'x'; n]).unwrap();
}

fn size_of(p: &Path) -> u64 {
    fs::metadata(p).unwrap().len()
}

// V-LOG-1: 상한 아래면 손대지 않는다.
#[test]
fn leaves_small_file_alone() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("otterminal.log");
    write_log(&p, 100);
    cap_log(s(&p), 1000, 400);
    assert_eq!(size_of(&p), 100);
    assert!(!d.path().join("otterminal.log.1").exists());
}

// V-LOG-2: 상한을 넘으면 줄어들고, 같은 파일이다 (FR-LOG-3).
#[cfg(unix)]
#[test]
fn truncates_in_place() {
    use std::os::unix::fs::MetadataExt;
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("otterminal.log");
    write_log(&p, 5000);
    let before = fs::metadata(&p).unwrap().ino();
    cap_log(s(&p), 1000, 400);
    let after = fs::metadata(&p).unwrap();
    assert_eq!(after.len(), 0);
    assert_eq!(after.ino(), before, "갈아치웠다");
}

// V-LOG-3: 최근 기록이 `.1` 로 남는다.
#[test]
fn keeps_recent_tail() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("otterminal.log");
    let mut body = vec![b'a'; 4600];
    body.extend(vec![b'b'; 400]);
    fs::write(&p, body).unwrap();
    cap_log(s(&p), 1000, 400);
    assert_eq!(
        fs::read(d.path().join("otterminal.log.1")).unwrap(),
        vec![b'b'; 400]
    );
}

// V-LOG-4: 자르기 뒤 O_APPEND fd 의 다음 쓰기가 이어진다.
#[test]
fn keeps_append_fd_writing() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("otterminal.log");
    write_log(&p, 5000);
    let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
    cap_log(s(&p), 1000, 400);
    f.write_all(b"after\n").unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"after\n");
}

// V-LOG-5: 없는 경로·빈 경로·디렉터리는 조용히 지나간다.
#[test]
fn quiet_on_missing_path() {
    let d = tempfile::tempdir().unwrap();
    cap_log("", 1000, 400);
    cap_log(s(&d.path().join("nope.log")), 1000, 400);
    cap_log(s(d.path()), 1000, 400);
    assert_eq!(fs::read_dir(d.path()).unwrap().count(), 0);
}

// 상한을 되풀이해 넘겨도 `.1` 은 하나이고 최신으로 갈린다.
#[test]
fn replaces_previous_keep() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("otterminal.log");
    write_log(&p, 5000);
    cap_log(s(&p), 1000, 400);
    fs::write(&p, vec![b'z'; 5000]).unwrap();
    cap_log(s(&p), 1000, 400);
    assert_eq!(
        fs::read(d.path().join("otterminal.log.1")).unwrap(),
        vec![b'z'; 400]
    );
    assert_eq!(fs::read_dir(d.path()).unwrap().count(), 2);
}

// keep 이 파일보다 크면 파일 전체를 남긴다.
#[test]
fn keep_larger_than_file() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("l");
    write_log(&p, 50);
    cap_log(s(&p), 10, 400);
    assert_eq!(size_of(&d.path().join("l.1")), 50);
    assert_eq!(size_of(&p), 0);
}

fn big_file(p: &Path, n: u64) {
    fs::File::create(p).unwrap().set_len(n).unwrap();
}

// G2-1: 홈 아래 세 로그가 모두 줄어든다.
#[test]
fn cap_home_logs_covers_all_three() {
    let d = tempfile::tempdir().unwrap();
    let names = ["server.log", "daemon.log", "restart.log"];
    for n in names {
        big_file(&d.path().join(n), 4096);
    }
    cap_home_logs(s(d.path()), 1024, 256);
    for n in names {
        assert!(size_of(&d.path().join(n)) <= 1024, "{n}");
    }
}

#[test]
fn cap_home_logs_leaves_small_files() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("daemon.log");
    big_file(&p, 100);
    cap_home_logs(s(d.path()), 1024, 256);
    assert_eq!(size_of(&p), 100);
}

#[test]
fn cap_home_logs_tolerates_missing() {
    let d = tempfile::tempdir().unwrap();
    cap_home_logs(s(&d.path().join("nope")), 1024, 256);
    cap_home_logs("", 1024, 256);
}

#[test]
fn defaults() {
    assert_eq!(LOG_MAX_BYTES, 64 << 20);
    assert_eq!(LOG_KEEP_BYTES, 8 << 20);
    assert_eq!(LOG_CHECK_EVERY, std::time::Duration::from_secs(60));
}

// 보내는 쪽이 사라지면 곧바로 끝난다 — 서버 종료가 감시를 기다리지 않는다.
#[test]
fn watch_log_size_stops_when_done() {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    drop(tx);
    let start = std::time::Instant::now();
    crate::watch_log_size(&rx);
    assert!(start.elapsed() < LOG_CHECK_EVERY);
}

// 받은 홈 아래 로그를 줄인다 — 환경의 홈(비었으면 사용자 기본 홈)을 보지 않는다.
#[test]
fn watch_loop_caps_given_home() {
    let d = tempfile::tempdir().unwrap();
    let home = s(d.path()).to_owned();
    let daemon = d.path().join(otter_shared_otterenv::DAEMON_LOG_FILE);
    write_log(&daemon, 1000);
    let no_env = |_: &str| String::new();
    let env = crate::env::Env::from_fn(&no_env);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watched = daemon.clone();
    let stopper = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while size_of(&watched) != 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(tx);
    });
    crate::logcap::watch_loop(
        &env,
        &home,
        &rx,
        std::time::Duration::from_millis(5),
        100,
        40,
    );
    stopper.join().unwrap();
    assert_eq!(size_of(&daemon), 0);
    assert_eq!(
        size_of(
            &d.path()
                .join(format!("{}.1", otter_shared_otterenv::DAEMON_LOG_FILE))
        ),
        40
    );
}
