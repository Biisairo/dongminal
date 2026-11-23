use std::fs;

use dm_gocompat::json;
use tempfile::TempDir;

use super::*;

fn rep(s: &str, n: usize) -> String {
    s.repeat(n)
}

fn fp_rep(b: &str) -> String {
    b.repeat(32)
}

/// pairing_simple_test.go `fpOf`: 앞자리 뒤를 0 으로 채운 64자리.
fn fp_of(prefix: &str) -> String {
    format!("{prefix}{}", "0".repeat(64 - prefix.len()))
}

fn new_store() -> (TempDir, Store) {
    let d = TempDir::new().unwrap();
    let s = Store::open(d.path().join(dmenv::EDGES_FILE), "host-a");
    (d, s)
}

fn edge(name: &str, addr: &str, port: i64, fp: &str) -> Edge {
    Edge {
        name: name.into(),
        addr: addr.into(),
        port,
        fingerprint: fp.into(),
        ..Edge::default()
    }
}

#[test]
fn valid_name_cases() {
    let long = rep("x", NAME_MAX_LEN);
    let ko = rep("가", 21);
    for n in ["office", "a", "A_b-1", "동민", "동민_맥북-2", &long, &ko] {
        assert_eq!(valid_name(n), Ok(()), "{n}");
    }
    let long = rep("x", NAME_MAX_LEN + 1);
    let ko = rep("가", 22);
    for n in [
        "", &long, &ko, "a b", "a/b", "a#b", "a.b", "ㄱ", "ㅏ", "a:b", "office\n", "é",
    ] {
        assert_eq!(valid_name(n), Err(Error::InvalidName), "{n:?}");
    }
}

#[test]
fn default_name_cases() {
    for (i, w) in [
        ("Mac-Pro.local", "Mac-Pro-local"),
        ("my host!", "my-host-"),
        ("한글pc", "한글pc"),
        ("", "node"),
    ] {
        assert_eq!(default_name(i), w);
    }
    let long = default_name(&rep("y", 40));
    assert_eq!(long.len(), NAME_MAX_LEN);
    assert_eq!(valid_name(&long), Ok(()));
    assert_eq!(default_name(&rep("가", 30)), rep("가", 21));
}

#[test]
fn open_store_defaults() {
    let (_d, s) = new_store();
    let c = s.config();
    assert!(!c.enabled);
    assert_eq!((c.port, DEFAULT_PORT), (58147, 58147));
    assert_eq!(c.bind, "0.0.0.0");
    assert_eq!(c.name, "host-a");
    assert!(c.advertise.is_empty() && c.edges.is_empty());
    assert!(!s.path().exists(), "열기만 했는데 파일이 생겼다");
}

#[test]
fn open_store_moves_broken_file() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    let broken = br#"{"enabled": true, "edges": ["#;
    fs::write(&path, broken).unwrap();
    let s = Store::open(&path, "host-a");
    let c = s.config();
    assert!(
        !c.enabled && c.edges.is_empty() && c.name == "host-a",
        "{c:?}"
    );
    assert!(!path.exists());
    let bad: Vec<_> = fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("edges.json.bad-")
        })
        .collect();
    assert_eq!(bad.len(), 1, "{bad:?}");
    let stamp =
        &bad[0].file_name().unwrap().to_string_lossy()["edges.json.bad-".len()..].to_string();
    assert_eq!(stamp.len(), "20060102T150405.000000000Z".len(), "{stamp}");
    assert_eq!(fs::read(&bad[0]).unwrap(), broken);
    let mut c = s.config();
    c.name = "host-b".into();
    s.save(c).unwrap();
    assert_eq!(fs::read(&bad[0]).unwrap(), broken);
}

