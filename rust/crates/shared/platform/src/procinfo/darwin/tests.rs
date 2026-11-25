use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

#[derive(Default)]
struct FakeKernel {
    names: HashMap<i32, String>,
    cwds: HashMap<i32, String>,
    /// pid → 부모. pids()·children() 의 근거다.
    parents: HashMap<i32, i32>,
    /// 표 전체를 읽지 못한다.
    down: bool,
}

impl Kernel for FakeKernel {
    fn name(&self, pid: i32) -> Option<String> {
        self.names.get(&pid).cloned()
    }
    fn cwd(&self, pid: i32) -> Option<String> {
        self.cwds.get(&pid).cloned()
    }
    fn parent(&self, pid: i32) -> Option<i32> {
        self.parents.get(&pid).copied()
    }
    fn pids(&self) -> Option<Vec<i32>> {
        (!self.down).then(|| self.parents.keys().copied().collect())
    }
    fn children(&self, pid: i32) -> Option<Vec<i32>> {
        (!self.down).then(|| {
            self.parents
                .iter()
                .filter(|&(_, &pp)| pp == pid)
                .map(|(&p, _)| p)
                .collect()
        })
    }
}

/// 1 ← 100(-zsh) ← 200(vim) ← 300, 400 은 자기 자신을 부모로 적는다.
fn tree() -> FakeKernel {
    FakeKernel {
        names: map(&[(100, "-zsh".to_owned()), (200, "/usr/bin/vim".to_owned())]),
        cwds: map(&[(100, "/tmp/work".to_owned()), (200, String::new())]),
        parents: map(&[(1, 0), (100, 1), (200, 100), (300, 200), (400, 400)]),
        down: false,
    }
}

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
fn kernel_reads_spawn_nothing() {
    let calls = AtomicUsize::new(0);
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| {
            calls.fetch_add(1, Ordering::Relaxed);
            fail()
        },
        kernel: tree(),
    };
    assert!(d.has_children(100));
    assert_eq!(
        d.children_of(&[100, 300]),
        map(&[(100, true), (300, false)])
    );
    assert_eq!(d.cwd(100).as_deref(), Some("/tmp/work"));
    assert_eq!(d.cwds(&[100]), map(&[(100, "/tmp/work".to_owned())]));
    assert_eq!(d.names(&[200]), map(&[(200, "/usr/bin/vim".to_owned())]));
    assert_eq!(d.parent_pid(200), Some(100));
    assert!(d.parents().is_some());
    assert_eq!(calls.load(Ordering::Relaxed), 0, "외부 프로세스를 띄웠다");
}

#[test]
fn kernel_answers() {
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| fail(),
        kernel: tree(),
    };
    assert!(!d.has_children(300));
    assert!(
        !d.has_children(400),
        "자기 자신을 부모로 적은 항목은 자식이 아니다"
    );
    assert!(!d.has_children(0));
    assert_eq!(
        d.children_of(&[100, 300, 400, 100, 0]),
        map(&[(100, true), (300, false), (400, false)])
    );
    assert!(d.children_of(&[0, -1]).is_empty());
    assert_eq!(d.cwd(999), None);
    assert_eq!(d.cwd(200), None, "빈 경로는 모름이다");
    assert_eq!(d.cwd(0), None);
    assert_eq!(
        d.cwds(&[100, 200, 999, 100, 0]),
        map(&[(100, "/tmp/work".to_owned())])
    );
    assert_eq!(
        d.names(&[100, 200, 999, 100, -1]),
        map(&[(100, "-zsh".to_owned()), (200, "/usr/bin/vim".to_owned())])
    );
    assert_eq!(d.parent_pid(1), None, "부모 0 은 모름이다");
    assert_eq!(d.parent_pid(999), None);
    assert_eq!(d.parent_pid(0), None);
    assert_eq!(
        d.parents(),
        Some(map(&[(1, 0), (100, 1), (200, 100), (300, 200), (400, 400)]))
    );
}

