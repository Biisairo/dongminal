//! Go 기준선 `dongminal/internal/ctl/privhelper` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 사람 명령의 도우미다 (PEER_CHAT_SRS §3.12, FR-PCH-72~79). 관리자 권한으로 돌며 TOTP 를
//! 확인하고 사람 명령 묶음에 서명한다. `dongminal otp` 하위 명령이다(옛 이름 `helper`).

mod guard;
mod secret;
mod server;
mod sys;
mod totp;

pub use secret::Secret;
pub use server::{BadSecret, MAX_CONNS, Server};

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::SystemTime;

use dm_gocompat::oserr::{go_error_string, link_error, path_error};
use dm_shared_humancmd::{Client, SOCKET_PATH};

use secret::{load_secret, new_secret, save_secret};

/// 자리다 (FR-PCH-72).
pub const LABEL: &str = "com.dongminal.helper";
const BIN_PATH: &str = "/Library/PrivilegedHelperTools/com.dongminal.helper";
const PLIST_PATH: &str = "/Library/LaunchDaemons/com.dongminal.helper.plist";
const SECRET_DIR: &str = "/Library/Application Support/com.dongminal.helper";
const SECRET_PATH: &str = "/Library/Application Support/com.dongminal.helper/secret.json";
const LOG_PATH: &str = "/var/log/com.dongminal.helper.log";
const BIN_DIR_MODE: u32 = 0o755;
const BIN_MODE: u32 = 0o755;
const PLIST_MODE: u32 = 0o644;

/// `dongminal otp --help` 다. 옛 이름 `dongminal helper` 도 같은 것을 부른다.
pub const USAGE: &str = "사용법: dongminal otp <install|uninstall|run|status>

OTP 도우미다. 채팅의 강제 삭제·강퇴는 사람만 할 수 있어야 하므로, 할 때마다 휴대폰
OTP 앱의 6자리를 넣게 한다. 도우미는 관리자(root) 권한으로 따로 돌며 OTP 를 확인하고,
맞으면 그 명령에 서명한다. 에이전트는 사용자와 같은 계정으로 돌기 때문에 이 비밀과
서명 키를 읽을 수 없다.

  install    (sudo) 도우미를 관리자 자리에 복사하고 LaunchDaemon 으로 등록한다.
             처음이면 TOTP 비밀과 복구 코드를 한 번만 보인다. 비밀은 OTP 앱
             (Ente Auth 권장)에 넣고, 복구 코드는 따로 적어 둔다.
  uninstall  (sudo) 등록을 내리고 프로그램과 비밀 파일을 지운다.
  run        LaunchDaemon 이 부른다. 직접 부르지 않는다.
  status     도우미가 떠 있는지와 공개키 지문을 보인다.

쓰는 법: 채팅 탭이나 Activity ▸ Chats 에서 방·참가자를 고르고 우클릭해 강제 삭제·강퇴를
고르면 확인 창이 뜬다. 거기에 OTP 앱의 6자리를 넣는다. 원격 화면에서도 된다.
  - 한 코드는 한 번만 받는다. 여러 개를 골랐으면 한 번에 승인된다.
  - 5번 틀리면 5분 동안 잠긴다.
  - 휴대폰이 없으면 6자리 대신 복구 코드를 넣는다. 복구 코드도 한 번씩만 쓰인다.

install 은 dongminal 탭이 아닌 OS 기본 터미널 앱에서 실행한다 — dongminal 탭의 화면은
에이전트가 읽을 수 있다. 지금은 macOS 만 된다.
";

const ERR_NOT_ROOT: &str = "sudo 로 실행한다";

/// 하위 명령의 실패 문구다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn ioe(e: io::Error) -> Error {
    Error(go_error_string(&e))
}

