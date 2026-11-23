//! Go 노드와 짝 맺기·지우기·간선 연결이 서로 되는가 (FR-RSP-23). 진짜 Go 바이너리를 격리 홈에서 띄운다.
//!
//! `DM_PARITY_GO_BIN` 이 없으면 건너뛴다:
//! `rust/scripts/hermetic.sh env DM_PARITY_GO_BIN=$PWD/rust/target/go-ref/dongminal cargo test -p dm-shared-edgenode --test go_interop`

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use dm_gocompat::json::{self, RawMessage};
use dm_shared_edge::{Config, Listener};
use dm_shared_edgenode::{Node, OpRequest, Options};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const PORT_MIN: u16 = 60147;
const PORT_MAX: u16 = 64999;
const STARTUP: Duration = Duration::from_secs(40);
const WAIT: Duration = Duration::from_secs(20);

fn free_port(taken: &[u16]) -> u16 {
    let span = PORT_MAX - PORT_MIN;
    let start = rand::random::<u16>() % span;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .expect("빈 포트가 없다")
}

/// 띄운 Go 서버와 그 데몬이다. 이 시험이 띄운 PID 만 끈다.
struct GoNode {
    child: Child,
    home: PathBuf,
    bin: PathBuf,
    ui_port: u16,
}

impl GoNode {
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
        String::from_utf8_lossy(&out.stdout)
            .contains(self.bin.to_string_lossy().as_ref())
            .then_some(pid)
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.home.join("go-start.log")).unwrap_or_default()
    }

    /// Go 서버의 로컬 API 를 부른다. (상태, 본문) 이다.
    async fn api(&self, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", self.ui_port))
            .await
            .unwrap();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.ui_port,
            body.len()
        );
        c.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        c.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).into_owned();
        let status = text
            .split(' ')
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        (status, body)
    }
}