#[test]
fn kernel_down_is_unknown() {
    let d = DarwinProcInfo {
        run: |_: &str, _: &[&str]| fail(),
        kernel: FakeKernel {
            down: true,
            ..tree()
        },
    };
    assert_eq!(d.parents(), None);
    assert!(d.children_of(&[100]).is_empty());
    assert!(!d.has_children(100));
}

#[test]
fn only_connection_queries_spawn_lsof() {
    let calls = Mutex::new(Vec::<String>::new());
    let d = DarwinProcInfo {
        run: |name: &str, args: &[&str]| {
            calls
                .lock()
                .unwrap()
                .push(format!("{name} {}", args.join(" ")));
            fail()
        },
        kernel: tree(),
    };
    d.has_children(7);
    d.children_of(&[7]);
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
            "lsof -ti :58146 -sTCP:LISTEN",
            "lsof -i tcp@127.0.0.1:54321 -n -P -Fp",
            "lsof -i tcp:54321 -n -P -Fp",
        ]
    );
}

#[test]
fn listener_and_connection_owner() {
    let me = super::self_pid();
    let d = DarwinProcInfo {
        run: |name: &str, args: &[&str]| match (name, args.first(), args.get(1)) {
            ("lsof", Some(&"-ti"), _) => ok("39009\n"),
            ("lsof", _, Some(&"tcp@127.0.0.1:54321")) => ok(&format!("p{me}\np7777\n")),
            _ => fail(),
        },
        kernel: FakeKernel::default(),
    };
    assert_eq!(d.listener_pids("58146"), vec![39009]);
    assert_eq!(d.connection_owner_pid("127.0.0.1:54321"), Some(7777));
    assert_eq!(d.connection_owner_pid("주소아님"), None);
}

fn procargs(argc: i32, rest: &[u8]) -> Vec<u8> {
    let mut b = argc.to_ne_bytes().to_vec();
    b.extend_from_slice(rest);
    b
}

#[test]
fn parse_procargs_argv0_cases() {
    assert_eq!(
        parse_procargs_argv0(&procargs(2, b"/bin/zsh\0\0\0\0-zsh\0-l\0")).as_deref(),
        Some("-zsh")
    );
    assert_eq!(
        parse_procargs_argv0(&procargs(1, b"/v/2.1\0/home/u/.local/bin/claude")).as_deref(),
        Some("/home/u/.local/bin/claude")
    );
    assert_eq!(parse_procargs_argv0(&procargs(0, b"/bin/zsh\0zsh\0")), None);
    assert_eq!(parse_procargs_argv0(&procargs(1, b"/bin/zsh")), None);
    assert_eq!(parse_procargs_argv0(&procargs(1, b"/bin/zsh\0\0\0")), None);
    assert_eq!(parse_procargs_argv0(b"\x01\0"), None);
}

/// 실제 커널 값을 시스템 도구(ps·lsof)와 대조한다.
#[cfg(target_os = "macos")]
#[test]
fn libproc_matches_system_tools() {
    let k = libproc::Libproc;
    let me = super::self_pid();
    let ps = |args: &[&str]| String::from_utf8(exec_run("ps", args).stdout).unwrap();
    assert_eq!(
        k.name(me).as_deref(),
        Some(ps(&["-o", "comm=", "-p", &me.to_string()]).trim())
    );
    // SAFETY: getppid 는 메모리를 건드리지 않는다.
    let ppid = unsafe { libc::getppid() };
    assert_eq!(k.parent(me), Some(ppid));
    assert_eq!(k.parent(1), Some(0));
    let cwd = k.cwd(me).map(std::path::PathBuf::from).unwrap();
    assert_eq!(
        cwd.canonicalize().unwrap(),
        std::env::current_dir().unwrap().canonicalize().unwrap()
    );
    let pids = k.pids().unwrap();
    assert!(pids.contains(&me) && pids.contains(&ppid) && pids.contains(&1));
    assert!(k.children(ppid).unwrap().contains(&me));
    assert_eq!(k.parent(i32::MAX), None);
    assert_eq!(k.cwd(i32::MAX), None);
    assert_eq!(k.name(i32::MAX), None);
    assert_eq!(k.children(i32::MAX), Some(Vec::new()));
}