/// `dongminal otp` 를 실행하고 종료 코드를 돌려준다.
pub fn main(args: &[String], stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    let Some(cmd) = args.first() else {
        let _ = stderr.write_all(USAGE.as_bytes());
        return 2;
    };
    match cmd.as_str() {
        "-h" | "--help" | "help" => {
            let _ = stdout.write_all(USAGE.as_bytes());
            return 0;
        }
        "status" => return status_at(Path::new(SOCKET_PATH), stdout),
        "install" | "uninstall" | "run" => {}
        other => {
            let _ = write!(stderr, "알 수 없는 하위 명령: {other}\n{USAGE}");
            return 2;
        }
    }
    if !sys::SUPPORTED {
        let _ = writeln!(stderr, "도우미는 아직 macOS 만 된다 (FR-PCH-79)");
        return 1;
    }
    let res = match cmd.as_str() {
        "install" => install(stdout, stderr),
        "uninstall" => uninstall(stdout),
        _ => run(),
    };
    fail(stderr, res)
}

fn fail(stderr: &mut dyn Write, res: Result<(), Error>) -> i32 {
    match res {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(stderr, "dongminal otp: {e}");
            1
        }
    }
}

/// 도우미가 떠 있는지와 공개키를 보인다.
fn status_at(sock: &Path, stdout: &mut dyn Write) -> i32 {
    let client = Client {
        path: sock.to_path_buf(),
        timeout: std::time::Duration::ZERO,
    };
    let Ok(info) = client.info() else {
        let _ = writeln!(stdout, "도우미가 없거나 닿지 않는다");
        return 1;
    };
    let _ = writeln!(stdout, "도우미가 떠 있다. 공개키 {}", info.key);
    if info.locked_until != 0 {
        let _ = writeln!(stdout, "잠김: {} 까지", local_rfc3339(info.locked_until));
    }
    0
}

/// Go `time.UnixMilli(ms).Format(time.RFC3339)` (Local).
fn local_rfc3339(ms: i64) -> String {
    use dm_gocompat::time::{format_rfc3339, local, to_zone};
    match time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000) {
        Ok(t) => format_rfc3339(to_zone(t, local())),
        Err(_) => String::new(),
    }
}

/// sudo 를 부른 사용자다.
fn installer() -> Result<(i64, String), Error> {
    if sys::geteuid() != 0 {
        return Err(Error(ERR_NOT_ROOT.into()));
    }
    let uid = std::env::var("SUDO_UID")
        .ok()
        .and_then(|s| s.parse::<i64>().ok());
    match uid {
        Some(u) if u != 0 => Ok((u, std::env::var("SUDO_USER").unwrap_or_default())),
        _ => Err(Error(
            "SUDO_UID 가 없다 — 보통 사용자로 sudo 를 거쳐 실행한다".into(),
        )),
    }
}

fn install(stdout: &mut dyn Write, stderr: &mut dyn Write) -> Result<(), Error> {
    let (uid, user) = installer()?;
    let self_path = std::env::current_exe().map_err(ioe)?;
    let self_path = fs::canonicalize(&self_path).map_err(|e| {
        Error(go_error_string(&path_error(
            "lstat",
            &self_path.to_string_lossy(),
            e,
        )))
    })?;
    let nopasswd_user = user.clone();
    run_install(&mut InstallEnv {
        uid,
        user,
        self_path,
        bin_dir: PathBuf::from(BIN_PATH)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
        bin: BIN_PATH.into(),
        plist: PLIST_PATH.into(),
        secret: SECRET_PATH.into(),
        out: stdout,
        errw: stderr,
        own: Box::new(|p| sys::chown(p, 0, 0)),
        launch: Box::new(|| {
            let launchctl = dm_shared_platform::command_path("launchctl").map_err(Error)?;
            let _ = Command::new(&launchctl)
                .args(["bootout", &format!("system/{LABEL}")])
                .output();
            let out = Command::new(&launchctl)
                .args(["bootstrap", "system", PLIST_PATH])
                .output()
                .map_err(ioe)?;
            if !out.status.success() {
                let mut text = out.stdout;
                text.extend_from_slice(&out.stderr);
                return Err(Error(format!(
                    "launchctl bootstrap: {}: {}",
                    exit_status(&out.status),
                    String::from_utf8_lossy(&text).trim()
                )));
            }
            Ok(())
        }),
        nopasswd: Box::new(move || {
            if nopasswd_user.is_empty() {
                return false;
            }
            let Ok(sudo) = dm_shared_platform::command_path("sudo") else {
                return false;
            };
            Command::new(sudo)
                .args(["-l", "-U", &nopasswd_user])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("NOPASSWD"))
                .unwrap_or(false)
        }),
    })
}