impl Drop for GoNode {
    fn drop(&mut self) {
        let daemon = self.daemon_pid();
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let _ = self.child.wait();
        if let Some(pid) = daemon {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
    }
}

fn start_go(bin: &Path, home: &Path, ui_port: u16) -> GoNode {
    let log = std::fs::File::create(home.join("go-start.log")).unwrap();
    let mut cmd = Command::new(bin);
    for (k, _) in std::env::vars().filter(|(k, _)| k.starts_with("DONGMINAL_")) {
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
        .env("DONGMINAL_HOME", home)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    GoNode {
        child,
        home: home.to_path_buf(),
        bin: bin.to_path_buf(),
        ui_port,
    }
}

async fn until(what: &str, go: &GoNode, mut cond: impl AsyncFnMut() -> bool) {
    let end = Instant::now() + WAIT;
    while Instant::now() < end {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("{what}: 시간 안에 이뤄지지 않았다\n{}", go.log());
}

fn field(body: &str, k: &str) -> String {
    let m: BTreeMap<String, RawMessage> = json::unmarshal(body.as_bytes()).unwrap_or_default();
    m.get(k)
        .and_then(|v| json::unmarshal::<String>(&v.0).ok())
        .unwrap_or_default()
}

/// Go `/api/edges` 의 간선 하나(지문 fp)다. 없으면 `None`.
async fn go_edge(go: &GoNode, fp: &str) -> Option<BTreeMap<String, RawMessage>> {
    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct V {
        edges: Vec<BTreeMap<String, RawMessage>>,
    }
    let (_, body) = go.api("GET", "/api/edges", "").await;
    let v: V = json::unmarshal(body.as_bytes()).unwrap_or_default();
    v.edges.into_iter().find(|e| {
        e.get("fp")
            .is_some_and(|x| x.0 == format!("\"{fp}\"").into_bytes())
    })
}

async fn rust_op(n: &Node, op: &str, args: &str) -> dm_shared_edgenode::OpResponse {
    n.do_op(OpRequest {
        op: op.into(),
        args: args.as_bytes().to_vec(),
        if_match: String::new(),
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_and_go_nodes_pair_and_link() {
    let Some(bin) = std::env::var_os("DM_PARITY_GO_BIN").map(PathBuf::from) else {
        eprintln!("DM_PARITY_GO_BIN 이 없어 건너뛴다");
        return;
    };
    let root = tempfile::Builder::new()
        .prefix("dmn")
        .tempdir_in("/tmp")
        .unwrap();
    let (go_home, rust_home) = (root.path().join("g"), root.path().join("r"));
    std::fs::create_dir_all(&go_home).unwrap();
    std::fs::create_dir_all(&rust_home).unwrap();
    let ui = free_port(&[]);
    let go_port = free_port(&[ui]);
    let rust_port = free_port(&[ui, go_port]);
    let cfg = |name: &str, port: u16| Config {
        enabled: true,
        port: i64::from(port),
        bind: "127.0.0.1".into(),
        name: name.into(),
        advertise: "127.0.0.1".into(),
        edges: Vec::new(),
    };
    std::fs::write(
        go_home.join("edges.json"),
        json::marshal(&cfg("gonode", go_port)).unwrap(),
    )
    .unwrap();
    std::fs::write(
        rust_home.join("edges.json"),
        json::marshal(&cfg("rustnode", rust_port)).unwrap(),
    )
    .unwrap();

    // Rust 노드: 간선 계층을 세우고 자기 노드 포트를 듣는다.
    let ln: Arc<OnceLock<Listener>> = Arc::default();
    let (l1, l2) = (ln.clone(), ln.clone());
    let node = Node::new(Options {
        home: rust_home.clone(),
        hostname: "rustnode".into(),
        mesh: true,
        port_status: Some(Arc::new(move || {
            l1.get().map(Listener::status).unwrap_or_default()
        })),
        on_config: Some(Arc::new(move |c: &Config| {
            if let Some(l) = l2.get() {
                l.apply(c);
            }
        })),
        ..Options::default()
    })
    .unwrap();
    let l = Listener::new(node.identity(), node.admission(), node.handler()).unwrap();
    l.apply(&node.config());
    assert!(l.status().listening);
    let _ = ln.set(l);
    let cancel = CancellationToken::new();
    let n2 = node.clone();
    let c2 = cancel.clone();
    tokio::spawn(async move { n2.run(c2).await });

    let go = start_go(&bin, &go_home, ui);
    let end = Instant::now() + STARTUP;
    while tokio::net::TcpStream::connect(("127.0.0.1", go_port))
        .await
        .is_err()
    {
        assert!(
            Instant::now() < end,
            "Go 노드 포트가 열리지 않았다\n{}",
            go.log()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let go_fp = dm_shared_edge::load_or_create_identity(&go_home)
        .unwrap()
        .fingerprint;
    let rust_fp = node.identity().fingerprint.clone();

    // ① Rust 가 초대하고 Go 가 받는다.
    let inv = rust_op(&node, "invite", "{}").await;
    let code = field(&String::from_utf8_lossy(&inv.body), "code");
    let (st, body) = go
        .api("POST", "/api/edges/add", &format!(r#"{{"code":"{code}"}}"#))
        .await;
    assert_eq!(st, 200, "Go add: {body}\n{}", go.log());
    assert!(
        node.store().is_edge(&go_fp),
        "Rust 가 Go 를 간선으로 모른다"
    );
    assert_eq!(node.store().resolve(&go_fp).unwrap().name, "gonode");
    assert!(
        go_edge(&go, &rust_fp).await.is_some(),
        "Go 가 Rust 를 간선으로 모른다"
    );

    // 간선 연결: Rust 가 알리고(notify) 연결이 서며 hello 가 오간다.
    let r = rust_op(&node, "notify", &format!(r#"{{"fp":"{go_fp}"}}"#)).await;
    assert_eq!(r.status, 200, "notify: {r:?}\n{}", go.log());
    until("Rust 가 Go 와 연결됐다", &go, async || {
        node.mesh().is_some_and(|m| m.linked(&go_fp))
    })
    .await;
    rust_op(&node, "profile_name", r#"{"name":"rust2"}"#).await;
    until("Go 가 Rust 의 새 이름을 안다", &go, async || {
        go_edge(&go, &rust_fp)
            .await
            .and_then(|e| e.get("name").map(|v| v.0 == b"\"rust2\"".to_vec()))
            == Some(true)
    })
    .await;

    // Rust 가 지우면 Go 도 지운다.
    let r = rust_op(&node, "remove", &format!(r#"{{"fp":"{go_fp}"}}"#)).await;
    assert_eq!(r.status, 200, "remove: {r:?}");
    assert!(
        String::from_utf8_lossy(&r.body).contains(r#""notified":true"#),
        "{r:?}"
    );
    until("Go 가 Rust 를 지웠다", &go, async || {
        go_edge(&go, &rust_fp).await.is_none()
    })
    .await;

    // ② Go 가 초대하고 Rust 가 받는다.
    let (st, body) = go.api("POST", "/api/edges/invite", "{}").await;
    assert_eq!(st, 200, "Go invite: {body}");
    let code = field(&body, "code");
    let r = rust_op(&node, "add", &format!(r#"{{"code":"{code}"}}"#)).await;
    assert_eq!(r.status, 200, "Rust add: {r:?}\n{}", go.log());
    assert!(node.store().is_edge(&go_fp));
    assert!(
        go_edge(&go, &rust_fp).await.is_some(),
        "Go 가 Rust 를 간선으로 모른다(②)"
    );
    // Go 가 알리면 Go 데몬이 Rust 노드 포트로 간선 연결을 건다.
    let (st, body) = go
        .api(
            "POST",
            "/api/edges/notify",
            &format!(r#"{{"fp":"{rust_fp}"}}"#),
        )
        .await;
    assert_eq!(st, 200, "Go notify: {body}\n{}", go.log());
    until("Go 가 건 연결이 Rust 에 붙었다", &go, async || {
        node.mesh().is_some_and(|m| m.linked(&go_fp))
    })
    .await;

    cancel.cancel();
    node.close();
    if let Some(l) = ln.get() {
        l.close();
    }
    drop(go);
}