#[test]
fn save_and_reload() {
    let (_d, s) = new_store();
    let mut c = s.config();
    c.enabled = true;
    c.port = 60001;
    c.bind = "127.0.0.1".into();
    c.name = "office".into();
    c.advertise = "office.example".into();
    c.edges = vec![edge("home", "10.0.0.2", 58147, &fp_rep("ab"))];
    s.save(c.clone()).unwrap();
    let got = Store::open(s.path(), "other").config();
    assert_eq!(json::marshal(&got).unwrap(), json::marshal(&c).unwrap());
}

/// 저장 파일이 Go `json.MarshalIndent(c, "", "  ")` 와 바이트까지 같다 (go1.27.2 에서 뽑은 값).
#[test]
fn saved_bytes_match_go() {
    let (_d, s) = new_store();
    s.save(s.config()).unwrap();
    let want1 = "{\n  \"enabled\": false,\n  \"port\": 58147,\n  \"bind\": \"0.0.0.0\",\n  \"name\": \"host-a\",\n  \"advertise\": \"\",\n  \"edges\": []\n}";
    assert_eq!(
        String::from_utf8(fs::read(s.path()).unwrap()).unwrap(),
        want1
    );
    let mut c = s.config();
    let mut b = edge("b", "", 0, &fp_rep("cd"));
    b.helper_key = "K".into();
    b.pending = true;
    c.edges = vec![edge("home", "10.0.0.2", 58147, &fp_rep("ab")), b];
    c.advertise = "a<b>&".into();
    s.save(c).unwrap();
    let want2 = format!(
        "{{\n  \"enabled\": false,\n  \"port\": 58147,\n  \"bind\": \"0.0.0.0\",\n  \"name\": \"host-a\",\n  \"advertise\": \"a\\u003cb\\u003e\\u0026\",\n  \"edges\": [\n    {{\n      \"name\": \"home\",\n      \"addr\": \"10.0.0.2\",\n      \"port\": 58147,\n      \"fp\": \"{}\"\n    }},\n    {{\n      \"name\": \"b\",\n      \"addr\": \"\",\n      \"port\": 0,\n      \"fp\": \"{}\",\n      \"helperKey\": \"K\",\n      \"pending\": true\n    }}\n  ]\n}}",
        fp_rep("ab"),
        fp_rep("cd")
    );
    assert_eq!(
        String::from_utf8(fs::read(s.path()).unwrap()).unwrap(),
        want2
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(s.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn save_rejects_invalid() {
    let (_d, s) = new_store();
    type Mutate = fn(&mut Config);
    let cases: [(Mutate, Error); 4] = [
        (|c| c.name = "a b".into(), Error::InvalidName),
        (|c| c.port = 0, Error::InvalidPort),
        (|c| c.port = 65536, Error::InvalidPort),
        (|c| c.bind = "not-an-ip".into(), Error::InvalidBind),
    ];
    for (m, want) in cases {
        let mut c = s.config();
        m(&mut c);
        assert_eq!(s.save(c), Err(want));
    }
    assert!(!s.path().exists());
    assert_eq!(s.config().name, "host-a");
}

#[test]
fn save_failure_restores() {
    let d = TempDir::new().unwrap();
    let blocker = d.path().join("file");
    fs::write(&blocker, b"").unwrap();
    let s = Store::open(blocker.join(dmenv::EDGES_FILE), "host-a");
    let mut c = s.config();
    c.name = "changed".into();
    assert_eq!(s.save(c), Err(Error::SaveFailed));
    assert_eq!(s.config().name, "host-a");
}

#[test]
fn corrupt_falls_back() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    fs::write(&path, b"{").unwrap();
    let c = Store::open(&path, "host-a").config();
    assert!(
        !c.enabled && c.port == DEFAULT_PORT && c.name == "host-a",
        "{c:?}"
    );
}

#[test]
fn partial_fills_defaults() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    fs::write(&path, br#"{"enabled":true}"#).unwrap();
    let c = Store::open(&path, "host-a").config();
    assert!(
        c.enabled && c.port == DEFAULT_PORT && c.bind == DEFAULT_BIND && c.name == "host-a",
        "{c:?}"
    );
}

#[test]
fn is_edge() {
    let (_d, s) = new_store();
    let fp = fp_rep("cd");
    assert!(!s.is_edge(&fp));
    let mut c = s.config();
    c.edges = vec![edge("b", "10.0.0.3", 58147, &fp)];
    s.save(c).unwrap();
    assert!(s.is_edge(&fp));
    assert!(!s.is_edge(&fp_rep("ef")) && !s.is_edge(""));
}

#[test]
fn rejects_invalid_edge() {
    let (_d, s) = new_store();
    let aa = fp_rep("aa");
    let cases = [
        edge("a\x01", "h", 1, &aa),
        edge("", "h", 1, &aa),
        edge(&rep("x", DISPLAY_NAME_MAX + 1), "h", 1, &aa),
        edge("a", "h", 0, &aa),
        edge("a", "h", 1, "xyz"),
        edge("a", "", 1, &aa),
    ];
    for e in cases {
        assert_eq!(s.add_edge(e.clone()), Err(Error::InvalidEdge), "{e:?}");
    }
    assert!(s.config().edges.is_empty());
}

#[test]
fn replace_same_fingerprint() {
    let (_d, s) = new_store();
    s.add_edge(edge("b", "h", 1, &fp_rep("aa"))).unwrap();
    s.add_edge(edge("b2", "h2", 2, &fp_rep("aa"))).unwrap();
    let got = s.config().edges;
    assert!(
        got.len() == 1 && got[0].name == "b2" && got[0].addr == "h2",
        "{got:?}"
    );
}

#[test]
fn remove_and_address() {
    let (_d, s) = new_store();
    let fp = fp_rep("aa");
    s.add_edge(edge("b", "h", 1, &fp)).unwrap();
    s.set_address(&fp, "10.0.0.9", 60000).unwrap();
    let p = &s.config().edges[0];
    assert!(
        p.addr == "10.0.0.9" && p.port == 60000 && p.fingerprint == fp,
        "{p:?}"
    );
    assert_eq!(s.set_address(&fp, "", 1), Err(Error::InvalidEdge));
    assert_eq!(
        s.set_address(&fp_rep("bb"), "h", 1),
        Err(Error::EdgeNotFound)
    );
    s.remove(&fp).unwrap();
    assert!(!s.is_edge(&fp));
    assert_eq!(s.remove(&fp), Err(Error::EdgeNotFound));
}

#[test]
fn set_node_validates_advertise() {
    let (_d, s) = new_store();
    let mut c = s.config();
    c.advertise = "not an addr!".into();
    assert_eq!(s.set_node(&c), Err(Error::InvalidNodeField));
    c.advertise = "192.168.0.5".into();
    s.set_node(&c).unwrap();
}

#[test]
fn add_edge_keeps_helper_key() {
    let (_d, s) = new_store();
    let fp = fp_rep("ab");
    s.add_edge(edge("p", "10.0.0.1", 1, &fp)).unwrap();
    s.pin_helper(&fp, "K").unwrap();
    s.add_edge(edge("p", "10.0.0.2", 1, &fp)).unwrap();
    assert!(
        s.config()
            .edges
            .iter()
            .filter(|e| e.fingerprint == fp)
            .all(|e| e.helper_key == "K")
    );
}

#[test]
fn normalizes_legacy_name() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    fs::write(
        &path,
        br#"{"enabled":false,"port":58147,"bind":"0.0.0.0","name":"Mac.local","edges":[]}"#,
    )
    .unwrap();
    let s = Store::open(&path, "host-a");
    assert_eq!(s.config().name, "Mac-local");
    s.save(s.config()).unwrap();
    assert_eq!(Store::open(&path, "x").config().name, "Mac-local");
}

#[test]
fn set_name() {
    let (_d, s) = new_store();
    let mut c = s.config();
    c.port = 60002;
    s.save(c).unwrap();
    s.set_name("동민").unwrap();
    let got = s.config();
    assert!(got.name == "동민" && got.port == 60002, "{got:?}");
    assert_eq!(s.set_name("동 민"), Err(Error::InvalidName));
    assert_eq!(s.config().name, "동민");
}

#[test]
fn set_node_keeps_name_when_empty() {
    let (_d, s) = new_store();
    s.set_name("동민").unwrap();
    s.set_node(&Config {
        port: 60003,
        bind: DEFAULT_BIND.into(),
        ..Config::default()
    })
    .unwrap();
    let got = s.config();
    assert!(got.name == "동민" && got.port == 60003, "{got:?}");
}

#[test]
fn resolve_by_handle() {
    let (_d, s) = new_store();
    let fp_a = format!("00001a2b{}", rep("1", 56));
    let fp_b = format!("00001a2c{}", rep("2", 56));
    let fp_c = format!("00011d4b{}", rep("3", 56));
    let mut c = s.config();
    c.edges = vec![
        edge("Office", "", 0, &fp_a),
        edge("Office", "", 0, &fp_b),
        edge("집", "", 0, &fp_c),
    ];
    s.save(c).unwrap();
    for (q, want) in [
        ("office#6699", &fp_a),
        ("Office#6700", &fp_b),
        ("집#3035", &fp_c),
    ] {
        assert_eq!(
            s.resolve(q).map(|e| e.fingerprint).as_ref(),
            Ok(want),
            "{q}"
        );
    }
    for q in ["office#1234", "nobody#6699", "#6699", "office#"] {
        assert_eq!(s.resolve(q), Err(Error::EdgeNotFound), "{q}");
    }
    assert_eq!(s.resolve(&fp_c[..8]).unwrap().fingerprint, fp_c);
}

#[test]
fn resolve_by_handle_ambiguous() {
    let (_d, s) = new_store();
    let mut c = s.config();
    c.edges = vec![
        edge("pc", "", 0, &format!("00001a2b{}", rep("1", 56))),
        edge("PC", "", 0, &format!("0000413b{}", rep("2", 56))),
    ];
    s.save(c).unwrap();
    assert_eq!(s.resolve("pc#6699"), Err(Error::Ambiguous));
}

#[test]
fn load_drops_legacy_pending() {
    let d = TempDir::new().unwrap();
    let path = d.path().join("edges.json");
    let raw = format!(
        r#"{{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"me","edges":[
	 {{"name":"p","addr":"10.0.0.1","port":1,"fp":"{}","state":""}},
	 {{"name":"p","addr":"10.0.0.2","port":1,"fp":"{}","state":""}},
	 {{"name":"q","addr":"10.0.0.3","port":1,"fp":"{}","state":"pending-out","expires":"2099-01-01T00:00:00Z"}}]}}"#,
        fp_of("aa"),
        fp_of("bb"),
        fp_of("cc")
    );
    fs::write(&path, raw).unwrap();
    let s = Store::open(&path, "h");
    assert_eq!(s.config().edges.len(), 2);
    assert!(s.is_edge(&fp_of("aa")) && s.is_edge(&fp_of("bb")) && !s.is_edge(&fp_of("cc")));
}