/// Go `*exec.ExitError` 의 문구.
fn exit_status(s: &std::process::ExitStatus) -> String {
    dm_shared_platform::exit_status_text(s)
}

type OwnFn<'a> = dyn Fn(&Path) -> io::Result<()> + 'a;

/// 설치 한 번의 자리와 바깥 동작이다. 시험이 바꿔 끼운다.
struct InstallEnv<'a> {
    uid: i64,
    user: String,
    self_path: PathBuf,
    bin_dir: PathBuf,
    bin: PathBuf,
    plist: PathBuf,
    secret: PathBuf,
    out: &'a mut dyn Write,
    errw: &'a mut dyn Write,
    own: Box<OwnFn<'a>>,
    launch: Box<dyn Fn() -> Result<(), Error> + 'a>,
    nopasswd: Box<dyn Fn() -> bool + 'a>,
}

/// Go `os.MkdirAll(p, mode)`.
fn mkdir_all(p: &Path, mode: u32) -> io::Result<()> {
    dm_gocompat::oserr::mkdir_all(&p.to_string_lossy(), mode)
}

/// 순서 (§3.12a R-1·R-8): 비밀 확인(다른 사용자면 멈춤) → 처음이면 비밀을 만들어 저장하고 바로
/// 보임 → 프로그램 폴더를 만들고 복사 → plist → launchctl.
fn run_install(e: &mut InstallEnv<'_>) -> Result<(), Error> {
    match load_secret(&e.secret) {
        Ok(sec) => {
            if sec.uid != e.uid {
                return Err(Error(format!(
                    "다른 사용자(uid {})로 등록되어 있다 — uninstall 뒤 다시 설치한다",
                    sec.uid
                )));
            }
            let _ = writeln!(
                e.out,
                "이미 등록되어 있다. 비밀과 서명 키는 그대로 두고 프로그램만 바꾼다."
            );
        }
        Err(secret::LoadError::Io(err)) if err.kind() == io::ErrorKind::NotFound => {
            let (s, codes) = new_secret(e.uid);
            save_secret(&e.secret, &s)
                .map_err(|err| Error(format!("비밀 파일: {}", go_error_string(&err))))?;
            print_enrollment(e.out, &s, &codes, &e.user);
        }
        Err(err) => return Err(Error(format!("비밀 파일: {err}"))),
    }
    mkdir_all(&e.bin_dir, BIN_DIR_MODE).map_err(ioe)?;
    copy_file(&e.self_path, &e.bin, BIN_MODE, &*e.own)
        .map_err(|err| Error(format!("프로그램 복사: {}", go_error_string(&err))))?;
    write_file(
        &e.plist,
        plist(&e.bin.to_string_lossy()).as_bytes(),
        PLIST_MODE,
    )
    .map_err(ioe)?;
    (e.launch)()?;
    if (e.nopasswd)() {
        let _ = writeln!(
            e.errw,
            "경고: 이 사용자의 sudo 에 NOPASSWD 가 있다. 에이전트가 암호 없이 관리자 권한을 얻으면 도우미를 지킬 수 없다."
        );
    }
    let _ = writeln!(e.out, "도우미를 등록했다.");
    Ok(())
}

