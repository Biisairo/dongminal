use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dm_shared_humancmd::{
    self as humancmd, CODE_BAD_CODE, CODE_BAD_REQUEST, CODE_LOCKED, CODE_NO_HELPER,
    CODE_UNAVAILABLE, Kick, OP_KILL, Request,
};

use super::*;
use crate::guard::{Guard, MAX_FAILS};
use crate::secret::{RECOVERY_COUNT, base32_nopad};
use crate::totp::{DIGITS, hotp, step_of, unix_millis};

// TC-PCH-8: RFC 6238 부록 B 의 SHA1 시험 값.
#[test]
fn totp_rfc6238() {
    let secret = b"12345678901234567890";
    for (unix, want) in [
        (59, "94287082"),
        (1111111109, "07081804"),
        (1111111111, "14050471"),
        (1234567890, "89005924"),
        (2000000000, "69279037"),
        (20000000000u64, "65353130"),
    ] {
        let step = step_of(UNIX_EPOCH + Duration::from_secs(unix)) as u64;
        assert_eq!(hotp(secret, step, 8), want);
        assert_eq!(hotp(secret, step, DIGITS), &want[2..]);
    }
}

#[derive(Clone)]
struct TestClock(Arc<Mutex<SystemTime>>);

impl TestClock {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(
            UNIX_EPOCH + Duration::from_secs(1_800_000_000),
        )))
    }
    fn now(&self) -> SystemTime {
        *self.0.lock().unwrap()
    }
    fn add(&self, d: Duration) {
        *self.0.lock().unwrap() += d;
    }
    fn clock(&self) -> guard::Clock {
        let c = self.clone();
        Arc::new(move || c.now())
    }
}

fn my_uid() -> i64 {
    sys::geteuid()
}

fn code_at(s: &Secret, at: SystemTime) -> String {
    let raw = base32_nopad().decode(s.totp.as_bytes()).unwrap();
    hotp(&raw, step_of(at) as u64, DIGITS)
}

fn ok_save() -> guard::Save {
    Box::new(|_| Ok(()))
}

fn test_guard() -> (Guard, Secret, Vec<String>, TestClock) {
    let (s, codes) = new_secret(my_uid());
    let c = TestClock::new();
    let g = Guard::new(s.clone(), c.clock(), ok_save()).unwrap();
    (g, s, codes, c)
}

fn code_of<T>(r: Result<T, humancmd::Error>) -> String {
    r.err().map(|e| e.code).unwrap_or_default()
}

#[test]
fn guard_codes() {
    let (g, s, _, c) = test_guard();
    assert_eq!(code_of(g.check("")), CODE_BAD_CODE);
    let good = code_at(&s, c.now());
    let wrong = if good == "000000" { "111111" } else { "000000" };
    assert_eq!(code_of(g.check(wrong)), CODE_BAD_CODE);
    g.check(&good).unwrap();
    assert_eq!(
        code_of(g.check(&good)),
        CODE_BAD_CODE,
        "같은 코드를 두 번 받았다"
    );
    assert_eq!(
        code_of(g.check(&code_at(&s, c.now() - Duration::from_secs(30)))),
        CODE_BAD_CODE
    );
    g.check(&code_at(&s, c.now() + Duration::from_secs(30)))
        .unwrap();
    c.add(Duration::from_secs(600));
    assert_eq!(
        code_of(g.check(&code_at(&s, c.now() + Duration::from_secs(60)))),
        CODE_BAD_CODE
    );
    g.check(&code_at(&s, c.now() - Duration::from_secs(30)))
        .unwrap();
}

#[test]
fn guard_lock() {
    let (g, s, _, c) = test_guard();
    for _ in 0..4 {
        assert_eq!(code_of(g.check("abc")), CODE_BAD_CODE);
    }
    let e = g.check("abc").unwrap_err();
    assert_eq!(e.code, CODE_LOCKED);
    assert_eq!(e.until, unix_millis(c.now() + Duration::from_secs(300)));
    c.add(Duration::from_secs(240));
    assert_eq!(code_of(g.check(&code_at(&s, c.now()))), CODE_LOCKED);
    assert!(g.locked_until().is_some());
    c.add(Duration::from_secs(61));
    assert!(g.locked_until().is_none());
    for _ in 0..4 {
        assert_eq!(code_of(g.check("abc")), CODE_BAD_CODE);
    }
    g.check(&code_at(&s, c.now())).unwrap();
}

