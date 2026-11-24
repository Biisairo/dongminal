//! Go 노드와 TLS 로 서로 잇는가 (RUST_PORT_SRS FR-RSP-23). 진짜 Go 바이너리를 격리 홈에서 띄운다.
//!
//! `OTTER_PARITY_GO_BIN` 이 없으면 건너뛴다. 격리 실행으로 돌린다:
//! `rust/scripts/hermetic.sh env OTTER_GO_REF_SRC=<main 의 worktree> rust/scripts/go-ref.sh rust/target/go-ref/otterminal ./cmd/otterminal`
//! `rust/scripts/hermetic.sh env OTTER_PARITY_GO_BIN=$PWD/rust/target/go-ref/otterminal cargo test -p otter-shared-edge --test go_interop`

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::StatusCode;
use otter_shared_edge::{
    CallError, Client, Config, Edge, Handler, Listener, Target, accept_upgrade, edges_only,
    load_or_create_identity,
};
use tokio::io::AsyncReadExt;

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;
const STARTUP: Duration = Duration::from_secs(40);
const LINK_PATH: &str = "/edge/v1/link";
const LINK_PROTO: &str = "dmlink1";

fn free_port(taken: &[u16]) -> u16 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다")
}

/// 띄운 Go 서버와 그 데몬을 끝에 끈다. 이 시험이 띄운 PID 만 끈다.
struct GoNode {
    child: Child,
    home: PathBuf,
    bin: PathBuf,
}

