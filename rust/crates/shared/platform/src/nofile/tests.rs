use super::*;

const INF: u64 = u64::MAX;

#[test]
fn raises_to_finite_hard() {
    assert_eq!(raised_soft(256, 4096, None), Some(4096));
}

#[test]
fn infinite_hard_without_cap_goes_to_hard() {
    assert_eq!(raised_soft(256, INF, None), Some(INF));
}

#[test]
fn darwin_cap_cuts_infinite_hard() {
    assert_eq!(raised_soft(256, INF, Some(245_760)), Some(245_760));
}

#[test]
fn darwin_cap_cuts_large_finite_hard() {
    assert_eq!(raised_soft(256, 1_048_576, Some(245_760)), Some(245_760));
}

#[test]
fn cap_above_hard_keeps_hard() {
    assert_eq!(raised_soft(256, 4096, Some(245_760)), Some(4096));
}

#[test]
fn already_at_target_is_none() {
    assert_eq!(raised_soft(4096, 4096, None), None);
    assert_eq!(raised_soft(245_760, INF, Some(245_760)), None);
}

#[test]
fn never_lowers_soft() {
    assert_eq!(raised_soft(65_536, INF, Some(10_240)), None);
}

#[test]
fn zero_hard_is_none() {
    assert_eq!(raised_soft(0, 0, None), None);
}

#[test]
fn restore_without_raise_is_noop() {
    let mut cmd = Command::new("/bin/sh");
    restore_nofile_on_exec(&mut cmd);
}

/// 자식 프로세스에서 이 시험 하나만 돌 때 켜진다. soft 는 프로세스 전체의 값이라 다른 시험과
/// 섞이지 않게 따로 잰다.
#[cfg(unix)]
const CHILD_ENV: &str = "OTTER_PLATFORM_NOFILE_CHILD";
#[cfg(unix)]
const CHILD_TEST: &str = "nofile::tests::children_get_original_soft";
/// 시험이 시작 soft 로 삼는 값이다.
#[cfg(unix)]
const LOW: u64 = 200;

#[cfg(unix)]
fn getrlimit() -> libc::rlimit {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: lim 은 유효한 rlimit 이다.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    lim
}

#[cfg(unix)]
fn sh_ulimit() -> Command {
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "ulimit -n"]);
    c
}

#[cfg(unix)]
fn ulimit_of(mut cmd: Command, group: Option<Box<dyn crate::Group>>) -> String {
    let out = cmd.output().unwrap();
    if let Some(g) = group {
        let _ = g.close();
    }
    assert!(out.status.success(), "{out:?}");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

#[cfg(unix)]
fn ulimit_text(soft: u64) -> String {
    if soft == libc::RLIM_INFINITY {
        "unlimited".to_owned()
    } else {
        soft.to_string()
    }
}

#[cfg(unix)]
fn pty_ulimit() -> String {
    let spec = crate::ProcSpec {
        path: "/bin/sh".into(),
        args: vec!["sh".into(), "-c".into(), "ulimit -n".into()],
        env: std::env::vars().map(|(k, v)| format!("{k}={v}")).collect(),
        dir: String::new(),
    };
    let t = crate::pty::current().start(spec, 80, 24).unwrap();
    let mut text = Vec::new();
    let mut b = [0u8; 256];
    while let Ok(n) = t.read(&mut b) {
        if n == 0 {
            break;
        }
        text.extend_from_slice(&b[..n]);
    }
    let _ = t.wait();
    String::from_utf8_lossy(&text).trim().to_owned()
}

// 시작 soft 를 LOW 로 낮춘 새 프로세스에서 올린 뒤, 자식이 받는 soft 를 경로마다 잰다.
#[cfg(unix)]
#[test]
fn children_get_original_soft() {
    if std::env::var_os(CHILD_ENV).is_none() {
        let out = Command::new(std::env::current_exe().unwrap())
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
        return;
    }

    let start = getrlimit();
    assert!(start.rlim_max > LOW, "hard 가 {LOW} 이하다");
    let low = libc::rlimit {
        rlim_cur: LOW,
        rlim_max: start.rlim_max,
    };
    // SAFETY: low 는 유효한 rlimit 이다. soft 를 낮추는 것은 언제나 허용된다.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &low) }, 0);

    let r = raise_nofile_limit()
        .unwrap()
        .expect("soft 가 hard 보다 낮은데 올리지 않았다");
    assert_eq!(r.from, LOW);
    assert!(r.to > LOW, "{r:?}");
    assert_eq!(getrlimit().rlim_cur, r.to);
    assert_eq!(getrlimit().rlim_max, start.rlim_max, "hard 가 바뀌었다");
    assert_eq!(
        raise_nofile_limit().unwrap(),
        None,
        "두 번째는 할 일이 없다"
    );

    let want = LOW.to_string();
    let p = crate::current().process;

    let mut c = sh_ulimit();
    p.detach(&mut c);
    assert_eq!(ulimit_of(c, None), want, "detach");

    let mut c = sh_ulimit();
    let g = p.new_group(&mut c);
    assert_eq!(ulimit_of(c, Some(g)), want, "new_group");

    let mut c = sh_ulimit();
    restore_nofile_on_exec(&mut c);
    assert_eq!(ulimit_of(c, None), want, "restore_nofile_on_exec");

    assert_eq!(pty_ulimit(), want, "pty");

    // 되돌리기를 걸지 않은 자식은 올린 값을 물려받는다.
    assert_eq!(ulimit_of(sh_ulimit(), None), ulimit_text(r.to), "plain");
}