#[test]
fn guard_recovery() {
    let (s, codes) = new_secret(my_uid());
    let saved: Arc<Mutex<Option<Secret>>> = Arc::default();
    let sv = saved.clone();
    let g = Guard::new(
        s.clone(),
        TestClock::new().clock(),
        Box::new(move |x| {
            *sv.lock().unwrap() = Some(x.clone());
            Ok(())
        }),
    )
    .unwrap();
    assert_eq!(codes.len(), RECOVERY_COUNT);
    for c in &codes {
        assert!(c.len() == 11 && c.as_bytes()[5] == b'-');
    }
    g.check(&format!("  {}\n", codes[0].to_uppercase()))
        .unwrap();
    assert_eq!(saved.lock().unwrap().as_ref().unwrap().used.len(), 1);
    assert_eq!(code_of(g.check(&codes[0])), CODE_BAD_CODE);
    assert!(s.recovery.iter().flatten().all(|h| !h.contains(&codes[1])));
}

// R-5: 복구 코드는 맞는데 저장이 실패하면 unavailable 이고 틀린 횟수에 넣지 않는다.
#[test]
fn recovery_save_failure_not_counted() {
    let (s, codes) = new_secret(my_uid());
    let g = Guard::new(
        s,
        TestClock::new().clock(),
        Box::new(|_| Err(io::Error::other("disk full"))),
    )
    .unwrap();
    for _ in 0..=MAX_FAILS {
        assert_eq!(code_of(g.check(&codes[0])), CODE_UNAVAILABLE);
    }
    assert!(g.locked_until().is_none());
}

// ── 서버 ──

fn short_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("ph")
        .tempdir_in("/tmp")
        .unwrap()
}

struct Running {
    _dir: tempfile::TempDir,
    client: Client,
    sec: Secret,
    clock: TestClock,
    key: String,
}

fn start_server(peer: i64) -> Running {
    let (sec, _) = new_secret(my_uid());
    start_with(sec, peer)
}

fn start_with(sec: Secret, peer: i64) -> Running {
    let clock = TestClock::new();
    let srv = Server::new(
        sec.clone(),
        clock.clock(),
        ok_save(),
        Box::new(move |_| Ok(peer)),
    )
    .unwrap();
    let key = srv.public_key();
    let dir = short_dir();
    let path = dir.path().join("h.sock");
    let ln = dm_shared_platform::current().ipc.listen(&path).unwrap();
    std::thread::spawn(move || srv.serve(&ln));
    Running {
        _dir: dir,
        client: Client {
            path,
            timeout: Duration::from_secs(2),
        },
        sec,
        clock,
        key,
    }
}

fn kill_req() -> Request {
    Request {
        node: "a".repeat(64),
        op: OP_KILL.into(),
        rooms: vec!["r1".into(), "r2".into(), "r3".into()],
        kicks: vec![],
    }
}

#[test]
fn server_sign() {
    let r = start_server(my_uid());
    let info = r.client.info().unwrap();
    let seed = secret::decode_key(&r.sec.key).unwrap();
    assert_eq!(
        info.key,
        humancmd::public_key(&ed25519_dalek::SigningKey::from_bytes(&seed))
    );
    assert_eq!(info.key, r.key);
    assert_eq!(info.locked_until, 0);
    assert_eq!(code_of(r.client.sign("", kill_req())), CODE_BAD_CODE);
    let signed = r
        .client
        .sign(&code_at(&r.sec, r.clock.now()), kill_req())
        .unwrap();
    let b = humancmd::open(&signed).unwrap();
    assert_eq!(b.key, info.key);
    assert_eq!(b.op, OP_KILL);
    assert_eq!(b.rooms.len(), 3);
    assert_eq!(b.at, unix_millis(r.clock.now()));
    assert!(!b.id.is_empty());
    let mut m: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&signed.b.0).unwrap();
    m.insert("rooms".into(), serde_json::json!(["r1", "r2", "zz"]));
    let mut tampered = signed.clone();
    tampered.b.0 = dm_gocompat::json::marshal(&m).unwrap();
    assert!(humancmd::open(&tampered).is_err());
}

