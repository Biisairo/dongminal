//! Go 노드와 간선 계층(mesh)으로 서로 잇는가 (RUST_PORT_SRS FR-RSP-23, V-RSP-4). hello·net 서명
//! 확인·Go 노드가 넘겨 준 net·초대 상자(ECDH·HKDF·AES-GCM)를 양쪽으로 시험한다.
//!
//! `OTTER_PARITY_GO_MESHPEER` 가 없으면 건너뛴다. 격리 실행으로 돌린다:
//! `rust/scripts/hermetic.sh env OTTER_GO_REF_SRC=<main 의 worktree> rust/scripts/go-ref.sh rust/target/go-ref/meshpeer rust/crates/shared/edgemesh/testdata/gopeer`
//! `rust/scripts/hermetic.sh env OTTER_PARITY_GO_MESHPEER=$PWD/rust/target/go-ref/meshpeer cargo test --manifest-path rust/Cargo.toml -p otter-shared-edgemesh --test go_interop`

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use otter_shared_edge::{
    INVITE_TTL, InviteCode, decode_invite, encode_invite, load_or_create_identity,
};
use otter_shared_edgemesh::{Conn, Hello, Invite, Mesh, Options};
use time::OffsetDateTime;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;
const WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);
const RUST_NAME: &str = "r<&>é";

fn free_port() -> u16 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다")
}

/// 띄운 Go 피어다. 끝에 이 시험이 띄운 PID 만 끈다.
struct GoPeer {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl GoPeer {
    async fn cmd(&mut self, line: &str) {
        self.stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        self.stdin.flush().await.unwrap();
    }

    /// pred 를 만족하는 줄이 올 때까지 읽는다.
    async fn expect(&mut self, what: &str, pred: impl Fn(&str) -> bool) -> String {
        let r = tokio::time::timeout(WAIT, async {
            while let Some(l) = self.lines.next_line().await.unwrap() {
                if pred(&l) {
                    return Some(l);
                }
            }
            None
        })
        .await;
        match r {
            Ok(Some(l)) => l,
            _ => panic!("Go 피어에게서 오지 않았다: {what}"),
        }
    }

    /// 명령 nodes 의 답에 want 가 들 때까지 되묻는다.
    async fn wait_nodes(&mut self, who: &str, want: &str) {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            self.cmd(&format!("nodes {who}")).await;
            let l = self
                .expect("nodes", |l| l.starts_with(&format!("nodes {who} ")))
                .await;
            if l.contains(want) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Go {who} 가 {want} 를 모른다: {l}"
            );
            tokio::time::sleep(POLL).await;
        }
    }
}