#[test]
fn add_edge_names_may_repeat() {
    let (_d, s) = new_store();
    s.add_edge(edge("same", "10.0.0.1", 1, &fp_of("aa")))
        .unwrap();
    s.add_edge(edge("same", "", 0, &fp_of("bb"))).unwrap();
    assert_eq!(s.config().edges.len(), 2);
}

#[test]
fn resolve_by_prefix() {
    let (_d, s) = new_store();
    for p in ["12345678aa", "12345678bb", "abcdef01"] {
        s.add_edge(edge("n", "10.0.0.1", 1, &fp_of(p))).unwrap();
    }
    assert_eq!(
        s.resolve("abcdef01").unwrap().fingerprint,
        fp_of("abcdef01")
    );
    assert_eq!(
        s.resolve(&fp_of("12345678aa")).unwrap().fingerprint,
        fp_of("12345678aa")
    );
    assert_eq!(s.resolve("12345678"), Err(Error::Ambiguous));
    assert_eq!(s.resolve("abc"), Err(Error::EdgeNotFound));
    assert_eq!(s.resolve("ffffffff"), Err(Error::EdgeNotFound));
    s.set_address(&fp_of("abcdef01"), "10.0.0.9", 2).unwrap();
    s.remove(&fp_of("abcdef01")).unwrap();
    assert!(!s.is_edge(&fp_of("abcdef01")));
}

