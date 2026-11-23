use std::path::Path;

use dm_shared_platform::OsKind;

use super::{Vars, args, temp_home, with_env};
use crate::parse_service;
use crate::service::{launchd_plist, run_service_in, service_bind_env_warning, systemd_unit};

const EXE: &str = "/opt/dongminal/dongminal";

fn run(kind: OsKind, exe: &str, a: &[&str], home: &Path) -> (i32, String, String) {
    let mut o = parse_service(&args(a)).unwrap();
    o.os_kind = Some(kind);
    o.exe = exe.to_owned();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(&Vars::home(home), |env| {
        run_service_in(&o, env, &mut out, &mut err)
    });
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn write_to(kind: OsKind) -> (String, String, String) {
    let (_d, home) = temp_home();
    let od = tempfile::tempdir().unwrap();
    let out = od.path().join("sub").join("dm.def");
    let (code, stdout, err) = run(
        kind,
        EXE,
        &["install", "--out", out.to_str().unwrap()],
        &home,
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        stdout.lines().next().unwrap(),
        format!("✅ {}", out.display())
    );
    (
        std::fs::read_to_string(&out).unwrap(),
        stdout,
        home.to_str().unwrap().to_owned(),
    )
}

#[test]
fn darwin_plist() {
    let (s, stdout, home) = write_to(OsKind::Darwin);
    for want in [
        "<key>KeepAlive</key>",
        "<key>RunAtLoad</key>",
        EXE,
        "start",
        "--foreground",
        "DONGMINAL_HOME",
        &home,
    ] {
        assert!(s.contains(want), "{want}:\n{s}");
    }
    assert!(stdout.contains("launchctl"));
}

#[test]
fn linux_unit() {
    let (s, stdout, home) = write_to(OsKind::Linux);
    for want in [
        "[Unit]",
        "[Service]",
        "[Install]",
        "Restart=always",
        &format!("ExecStart={EXE} start --foreground"),
        &format!("Environment=DONGMINAL_HOME={home}"),
        "WantedBy=default.target",
    ] {
        assert!(s.contains(want), "{want}:\n{s}");
    }
    assert!(!s.contains("User=root"));
    assert!(stdout.contains("systemctl --user"));
}

#[test]
fn wsl_uses_systemd() {
    assert!(write_to(OsKind::Wsl).0.contains("[Service]"));
}

// Windows 는 지원하지 않는다. 조용히 빈 파일을 쓰지 않는다.
#[test]
fn windows_is_unsupported() {
    let (_d, home) = temp_home();
    let od = tempfile::tempdir().unwrap();
    let out = od.path().join("x");
    let (code, stdout, err) = run(
        OsKind::Windows,
        "C:\\dm\\dongminal.exe",
        &["install", "--out", out.to_str().unwrap()],
        &home,
    );
    assert_eq!(code, 1);
    assert!(!out.exists());
    assert_eq!(stdout, "");
    assert_eq!(
        err,
        "감독자 정의를 만들 수 없습니다: windows 는 아직 지원하지 않습니다.\n\
         Windows 에서는 작업 스케줄러의 '로그온 시 시작' 으로 같은 일을 할 수 있습니다.\n\
         \x20 프로그램: C:\\dm\\dongminal.exe\n\
         \x20 인수:     start --foreground\n"
    );
}

// `--out` 없이 부르면 화면에 낸다 — 정의, 빈 줄, 안내.
#[test]
fn prints_when_no_out() {
    let (_d, home) = temp_home();
    let (code, stdout, _) = run(OsKind::Linux, EXE, &["install"], &home);
    assert_eq!(code, 0);
    let unit = systemd_unit(EXE, home.to_str().unwrap(), "info");
    assert!(
        stdout.starts_with(&format!("{unit}\n다음 걸음")),
        "{stdout}"
    );
    assert!(stdout.contains("cp ~/.config/systemd/user/dongminal.service ~/.config"));
}

// FR-HRB-6: 서비스 파일은 바인드 환경변수를 싣지 않는다.
#[test]
fn files_carry_no_bind_env() {
    for s in [
        launchd_plist("/opt/dm", "/h", "info", "/h/server.log"),
        systemd_unit("/opt/dm", "/h", "info"),
    ] {
        for bad in ["DONGMINAL_HOST", "DONGMINAL_PORT", ">PORT<", "PORT="] {
            assert!(!s.contains(bad), "{bad}:\n{s}");
        }
    }
}

// plist 값은 XML 이스케이프한다 — `&` 하나가 plist 를 통째로 깬다.
#[test]
fn plist_escapes_values() {
    let s = launchd_plist("/a&b/<dm>", "/h\"q", "info", "/l");
    assert!(s.contains("<string>/a&amp;b/&lt;dm&gt;</string>"));
    assert!(s.contains("<string>/h&quot;q</string>"));
}

#[test]
fn stale_service_file_warning() {
    let d = tempfile::tempdir().unwrap();
    let p = |n: &str| d.path().join(n).to_str().unwrap().to_owned();
    let (stale, clean, missing) = (p("old.plist"), p("new.service"), p("none"));
    std::fs::write(
        &stale,
        "<key>DONGMINAL_HOST</key><string>0.0.0.0</string>\n<key>PORT</key>",
    )
    .unwrap();
    std::fs::write(&clean, "Environment=DONGMINAL_HOME=/x\n").unwrap();
    assert_eq!(
        service_bind_env_warning(&[clean.clone(), missing.clone()]),
        ""
    );
    assert_eq!(
        service_bind_env_warning(&[clean, stale.clone(), missing]),
        format!(
            "서비스 파일 {stale} 에 바인드 환경변수가 남아 있습니다 (무시됩니다) — dongminal service install 로 다시 만드세요"
        )
    );
    let linux = p("old.service");
    std::fs::write(&linux, "Environment=PORT=58146\n").unwrap();
    assert!(!service_bind_env_warning(&[linux]).is_empty());
}