/// OTP 앱에 넣을 값과 복구 코드를 한 번만 보인다 (FR-PCH-76·77).
fn print_enrollment(w: &mut dyn Write, sec: &Secret, codes: &[String], user: &str) {
    let mut s = String::new();
    s.push('\n');
    s.push_str(
        "아래 값은 지금 한 번만 보인다. 이 창은 dongminal 탭이 아닌 OS 기본 터미널이어야 한다.\n",
    );
    s.push_str("휴대폰 OTP 앱(Ente Auth 권장)에 '직접 입력'으로 넣는다.\n");
    s.push('\n');
    s.push_str(&format!("  계정 이름  dongminal ({user})\n"));
    s.push_str(&format!("  비밀       {}\n", group_by4(&sec.totp)));
    s.push_str("  방식       TOTP · SHA1 · 6자리 · 30초\n");
    s.push('\n');
    s.push_str("복구 코드 (휴대폰을 잃었을 때 코드 대신 한 번씩 쓴다. 따로 적어 둔다):\n");
    for c in codes {
        s.push_str(&format!("  {c}\n"));
    }
    s.push('\n');
    let _ = w.write_all(s.as_bytes());
}

/// Go 는 바이트 위치로 4개마다 띄운다.
fn group_by4(s: &str) -> String {
    let mut b = String::with_capacity(s.len() + s.len() / 4);
    for (i, r) in s.char_indices() {
        if i > 0 && i % 4 == 0 {
            b.push(' ');
        }
        b.push(r);
    }
    b
}

fn uninstall(stdout: &mut dyn Write) -> Result<(), Error> {
    installer()?;
    if let Ok(launchctl) = dm_shared_platform::command_path("launchctl") {
        let _ = Command::new(launchctl)
            .args(["bootout", &format!("system/{LABEL}")])
            .output();
    }
    for p in [PLIST_PATH, BIN_PATH, SOCKET_PATH] {
        if let Err(e) = fs::remove_file(p)
            && e.kind() != io::ErrorKind::NotFound
        {
            return Err(ioe(path_error("remove", p, e)));
        }
    }
    if let Err(e) = fs::remove_dir_all(SECRET_DIR)
        && e.kind() != io::ErrorKind::NotFound
    {
        return Err(ioe(path_error("unlinkat", SECRET_DIR, e)));
    }
    let _ = writeln!(stdout, "도우미를 지웠다.");
    Ok(())
}

/// LaunchDaemon 이 부른다. 비밀을 읽고 소켓을 열어 설치한 사용자에게 넘긴다.
fn run() -> Result<(), Error> {
    if sys::geteuid() != 0 {
        return Err(Error(ERR_NOT_ROOT.into()));
    }
    let sec = load_secret(Path::new(SECRET_PATH)).map_err(|e| Error(e.to_string()))?;
    let uid = sec.uid;
    let srv = Server::new(
        sec,
        Arc::new(SystemTime::now),
        Box::new(|s| save_secret(Path::new(SECRET_PATH), s)),
        Box::new(sys::peer_uid),
    )
    .map_err(|e| Error(e.to_string()))?;
    let ipc = dm_shared_platform::current().ipc;
    let sock = Path::new(SOCKET_PATH);
    let _ = ipc.remove(sock);
    let ln = ipc.listen(sock).map_err(ioe)?;
    sys::chown(sock, uid, -1).map_err(ioe)?;
    srv.serve(&ln).map_err(ioe)
}

/// Go `os.WriteFile`.
fn write_file(p: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let ps = p.to_string_lossy();
    let mut f = o.open(p).map_err(|e| path_error("open", &ps, e))?;
    f.write_all(data).map_err(|e| path_error("write", &ps, e))
}

fn copy_file(
    src: &Path,
    dst: &Path,
    mode: u32,
    own: &dyn Fn(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let data = fs::read(src).map_err(|e| path_error("open", &src.to_string_lossy(), e))?;
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    write_file(&tmp, &data, mode)?;
    own(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
            .map_err(|e| path_error("chmod", &tmp.to_string_lossy(), e))?;
    }
    fs::rename(&tmp, dst)
        .map_err(|e| link_error("rename", &tmp.to_string_lossy(), &dst.to_string_lossy(), e))
}

/// LaunchDaemon 정의다. root 로 `otp run` 을 띄우고 죽으면 다시 띄운다.
fn plist(bin: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{bin}</string>
    <string>otp</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>{LOG_PATH}</string>
</dict>
</plist>
"#
    )
}

#[cfg(test)]
mod tests;