fn mesh_store() -> (TempDir, Store, String) {
    let (d, s) = new_store();
    let fp = fp_rep("ab");
    s.add_edge(edge("old", "10.0.0.1", 7001, &fp)).unwrap();
    (d, s, fp)
}

#[test]
fn apply_hello() {
    let (_d, s, fp) = mesh_store();
    let at = |fp: &str| s.resolve(fp).unwrap();
    assert_eq!(s.apply_hello(&fp, "new", "", 0, "192.168.0.9"), Ok(true));
    let e = at(&fp);
    assert!(
        e.name == "new" && e.addr == "10.0.0.1" && e.port == 7001,
        "{e:?}"
    );
    assert_eq!(s.apply_hello(&fp, "new", "", 0, ""), Ok(false));
    s.apply_hello(&fp, "new", "host.example", 7002, "192.168.0.9")
        .unwrap();
    let e = at(&fp);
    assert!(e.addr == "host.example" && e.port == 7002, "{e:?}");
    s.apply_hello(&fp, "new", "bad addr", 7003, "192.168.0.9")
        .unwrap();
    let e = at(&fp);
    assert!(e.addr == "host.example" && e.port == 7003, "{e:?}");
    let bare = fp_rep("ef");
    s.add_edge(edge("bare", "", 0, &bare)).unwrap();
    s.apply_hello(&bare, "bare", "", 7004, "192.168.0.9")
        .unwrap();
    let e = at(&bare);
    assert!(e.addr == "192.168.0.9" && e.port == 7004, "{e:?}");
    s.apply_hello(&bare, "bare", "", 7005, "").unwrap();
    let e = at(&bare);
    assert!(e.addr == "192.168.0.9" && e.port == 7005, "{e:?}");
    s.apply_hello(&fp, "\x01bad", "", 70000, "").unwrap();
    let e = at(&fp);
    assert!(e.port == 7003 && e.name != "\x01bad", "{e:?}");
    assert!(s.apply_hello(&fp_rep("cd"), "x", "", 0, "").is_err());
}