#[test]
fn server_rejects_bad_requests_without_spending_code() {
    let r = start_server(my_uid());
    let code = code_at(&r.sec, r.clock.now());
    let mut bad = kill_req();
    bad.rooms = vec!["r1".into()];
    bad.kicks = vec![Kick {
        room: "r1".into(),
        participant: "p".into(),
    }];
    assert_eq!(code_of(r.client.sign(&code, bad)), CODE_BAD_REQUEST);
    let mut many = kill_req();
    many.rooms = vec!["r".into(); humancmd::MAX_TARGETS + 1];
    assert_eq!(code_of(r.client.sign(&code, many)), CODE_BAD_REQUEST);
    r.client.sign(&code, kill_req()).unwrap();
}

#[test]
fn server_answers_garbage_with_bad_request() {
    let r = start_server(my_uid());
    let conn = dm_shared_platform::current()
        .ipc
        .dial(&r.client.path, Duration::from_secs(2))
        .unwrap();
    let mut c = &conn;
    c.write_all(b"not json\n").unwrap();
    let line = humancmd::read_line(&mut c).unwrap();
    assert_eq!(line, br#"{"t":"error","code":"bad_request"}"#);
}

#[test]
fn server_info_reports_lock() {
    let r = start_server(my_uid());
    for _ in 0..MAX_FAILS {
        let _ = r.client.sign("abc", kill_req());
    }
    let info = r.client.info().unwrap();
    assert_eq!(
        info.locked_until,
        unix_millis(r.clock.now() + Duration::from_secs(300))
    );
}

// 설치한 사용자가 아니면 끊는다.
#[test]
fn server_other_uid() {
    let r = start_server(424242);
    assert_eq!(code_of(r.client.info()), CODE_NO_HELPER);
}

// R-4: 복구 코드 서명과 info 가 동시에 와도 경합이 없다.
#[test]
fn server_concurrent_recovery() {
    let (sec, codes) = new_secret(my_uid());
    let r = start_with(sec, my_uid());
    let mut hs = Vec::new();
    for code in codes {
        let c1 = r.client.clone();
        let c2 = r.client.clone();
        hs.push(std::thread::spawn(move || {
            c1.sign(&code, kill_req()).unwrap();
        }));
        hs.push(std::thread::spawn(move || {
            c2.info().unwrap();
        }));
    }
    for h in hs {
        h.join().unwrap();
    }
}

// FR-RSP-6: 동시 연결은 MAX_CONNS 까지다. 넘는 연결은 바로 닫히고, 자리가 나면 다시 받는다.
#[test]
fn server_caps_concurrent_connections() {
    let r = start_server(my_uid());
    let ipc = dm_shared_platform::current().ipc;
    let idle: Vec<_> = (0..MAX_CONNS)
        .map(|_| ipc.dial(&r.client.path, Duration::from_secs(2)).unwrap())
        .collect();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(code_of(r.client.info()), CODE_NO_HELPER);
    drop(idle);
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if r.client.info().is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "자리가 돌아오지 않았다"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ── 비밀 파일 ──

#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
#[test]
fn secret_file_atomic_0600() {
    let d = short_dir();
    let dir = d.path().join("helper");
    fs::create_dir_all(&dir).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    let path = dir.join("secret.json");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let (s, _) = new_secret(501);
    save_secret(&path, &s).unwrap();
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(load_secret(&path).unwrap(), s);
    let names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["secret.json"]);

    let nested = d.path().join("d").join("secret.json");
    save_secret(&nested, &s).unwrap();
    assert_eq!(mode(nested.parent().unwrap()), 0o700);
}

// 파일 형식: Go MarshalIndent(두 칸, 끝 줄바꿈 없음), used 는 비면 빠진다.
#[test]
fn secret_file_bytes() {
    let s = Secret {
        uid: 501,
        totp: "T".into(),
        key: "K".into(),
        recovery: Some(vec!["h1".into()]),
        used: vec![],
    };
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal_indent(&s, "", "  ").unwrap()).unwrap(),
        "{\n  \"uid\": 501,\n  \"totp\": \"T\",\n  \"key\": \"K\",\n  \"recovery\": [\n    \"h1\"\n  ]\n}"
    );
    let s = Secret {
        recovery: None,
        used: vec!["u".into()],
        ..s
    };
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&s).unwrap()).unwrap(),
        r#"{"uid":501,"totp":"T","key":"K","recovery":null,"used":["u"]}"#
    );
}

