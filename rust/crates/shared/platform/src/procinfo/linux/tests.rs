use std::collections::{BTreeSet, HashMap};

use super::*;

/// 가짜 /proc. 디렉터리는 파일·링크 경로에서 저절로 생긴다.
#[derive(Default)]
struct FakeFs {
    files: HashMap<String, String>,
    links: HashMap<String, String>,
}

impl FakeFs {
    fn new(files: &[(&str, &str)], links: &[(&str, &str)]) -> Self {
        let own = |v: &[(&str, &str)]| {
            v.iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        FakeFs {
            files: own(files),
            links: own(links),
        }
    }

    fn info(self) -> LinuxProcInfo<FakeFs> {
        LinuxProcInfo { fs: self }
    }

    fn all(&self) -> impl Iterator<Item = &String> {
        self.files.keys().chain(self.links.keys())
    }
}

fn not_found() -> io::Error {
    io::Error::from(io::ErrorKind::NotFound)
}

impl ProcFs for FakeFs {
    fn read(&self, p: &str) -> io::Result<Vec<u8>> {
        self.files
            .get(p)
            .map(|s| s.as_bytes().to_vec())
            .ok_or_else(not_found)
    }
    fn read_link(&self, p: &str) -> io::Result<String> {
        self.links.get(p).cloned().ok_or_else(not_found)
    }
    fn list(&self, dir: &str) -> io::Result<Vec<String>> {
        let prefix = format!("{dir}/");
        let names: BTreeSet<String> = self
            .all()
            .filter_map(|p| p.strip_prefix(&prefix))
            .map(|rest| rest.split('/').next().unwrap_or("").to_owned())
            .collect();
        if names.is_empty() {
            return Err(not_found());
        }
        Ok(names.into_iter().collect())
    }
    fn exists(&self, p: &str) -> bool {
        let prefix = format!("{p}/");
        self.all().any(|k| k == p || k.starts_with(&prefix))
    }
}

const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:E322 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55501 1 ffff 100 0 0 10 0
   1: 0100007F:E322 0100007F:C1B2 01 00000000:00000000 00:00000000  00000000  1000        0 55502 1 ffff 100 0 0 10 0
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55503 1 ffff 100 0 0 10 0
";

#[test]
fn tcp_inodes() {
    assert_eq!(
        parse_tcp_inodes(TCP, 58146, TCP_LISTEN_STATE),
        ["55501"],
        "ESTABLISHED(01) 를 함께 잡았다"
    );
    assert_eq!(parse_tcp_inodes(TCP, 8080, TCP_LISTEN_STATE), ["55503"]);
    assert!(parse_tcp_inodes(TCP, 9999, TCP_LISTEN_STATE).is_empty());
    assert_eq!(parse_tcp_inodes(TCP, 58146, ""), ["55501", "55502"]);
}

#[test]
fn socket_inode_and_pid_from_fd() {
    assert_eq!(socket_inode("socket:[55501]"), Some("55501"));
    assert_eq!(socket_inode("socket:[]"), None);
    assert_eq!(socket_inode("/dev/null"), None);
    assert_eq!(pid_from_fd_path("/proc/4321/fd/7"), Some(4321));
    assert_eq!(pid_from_fd_path("/tmp/x"), None);
}

#[test]
fn stat_ppid() {
    for (name, content, want) in [
        ("평범", "4321 (zsh) S 1234 4321 4321 34816 ...", Some(1234)),
        ("이름에 공백", "10 (Web Content) S 7 10 10 0 ...", Some(7)),
        ("이름에 괄호", "11 (a (b) c) S 9 11 11 0 ...", Some(9)),
        ("쓰레기", "no parens here", None),
        ("열 부족", "1 (init) S", None),
    ] {
        assert_eq!(parse_stat_ppid(content), want, "{name}");
    }
}

#[test]
fn glob_matching() {
    assert!(glob_match(b"[0-9]*", b"100"));
    assert!(!glob_match(b"[0-9]*", b"self"));
    assert!(glob_match(b"*", b""));
    assert!(glob_match(b"a?c", b"abc"));
    assert!(!glob_match(b"[^0-9]", b"5"));
}

#[test]
fn has_children() {
    let li = FakeFs::new(
        &[
            ("/proc/100/task/100/children", "101 102\n"),
            ("/proc/200/task/200/children", "\n"),
        ],
        &[],
    )
    .info();
    assert!(li.has_children(100));
    assert!(!li.has_children(200));
    assert!(!li.has_children(999));
    assert!(!li.has_children(0));
}

#[test]
fn has_children_across_threads() {
    let li = FakeFs::new(
        &[
            ("/proc/100/task/100/children", "\n"),
            ("/proc/100/task/113/children", "150\n"),
        ],
        &[],
    )
    .info();
    assert!(li.has_children(100), "두 번째 스레드의 자식을 놓쳤다");
    assert_eq!(li.children_of(&[100, 0, 100]), HashMap::from([(100, true)]));
}

#[test]
fn cwd_and_names() {
    let li = FakeFs::new(
        &[("/proc/100/comm", "zsh\n"), ("/proc/101/comm", "  \n")],
        &[("/proc/100/cwd", "/home/u/work")],
    )
    .info();
    assert_eq!(li.cwd(100).as_deref(), Some("/home/u/work"));
    assert_eq!(li.cwd(999), None);
    assert_eq!(
        li.names(&[100, 101, 999, 100]),
        HashMap::from([(100, "zsh".to_owned())])
    );
}

#[test]
fn listener_pids() {
    let li = FakeFs::new(
        &[
            (
                "/proc/net/tcp",
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:E322 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 55501 1 ffff\n",
            ),
            ("/proc/net/tcp6", "sl local rem st q q tr tm re uid to inode\n"),
        ],
        &[
            ("/proc/4321/fd/7", "socket:[55501]"),
            ("/proc/4321/fd/8", "socket:[55501]"),
            ("/proc/9999/fd/3", "socket:[70000]"),
            ("/proc/9999/fd/4", "/dev/null"),
            ("/proc/1/task/1/x", "noise"),
        ],
    )
    .info();
    assert_eq!(li.listener_pids("58146"), vec![4321]);
    assert!(li.listener_pids("1").is_empty());
    assert!(li.listener_pids("포트아님").is_empty());
    assert!(li.listener_pids("70000").is_empty());
}

#[test]
fn listener_pids_in_glob_order() {
    let li = FakeFs::new(
        &[(
            "/proc/net/tcp",
            "h\n 0: 0100007F:E322 00000000:0000 0A 0:0 0:0 0 1000 0 1 1 f\n",
        )],
        &[
            ("/proc/900/fd/1", "socket:[1]"),
            ("/proc/1000/fd/1", "socket:[1]"),
            ("/proc/20/fd/1", "socket:[1]"),
        ],
    )
    .info();
    // Go filepath.Glob 은 이름의 바이트 순서다: "1000" < "20" < "900".
    assert_eq!(li.listener_pids("58146"), vec![1000, 20, 900]);
}

#[test]
fn parent_pid() {
    let li = FakeFs::new(
        &[(
            "/proc/4321/stat",
            "4321 (zsh) S 1234 4321 4321 34816 4321 0 0",
        )],
        &[],
    )
    .info();
    assert_eq!(li.parent_pid(4321), Some(1234));
    assert_eq!(li.parent_pid(999), None);
}

#[test]
fn parents() {
    let li = FakeFs::new(
        &[
            ("/proc/100/stat", "100 (zsh) S 1 100 100 0"),
            ("/proc/101/stat", "101 (my (odd) name) S 100 101 100 0"),
            ("/proc/self/stat", "7 (x) S 1"),
            ("/proc/102/status", "Name: x"),
        ],
        &[],
    )
    .info();
    assert_eq!(li.parents(), Some(HashMap::from([(100, 1), (101, 100)])));
    assert_eq!(FakeFs::default().info().parents(), Some(HashMap::new()));
}

#[test]
fn cwds_reads_each_link() {
    let li = FakeFs::new(
        &[],
        &[("/proc/100/cwd", "/tmp/a"), ("/proc/200/cwd", "/tmp/b")],
    )
    .info();
    assert_eq!(
        li.cwds(&[100, 200, 300]),
        HashMap::from([(100, "/tmp/a".to_owned()), (200, "/tmp/b".to_owned())])
    );
}

#[test]
fn connection_owner_pid() {
    let li = FakeFs::new(
        &[(
            "/proc/net/tcp",
            "  sl  local_address rem_address   st ...\n   0: 0100007F:D431 0100007F:E322 01 00000000:00000000 00:00000000  00000000  1000        0 66601 1 ffff\n",
        )],
        &[("/proc/7777/fd/9", "socket:[66601]")],
    )
    .info();
    assert_eq!(li.connection_owner_pid("127.0.0.1:54321"), Some(7777));
    assert_eq!(li.connection_owner_pid("주소아님"), None);
}