#[test]
fn pending_persists() {
    let (_d, s, fp) = mesh_store();
    s.set_pending_all().unwrap();
    assert!(s.resolve(&fp).unwrap().pending);
    assert!(Store::open(s.path(), "host").resolve(&fp).unwrap().pending);
    assert_eq!(s.set_pending(&fp, false), Ok(true));
    assert_eq!(s.set_pending(&fp, false), Ok(false));
    s.set_pending(&fp, true).unwrap();
    s.add_edge(edge("x", "", 0, &fp)).unwrap();
    assert!(!s.resolve(&fp).unwrap().pending);
}

const LEGACY_JSON: &str = r#"{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"old","peers":[{"name":"b","addr":"10.0.0.2","port":58147,"fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":""}]}"#;

#[test]
fn migrate_moves() {
    let d = TempDir::new().unwrap();
    fs::write(d.path().join(dmenv::LEGACY_PEERS_FILE), LEGACY_JSON).unwrap();
    migrate_legacy_files(d.path()).unwrap();
    assert!(!d.path().join(dmenv::LEGACY_PEERS_FILE).exists());
    let c = Store::open(d.path().join(dmenv::EDGES_FILE), "h").config();
    assert!(
        c.name == "old" && c.edges.len() == 1 && c.edges[0].name == "b",
        "{c:?}"
    );
}