impl Drop for GoPeer {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn eventually(what: &str, cond: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !cond() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "시간 안에 이루어지지 않았다: {what}"
        );
        tokio::time::sleep(POLL).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_and_go_meshes_interoperate() {
    let Some(bin) = std::env::var_os("OTTER_PARITY_GO_MESHPEER").map(PathBuf::from) else {
        eprintln!("OTTER_PARITY_GO_MESHPEER 가 없어 건너뛴다");
        return;
    };
    let dir = tempfile::TempDir::new().unwrap();
    let rdir = dir.path().join("rust");
    std::fs::create_dir_all(&rdir).unwrap();
    let id = load_or_create_identity(&rdir).unwrap();
    let rfp = id.fingerprint.clone();

    let hellos: Arc<Mutex<Vec<(String, Hello)>>> = Arc::default();
    let invites: Arc<Mutex<Vec<Invite>>> = Arc::default();
    let mut o = Options::new(id);
    o.name = Some(Arc::new(|| RUST_NAME.to_string()));
    let h = hellos.clone();
    o.on_hello = Some(Arc::new(move |fp, hello, _| {
        h.lock().unwrap().push((fp.to_string(), hello));
    }));
    let i = invites.clone();
    o.on_invite = Some(Arc::new(move |inv| i.lock().unwrap().push(inv)));
    let r = Mesh::new(o);

    let port = free_port();
    let mut child = Command::new(&bin)
        .args([
            "-port",
            &port.to_string(),
            "-peer",
            &rfp,
            "-dir",
            &dir.path().join("go").to_string_lossy(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut go = GoPeer {
        stdin: child.stdin.take().unwrap(),
        lines: BufReader::new(child.stdout.take().unwrap()).lines(),
        child,
    };
    let ready = go.expect("ready", |l| l.starts_with("ready ")).await;
    let f: Vec<&str> = ready.split_whitespace().collect();
    let (g1, g2) = (f[1].to_string(), f[2].to_string());

    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    r.attach(&g1, Conn::new(Box::new(tcp)), true);

    // hello 를 서로 받는다 (FR-EGM-20).
    go.expect("Go g1 이 Rust hello 를 받는다", |l| {
        l == format!("hello g1 {rfp} {:?}  0", RUST_NAME)
    })
    .await;
    eventually("Rust 가 g1 hello 를 받는다", || {
        hellos.lock().unwrap().iter().any(|(fp, h)| {
            *fp == g1
                && *h
                    == Hello {
                        name: "g1<&>".into(),
                        addr: "10.9.9.9".into(),
                        port: 7777,
                    }
        })
    })
    .await;

    // Go 서명 net 을 Rust 가 받고, g1 이 넘겨 준 g2 의 net 도 받는다 (FR-EGM-10·11).
    eventually("Rust 가 g1·g2 를 온라인으로 안다", || {
        let n = r.nodes();
        n.iter()
            .any(|x| x.fp == g1 && x.online && x.name == "g1<&>")
            && n.iter().any(|x| x.fp == g2 && x.online && x.name == "g2")
    })
    .await;
    assert!(r.mutual(&g1, &g2));

    // Rust 서명 net 이 g1 을 거쳐(Go 가 다시 부호화해) g2 에 닿아 서명 확인을 지난다.
    go.wait_nodes("g2", &format!("{rfp}={RUST_NAME:?}/true"))
        .await;

    // Rust → Go: g1 을 거쳐 g2 만 연다 (FR-EGM-32~34).
    let code = encode_invite(&InviteCode {
        addr: "10.0.0.1".into(),
        port: 7001,
        fingerprint: rfp.clone(),
        token: "rtok".into(),
    });
    r.send_invite(&g2, &code, OffsetDateTime::now_utc() + INVITE_TTL)
        .unwrap();
    go.expect("Go g2 가 Rust 초대를 연다", |l| {
        l == format!("invite g2 {rfp} {:?} {code}", RUST_NAME)
    })
    .await;

    // Go → Rust: g2 가 g1 을 거쳐 보낸 초대를 Rust 가 연다.
    go.cmd(&format!("invite g2 {rfp}")).await;
    let sent = go.expect("sent", |l| l.starts_with("sent g2 ")).await;
    assert!(sent.starts_with("sent g2 <nil> "), "{sent}");
    let go_code = sent.rsplit(' ').next().unwrap().to_string();
    eventually("Rust 가 Go 초대를 연다", || {
        invites
            .lock()
            .unwrap()
            .iter()
            .any(|inv| inv.from == g2 && inv.name == "g2" && inv.code == go_code)
    })
    .await;
    assert_eq!(decode_invite(&go_code).unwrap().fingerprint, g2);

    // Go → Rust 직접 이웃(g1) 초대도 연다.
    go.cmd(&format!("invite g1 {rfp}")).await;
    go.expect("sent", |l| l.starts_with("sent g1 <nil> ")).await;
    eventually("Rust 가 g1 초대를 연다", || {
        invites.lock().unwrap().iter().any(|inv| inv.from == g1)
    })
    .await;

    r.close();
    go.wait_nodes("g2", &format!("{rfp}={RUST_NAME:?}/false"))
        .await;
}