impl GoNode {
    fn stop_pid(&self, pid: u32) {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    fn daemon_pid(&self) -> Option<u32> {
        let pid: u32 = std::fs::read_to_string(self.home.join("paned.pid"))
            .ok()?
            .trim()
            .parse()
            .ok()?;
        let out = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        let cmd = String::from_utf8_lossy(&out.stdout);
        cmd.contains(self.bin.to_string_lossy().as_ref())
            .then_some(pid)
    }
}

impl Drop for GoNode {
    fn drop(&mut self) {
        let daemon = self.daemon_pid();
        self.stop_pid(self.child.id());
        let _ = self.child.wait();
        if let Some(pid) = daemon {
            self.stop_pid(pid);
        }
    }
}

fn start_go(bin: &Path, home: &Path, ui_port: u16) -> GoNode {
    let log = std::fs::File::create(home.join("go-start.log")).unwrap();
    let mut cmd = Command::new(bin);
    for (k, _) in std::env::vars().filter(|(k, _)| k.starts_with("OTTERMINAL_")) {
        cmd.env_remove(k);
    }
    let child = cmd
        .args([
            "start",
            "--foreground",
            "--port",
            &ui_port.to_string(),
            "--home",
            &home.to_string_lossy(),
        ])
        .env("HOME", home)
        .env("OTTERMINAL_HOME", home)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    GoNode {
        child,
        home: home.to_path_buf(),
        bin: bin.to_path_buf(),
    }
}

async fn wait_dialable(port: u16, home: &Path) {
    let end = Instant::now() + STARTUP;
    while Instant::now() < end {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let log = std::fs::read_to_string(home.join("go-start.log")).unwrap_or_default();
    panic!("Go 노드 포트 {port} 가 열리지 않았다\n{log}");
}

#[derive(Debug, Clone)]
struct Seen {
    fp: String,
    path: String,
    upgraded: bool,
}

#[tokio::test]
async fn rust_and_go_nodes_connect_over_tls() {
    let Some(bin) = std::env::var_os("OTTER_PARITY_GO_BIN").map(PathBuf::from) else {
        eprintln!("OTTER_PARITY_GO_BIN 이 없어 건너뛴다");
        return;
    };
    // 소켓 경로 길이 상한 때문에 짧은 뿌리를 쓴다.
    let root = tempfile::Builder::new()
        .prefix("ottere")
        .tempdir_in("/tmp")
        .unwrap();
    let go_home = root.path().join("g");
    let rust_home = root.path().join("r");
    let stranger_home = root.path().join("s");
    for d in [&go_home, &rust_home, &stranger_home] {
        std::fs::create_dir_all(d).unwrap();
    }
    let ui_port = free_port(&[]);
    let go_port = free_port(&[ui_port]);
    let rust_port = free_port(&[ui_port, go_port]);

    // Go 노드의 신원은 Rust 가 만든다 — Go 가 Rust 의 인증서·키 파일을 읽는지도 본다.
    let go_id = load_or_create_identity(&go_home).unwrap();
    let rust_id = load_or_create_identity(&rust_home).unwrap();
    let stranger = load_or_create_identity(&stranger_home).unwrap();
    let edges = Config {
        enabled: true,
        port: i64::from(go_port),
        bind: "127.0.0.1".into(),
        name: "gonode".into(),
        advertise: String::new(),
        edges: vec![Edge {
            name: "rustnode".into(),
            addr: "127.0.0.1".into(),
            port: i64::from(rust_port),
            fingerprint: rust_id.fingerprint.clone(),
            ..Edge::default()
        }],
    };
    std::fs::write(
        go_home.join("edges.json"),
        otter_gocompat::json::marshal_indent(&edges, "", "  ").unwrap(),
    )
    .unwrap();

    // Rust 리스너: Go 지문만 들이고, 받은 요청을 적는다. 간선 연결(Upgrade)은 받아 쥔다.
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let s = seen.clone();
    let h: Handler = Arc::new(move |mut req| {
        let s = s.clone();
        Box::pin(async move {
            let fp = otter_shared_edge::client_fingerprint(&req).to_string();
            let path = req.uri().path().to_string();
            let (resp, pending) = accept_upgrade(&mut req, LINK_PROTO);
            s.lock().unwrap().push(Seen {
                fp,
                path,
                upgraded: pending.is_some(),
            });
            if let Some(p) = pending {
                tokio::spawn(async move {
                    if let Ok(mut c) = p.conn().await {
                        let mut buf = [0u8; 4096];
                        while matches!(c.read(&mut buf).await, Ok(n) if n > 0) {}
                    }
                });
            }
            resp
        })
    });
    let go_fp = go_id.fingerprint.clone();
    let ln = Listener::new(&rust_id, edges_only(move |fp| fp == go_fp), h).unwrap();
    ln.apply(&Config {
        enabled: true,
        bind: "127.0.0.1".into(),
        port: i64::from(rust_port),
        ..Config::default()
    });
    assert!(ln.status().listening, "{:?}", ln.status());

    let go = start_go(&bin, &go_home, ui_port);
    wait_dialable(go_port, &go_home).await;

    // ① Rust 클라이언트 → Go 노드 포트. 간선이면 HTTP 응답(403 거절이 아님)을 받는다.
    let target = Target {
        addr: "127.0.0.1".into(),
        port: i64::from(go_port),
        fingerprint: go_id.fingerprint.clone(),
    };
    let got = Client::new(rust_id.clone())
        .call_raw(&target, "/edge/v1/x", &())
        .await;
    match &got {
        Ok(_) => {}
        Err(CallError::Remote(re)) => assert_ne!(re.status, StatusCode::FORBIDDEN.as_u16(), "{re}"),
        Err(e) => panic!("Go 노드가 간선 Rust 를 받지 않았다: {e}"),
    }
    // 간선이 아닌 Rust 신원: Go 노드는 짝 맺기 때문에 TLS 단계는 들이고 요청 단계에서 거른다 (I-1).
    let stranger_err = Client::new(stranger)
        .call_raw(&target, "/edge/v1/x", &())
        .await
        .unwrap_err();
    assert_eq!(
        stranger_err.to_string(),
        "상대 노드가 거절했습니다 (403 edge_not_edge): 간선이 아닌 노드입니다"
    );
    // 지문이 다르면 아무것도 보내지 않는다.
    let mut wrong = target.clone();
    wrong.fingerprint = rust_id.fingerprint.clone();
    assert_eq!(
        Client::new(rust_id.clone())
            .call_raw(&wrong, "/edge/v1/x", &())
            .await,
        Err(CallError::FingerprintMismatch)
    );

    // ② Go 데몬 → Rust 리스너. 간선 연결(GET /edge/v1/link, Upgrade: dmlink1)을 Go 지문으로 건다.
    let end = Instant::now() + STARTUP;
    let link = loop {
        let hit = seen
            .lock()
            .unwrap()
            .iter()
            .find(|x| x.path == LINK_PATH)
            .cloned();
        if let Some(x) = hit {
            break x;
        }
        if Instant::now() > end {
            let log = std::fs::read_to_string(go_home.join("go-start.log")).unwrap_or_default();
            panic!(
                "Go 의 간선 연결이 오지 않았다: {:?}\n{log}",
                seen.lock().unwrap()
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(link.fp, go_id.fingerprint);
    assert!(link.upgraded, "{link:?}");
    ln.close();
    drop(go);
}