#[test]
fn new_secret_shape() {
    let (s, _) = new_secret(7);
    assert_eq!(s.totp.len(), 32);
    assert_eq!(secret::decode_key(&s.key).map(|k| k.len()), Some(32));
    assert_eq!(s.recovery.as_ref().unwrap().len(), RECOVERY_COUNT);
    assert!(secret::decode_key("short").is_none());
}

// ── 설치 ──

struct Env {
    _d: tempfile::TempDir,
    uid: i64,
    self_path: PathBuf,
    bin_dir: PathBuf,
    bin: PathBuf,
    plist: PathBuf,
    secret: PathBuf,
}

fn test_env(uid: i64) -> Env {
    let d = short_dir();
    let self_path = d.path().join("self");
    fs::write(&self_path, "new-binary").unwrap();
    let bin_dir = d.path().join("PrivilegedHelperTools");
    Env {
        uid,
        self_path,
        bin: bin_dir.join("h"),
        bin_dir,
        plist: d.path().join("h.plist"),
        secret: d.path().join("sec").join("secret.json"),
        _d: d,
    }
}

fn install_with(
    e: &Env,
    launch_err: Option<&str>,
    out: &mut Vec<u8>,
    errw: &mut Vec<u8>,
) -> Result<(), Error> {
    let launch_err = launch_err.map(str::to_owned);
    run_install(&mut InstallEnv {
        uid: e.uid,
        user: "u".into(),
        self_path: e.self_path.clone(),
        bin_dir: e.bin_dir.clone(),
        bin: e.bin.clone(),
        plist: e.plist.clone(),
        secret: e.secret.clone(),
        out,
        errw,
        own: Box::new(|_| Ok(())),
        launch: Box::new(move || match &launch_err {
            Some(m) => Err(Error(m.clone())),
            None => Ok(()),
        }),
        nopasswd: Box::new(|| true),
    })
}

// R-1: 처음 설치에서 launchctl 이 실패해도 비밀은 이미 보였다. R-8: 폴더가 없으면 만든다.
#[test]
fn install_shows_secret_before_launch() {
    let e = test_env(501);
    let (mut out, mut errw) = (Vec::new(), Vec::new());
    let err = install_with(&e, Some("bootstrap failed"), &mut out, &mut errw).unwrap_err();
    assert_eq!(err.to_string(), "bootstrap failed");
    let sec = load_secret(&e.secret).unwrap();
    let out = String::from_utf8(out).unwrap();
    assert!(out.contains(&group_by4(&sec.totp)), "{out}");
    assert!(out.contains("  계정 이름  dongminal (u)\n"));
    assert_eq!(fs::read(&e.bin).unwrap(), b"new-binary");
    assert!(
        fs::read_to_string(&e.plist)
            .unwrap()
            .contains(&format!("<string>{}</string>", e.bin.display()))
    );
}

// R-8: 다른 사용자로 등록되어 있으면 프로그램을 바꾸기 전에 멈춘다.
#[test]
fn install_other_user_keeps_binary() {
    let mut e = test_env(501);
    let (mut out, mut errw) = (Vec::new(), Vec::new());
    install_with(&e, None, &mut out, &mut errw).unwrap();
    assert!(
        String::from_utf8(out)
            .unwrap()
            .ends_with("도우미를 등록했다.\n")
    );
    assert!(
        String::from_utf8(errw)
            .unwrap()
            .starts_with("경고: 이 사용자의 sudo 에 NOPASSWD 가 있다.")
    );
    fs::write(&e.bin, "installed").unwrap();
    e.uid = 502;
    let err = install_with(&e, None, &mut Vec::new(), &mut Vec::new()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "다른 사용자(uid 501)로 등록되어 있다 — uninstall 뒤 다시 설치한다"
    );
    assert_eq!(fs::read(&e.bin).unwrap(), b"installed");
    e.uid = 501;
    let mut out = Vec::new();
    install_with(&e, None, &mut out, &mut Vec::new()).unwrap();
    assert!(
        String::from_utf8(out)
            .unwrap()
            .starts_with("이미 등록되어 있다.")
    );
    assert_eq!(fs::read(&e.bin).unwrap(), b"new-binary");
}