#[test]
fn migrate_keeps_both() {
    let d = TempDir::new().unwrap();
    let legacy = d.path().join(dmenv::LEGACY_PEERS_FILE);
    fs::write(&legacy, LEGACY_JSON).unwrap();
    fs::write(
        d.path().join(dmenv::EDGES_FILE),
        br#"{"name":"new","edges":[]}"#,
    )
    .unwrap();
    migrate_legacy_files(d.path()).unwrap();
    assert!(legacy.exists());
    let c = Store::open(d.path().join(dmenv::EDGES_FILE), "h").config();
    assert!(c.name == "new" && c.edges.is_empty(), "{c:?}");
}

#[test]
fn migrate_none() {
    let d = TempDir::new().unwrap();
    migrate_legacy_files(d.path()).unwrap();
    assert!(!d.path().join(dmenv::EDGES_FILE).exists());
    assert!(
        Store::open(d.path().join(dmenv::EDGES_FILE), "h")
            .config()
            .edges
            .is_empty()
    );
}

#[test]
fn reads_legacy_key() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    fs::write(&path, LEGACY_JSON).unwrap();
    let s = Store::open(&path, "h");
    assert_eq!(s.config().edges.len(), 1);
    s.save(s.config()).unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    assert!(
        raw.contains("\"edges\"") && !raw.contains("\"peers\""),
        "{raw}"
    );
}

#[test]
fn migrate_drops_node_identity() {
    let d = TempDir::new().unwrap();
    for n in [dmenv::LEGACY_NODE_CERT_FILE, dmenv::LEGACY_NODE_KEY_FILE] {
        fs::write(d.path().join(n), b"old").unwrap();
    }
    migrate_legacy_files(d.path()).unwrap();
    for n in ["node-cert.pem", "node-key.pem"] {
        assert!(!d.path().join(n).exists(), "{n}");
    }
}

fn nth_fp(i: usize) -> String {
    format!("{:064x}", i + 1)
}

fn nth_edge(i: usize) -> Edge {
    edge(&format!("n{i}"), "10.0.0.2", DEFAULT_PORT, &nth_fp(i))
}

#[test]
fn add_edge_rejects_beyond_max() {
    let (_d, s) = new_store();
    for i in 0..MAX_EDGES {
        s.add_edge(nth_edge(i)).unwrap();
    }
    assert_eq!(s.can_add(&nth_fp(MAX_EDGES)), Err(Error::EdgeLimit));
    assert_eq!(s.add_edge(nth_edge(MAX_EDGES)), Err(Error::EdgeLimit));
    assert_eq!(s.config().edges.len(), MAX_EDGES);
    let mut again = nth_edge(3);
    again.name = "renamed".into();
    s.can_add(&again.fingerprint).unwrap();
    s.add_edge(again).unwrap();
    assert_eq!(Error::EdgeLimit.to_string(), "간선은 최대 64 개입니다");
}

#[test]
fn keeps_edges_beyond_max() {
    let d = TempDir::new().unwrap();
    let path = d.path().join(dmenv::EDGES_FILE);
    let over = MAX_EDGES + 6;
    let mut c = default_config("host-a");
    c.edges = (0..over).map(nth_edge).collect();
    fs::write(&path, json::marshal(&c).unwrap()).unwrap();
    let s = Store::open(&path, "host-a");
    assert_eq!(s.config().edges.len(), over);
    assert_eq!(s.add_edge(nth_edge(over)), Err(Error::EdgeLimit));
    s.set_name("office").unwrap();
    s.remove(&nth_fp(0)).unwrap();
    assert_eq!(Store::open(&path, "host-a").config().edges.len(), over - 1);
}
