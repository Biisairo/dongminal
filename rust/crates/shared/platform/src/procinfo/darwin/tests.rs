use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn ok(s: &str) -> RunOut {
    RunOut {
        stdout: s.as_bytes().to_vec(),
        ok: true,
        err: String::new(),
    }
}

fn fail() -> RunOut {
    RunOut {
        stdout: Vec::new(),
        ok: false,
        err: "exit status 1".into(),
    }
}

fn map<V: Clone>(pairs: &[(i32, V)]) -> HashMap<i32, V> {
    pairs.iter().cloned().collect()
}

#[test]
fn parse_lsof_cwd_cases() {
    assert_eq!(
        parse_lsof_cwd("p1234\nfcwd\nn/Users/dykim/personal/dongminal\n").as_deref(),
        Some("/Users/dykim/personal/dongminal")
    );
    assert_eq!(parse_lsof_cwd("p1234\nfcwd\n"), None);
}

#[test]
fn parse_ps_comm() {
    let out = " 100 vim\n 200 /Applications/My App.app/Contents/MacOS/My App\nrubbish\n";
    assert_eq!(
        parse_ps_comm_output(out),
        map(&[
            (100, "vim".to_owned()),
            (
                200,
                "/Applications/My App.app/Contents/MacOS/My App".to_owned()
            )
        ])
    );
}

#[test]
fn parse_pid_lines_cases() {
    assert_eq!(parse_pid_lines("111\n222\n\nxyz\n-5\n"), vec![111, 222]);
}

#[test]
fn parse_lsof_pid_fields_cases() {
    assert_eq!(
        parse_lsof_pid_fields("p1234\nf5\np5678\nrubbish\n"),
        vec![1234, 5678]
    );
}

#[test]
fn parse_command_lines_cases() {
    assert_eq!(
        parse_command_lines(b"  /usr/bin/cswap auto\n\n/bin/zsh -l  \n"),
        vec!["/usr/bin/cswap auto", "/bin/zsh -l"]
    );
}

#[test]
fn exec_missing_binary_is_go_exec_error() {
    let out = exec_run("otter-no-such-binary-7f3c", &[]);
    assert!(!out.ok);
    assert_eq!(
        out.err,
        "exec: \"otter-no-such-binary-7f3c\": executable file not found in $PATH"
    );
}

#[test]
fn command_lines_run_failure() {
    assert!(command_lines_with(&|_, _| fail()).is_err());
}

#[test]
fn darwin_proc_info() {
    let d = DarwinProcInfo {
        run: |name: &str, args: &[&str]| match name {
            "pgrep" => ok("501\n"),
            "lsof" if args.first() == Some(&"-ti") => ok("39009\n"),
            "lsof" => ok("p100\nfcwd\nn/tmp/work\n"),
            "ps" => ok(" 100 zsh\n"),
            _ => fail(),
        },
    };
    assert!(d.has_children(100));
    assert_eq!(d.cwd(100).as_deref(), Some("/tmp/work"));
    assert_eq!(d.names(&[100]), map(&[(100, "zsh".to_owned())]));
    assert_eq!(d.listener_pids("58146"), vec![39009]);
}

#[test]
fn names_is_single_call() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            ok("")
        },
    };
    let pids: Vec<i32> = (1..=100).collect();
    d.names(&pids);
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn names_and_cwds_skip_empty() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            ok("")
        },
    };
    d.names(&[0, -1]);
    d.cwds(&[0, -1]);
    assert!(d.children_of(&[0]).is_empty());
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[test]
fn names_reads_partial_output_on_failure() {
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| RunOut {
            stdout: b" 100 zsh\n".to_vec(),
            ok: false,
            err: "exit status 1".into(),
        },
    };
    assert_eq!(d.names(&[100, 200]), map(&[(100, "zsh".to_owned())]));
}

#[test]
fn exact_arguments() {
    let calls = Mutex::new(Vec::<String>::new());
    let d = DarwinProcInfo {
        run: |name: &str, args: &[&str]| {
            calls
                .lock()
                .unwrap()
                .push(format!("{name} {}", args.join(" ")));
            fail()
        },
    };
    d.has_children(7);
    d.cwd(7);
    d.cwds(&[7, 8, 7]);
    d.names(&[7, 8]);
    d.listener_pids("58146");
    d.parent_pid(7);
    d.parents();
    d.connection_owner_pid("127.0.0.1:54321");
    assert_eq!(
        *calls.lock().unwrap(),
        [
            "pgrep -P 7",
            "lsof -a -p 7 -d cwd -Fn",
            "lsof -a -p 7,8 -d cwd -Fpn",
            "ps -o pid=,comm= -p 7,8",
            "lsof -ti :58146 -sTCP:LISTEN",
            "ps -o ppid= -p 7",
            "ps -A -o pid=,ppid=",
            "lsof -i tcp@127.0.0.1:54321 -n -P -Fp",
            "lsof -i tcp:54321 -n -P -Fp",
        ]
    );
}

#[test]
fn parent_and_connection_owner() {
    let me = super::self_pid();
    let d = DarwinProcInfo {
        run: |name: &str, args: &[&str]| match name {
            "ps" => ok("  1234\n"),
            "lsof" if args.get(1) == Some(&"tcp@127.0.0.1:54321") => ok(&format!("p{me}\np7777\n")),
            _ => fail(),
        },
    };
    assert_eq!(d.parent_pid(4321), Some(1234));
    assert_eq!(d.connection_owner_pid("127.0.0.1:54321"), Some(7777));
    assert_eq!(d.connection_owner_pid("주소아님"), None);
}

#[test]
fn cwds_single_call_and_pairing() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            ok("p100\nfcwd\nn/tmp/a\np200\nfcwd\nn/tmp/b\n")
        },
    };
    let pids: Vec<i32> = (1..=20).chain([100, 200, 300]).collect();
    assert_eq!(
        d.cwds(&pids),
        map(&[(100, "/tmp/a".to_owned()), (200, "/tmp/b".to_owned())])
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn cwds_drops_orphan_path() {
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| ok("n/tmp/orphan\np100\nfcwd\nn/tmp/a\n"),
    };
    assert_eq!(d.cwds(&[100]), map(&[(100, "/tmp/a".to_owned())]));
}

#[test]
fn children_of_is_single_call() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |name: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            assert_eq!(name, "ps");
            ok("  1     0\n 200   100\n 300     1\n 400   400\n garbage\n")
        },
    };
    assert_eq!(
        d.children_of(&[100, 300, 400, 100, 0]),
        map(&[(100, true), (300, false), (400, false)])
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn parents() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            ok("  1     0\n 200   100\n garbage\n 300   200\n")
        },
    };
    assert_eq!(d.parents(), Some(map(&[(1, 0), (200, 100), (300, 200)])));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        DarwinProcInfo {
            run: |_: &str, _: &[&str]| fail()
        }
        .parents(),
        None
    );
}