#[test]
fn plist_and_format() {
    let p = plist(BIN_PATH);
    for want in [
        "<string>com.dongminal.helper</string>",
        "<string>/Library/PrivilegedHelperTools/com.dongminal.helper</string>",
        "<string>otp</string>",
        "<string>run</string>",
        "<key>KeepAlive</key>",
        "<key>RunAtLoad</key>",
        "<string>/var/log/com.dongminal.helper.log</string>",
    ] {
        assert!(p.contains(want), "{want}");
    }
    assert!(
        p.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n") && p.ends_with("</plist>\n")
    );
    assert_eq!(group_by4("ABCDEFGHIJ"), "ABCD EFGH IJ");
    for want in [
        "dongminal otp",
        "6자리",
        "강제 삭제",
        "강퇴",
        "복구 코드",
        "5번",
        "5분",
    ] {
        assert!(USAGE.contains(want));
    }
}

// ── CLI ──

fn run_main(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let (mut o, mut e) = (Vec::new(), Vec::new());
    let code = main(&args, &mut o, &mut e);
    (
        code,
        String::from_utf8(o).unwrap(),
        String::from_utf8(e).unwrap(),
    )
}

#[test]
fn main_usage_and_unknown() {
    assert_eq!(run_main(&[]), (2, String::new(), USAGE.into()));
    for h in ["-h", "--help", "help"] {
        assert_eq!(run_main(&[h]), (0, USAGE.into(), String::new()));
    }
    assert_eq!(
        run_main(&["nope"]),
        (
            2,
            String::new(),
            format!("알 수 없는 하위 명령: nope\n{USAGE}")
        )
    );
}

// root 가 아니면 install·uninstall·run 은 실패하고 아무것도 건드리지 않는다.
#[cfg(target_os = "macos")]
#[test]
fn main_requires_root() {
    if sys::geteuid() == 0 {
        return;
    }
    for cmd in ["install", "uninstall", "run"] {
        assert_eq!(
            run_main(&[cmd]),
            (1, String::new(), "dongminal otp: sudo 로 실행한다\n".into())
        );
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn main_unsupported_os() {
    assert_eq!(
        run_main(&["run"]),
        (
            1,
            String::new(),
            "도우미는 아직 macOS 만 된다 (FR-PCH-79)\n".into()
        )
    );
}

#[test]
fn status_against_fake_helper() {
    let r = start_server(my_uid());
    let mut out = Vec::new();
    assert_eq!(status_at(&r.client.path, &mut out), 0);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!("도우미가 떠 있다. 공개키 {}\n", r.key)
    );
    for _ in 0..MAX_FAILS {
        let _ = r.client.sign("abc", kill_req());
    }
    let mut out = Vec::new();
    assert_eq!(status_at(&r.client.path, &mut out), 0);
    let until = unix_millis(r.clock.now() + Duration::from_secs(300));
    assert!(
        String::from_utf8(out)
            .unwrap()
            .ends_with(&format!("잠김: {} 까지\n", local_rfc3339(until)))
    );
    let d = short_dir();
    let mut out = Vec::new();
    assert_eq!(status_at(&d.path().join("none.sock"), &mut out), 1);
    assert_eq!(out, "도우미가 없거나 닿지 않는다\n".as_bytes());
}

#[test]
fn local_rfc3339_shape() {
    let s = local_rfc3339(1_800_000_000_000);
    assert!(
        s.starts_with("2027-01-1") && (s.ends_with('Z') || s.len() == 25),
        "{s}"
    );
}
