use super::*;

/// testdata 의 Go 표(`N: "이름",` 줄)를 읽는다.
fn go_table(name: &str) -> Vec<(i64, String)> {
    let path = format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(path).unwrap();
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((n, rest)) = line.trim().split_once(':') else {
            continue;
        };
        let Ok(n) = n.trim().parse::<i64>() else {
            continue;
        };
        let v = rest.trim().trim_end_matches(',').trim_matches('"');
        out.push((n, v.to_owned()));
    }
    out
}

#[test]
fn signal_tables_match_go_source() {
    for (os, file) in [
        (WaitOs::Darwin, "go_signals_darwin.txt"),
        (WaitOs::Linux, "go_signals_linux.txt"),
    ] {
        let t = go_table(file);
        assert_eq!(t.len(), 31, "{file}");
        for (n, want) in t {
            assert_eq!(signal_name(os, n), want, "{os:?} {n}");
        }
    }
}

#[test]
fn signal_name_outside_table() {
    for os in [WaitOs::Darwin, WaitOs::Linux] {
        assert_eq!(signal_name(os, 0), "signal 0");
        assert_eq!(signal_name(os, 32), "signal 32");
        assert_eq!(signal_name(os, 64), "signal 64");
        assert_eq!(signal_name(os, -1), "signal -1");
    }
}

#[test]
fn exited() {
    for os in [WaitOs::Darwin, WaitOs::Linux] {
        assert_eq!(wait_status_text(os, 0), "exit status 0");
        assert_eq!(wait_status_text(os, 1 << 8), "exit status 1");
        assert_eq!(wait_status_text(os, 255 << 8), "exit status 255");
    }
}

#[test]
fn signaled_differs_by_os() {
    assert_eq!(
        wait_status_text(WaitOs::Linux, 11),
        "signal: segmentation fault"
    );
    assert_eq!(
        wait_status_text(WaitOs::Darwin, 11),
        "signal: segmentation fault"
    );
    assert_eq!(wait_status_text(WaitOs::Linux, 6), "signal: aborted");
    assert_eq!(wait_status_text(WaitOs::Darwin, 6), "signal: abort trap");
    assert_eq!(
        wait_status_text(WaitOs::Linux, 10),
        "signal: user defined signal 1"
    );
    assert_eq!(wait_status_text(WaitOs::Darwin, 10), "signal: bus error");
    assert_eq!(wait_status_text(WaitOs::Linux, 9), "signal: killed");
    assert_eq!(wait_status_text(WaitOs::Linux, 15), "signal: terminated");
    assert_eq!(wait_status_text(WaitOs::Linux, 40), "signal: signal 40");
}

#[test]
fn core_dumped() {
    assert_eq!(
        wait_status_text(WaitOs::Linux, 11 | 0x80),
        "signal: segmentation fault (core dumped)"
    );
    assert_eq!(
        wait_status_text(WaitOs::Darwin, 6 | 0x80),
        "signal: abort trap (core dumped)"
    );
    // 정상 종료에는 코어 비트를 보지 않는다.
    assert_eq!(
        wait_status_text(WaitOs::Linux, (1 << 8) | 0x80),
        "exit status 1"
    );
}

#[test]
fn stopped_and_continued() {
    // linux: SIGSTOP=19, SIGTSTP=20.
    assert_eq!(
        wait_status_text(WaitOs::Linux, (19 << 8) | 0x7F),
        "stop signal: stopped (signal)"
    );
    assert_eq!(
        wait_status_text(WaitOs::Linux, (5 << 8) | (3 << 16) | 0x7F),
        "stop signal: trace/breakpoint trap (trap 3)"
    );
    assert_eq!(
        wait_status_text(WaitOs::Linux, (5 << 8) | 0x7F),
        "stop signal: trace/breakpoint trap"
    );
    assert_eq!(wait_status_text(WaitOs::Linux, 0xFFFF), "continued");
    // darwin: 상위가 SIGSTOP(17)이면 계속, 아니면 멈춤. TrapCause 는 없다.
    assert_eq!(
        wait_status_text(WaitOs::Darwin, (17 << 8) | 0x7F),
        "continued"
    );
    assert_eq!(
        wait_status_text(WaitOs::Darwin, (18 << 8) | 0x7F),
        "stop signal: suspended"
    );
    assert_eq!(
        wait_status_text(WaitOs::Darwin, (5 << 8) | (3 << 16) | 0x7F),
        "stop signal: trace/BPT trap"
    );
}

#[test]
fn windows_codes() {
    assert_eq!(windows_exit_text(0), "exit status 0");
    assert_eq!(windows_exit_text(1), "exit status 1");
    assert_eq!(windows_exit_text(0xFFFF), "exit status 65535");
    assert_eq!(windows_exit_text(0x1_0000), "exit status 0x10000");
    assert_eq!(windows_exit_text(0xC000_0005), "exit status 0xc0000005");
}

/// 실제 자식 프로세스의 종료 문구가 Go 와 같다. 기대값은 같은 명령을 Go 1.27.2 의
/// `exec.Command("/bin/sh", "-c", s).Run()` 오류 문구로 떠 둔 것이다.
#[cfg(unix)]
#[test]
fn real_process_matches_go() {
    let darwin = cfg!(target_os = "macos");
    let cases = [
        ("exit 3", "exit status 3", "exit status 3"),
        (
            "kill -SEGV $$",
            "signal: segmentation fault",
            "signal: segmentation fault",
        ),
        ("kill -ABRT $$", "signal: abort trap", "signal: aborted"),
        ("kill -BUS $$", "signal: bus error", "signal: bus error"),
        (
            "kill -USR1 $$",
            "signal: user defined signal 1",
            "signal: user defined signal 1",
        ),
        ("kill -KILL $$", "signal: killed", "signal: killed"),
        ("kill -TERM $$", "signal: terminated", "signal: terminated"),
        ("kill -HUP $$", "signal: hangup", "signal: hangup"),
        (
            "kill -SYS $$",
            "signal: bad system call",
            "signal: bad system call",
        ),
    ];
    for (script, want_darwin, want_linux) in cases {
        // 코어 파일을 남기지 않게 해 `(core dumped)` 가 붙지 않도록 고정한다.
        // core_pattern 이 파이프인 호스트(Ubuntu 러너 등)는 `ulimit -c 0` 을 무시하고 코어를
        // 넘긴다 — 그때 Go 도 ` (core dumped)` 를 붙이므로 기대값에 같은 꼬리를 더한다.
        let st = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("ulimit -c 0; {script}")])
            .status()
            .unwrap();
        let base = if darwin { want_darwin } else { want_linux };
        let want = if std::os::unix::process::ExitStatusExt::core_dumped(&st) {
            format!("{base} (core dumped)")
        } else {
            base.to_owned()
        };
        assert_eq!(crate::exit_status_text(&st), want, "{script}");
    }
}
