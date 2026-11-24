//! `otterminal service install` — 감독자에게 넣을 정의를 써 준다 (M5 SEC-23).
//!
//! 우리가 감독자를 만들지 않고, 설치하지도 않는다. 파일을 쓰고 다음 걸음을 안내한다.

use std::io::Write;
use std::path::Path;

use otter_gocompat::filepath;
use otter_gocompat::oserr::{go_error_string, mkdir_all, path_error};
use otter_shared_otterenv as otterenv;
use otter_shared_platform::OsKind;
use otter_shared_serverconf as serverconf;

use crate::backup::flag_value;
use crate::env::Env;
use crate::options::{Common, ENV_PORT, ParseError, default_log_file, invalid, unknown_flag};

/// `otterminal service` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceOpts {
    pub common: Common,
    pub sub: String,
    pub out: String,
    /// 검사가 바꿔 끼우는 자리다. 비면 실행 환경에서 읽는다.
    pub(crate) os_kind: Option<OsKind>,
    pub(crate) exe: String,
}

pub fn parse_service(args: &[String]) -> Result<ServiceOpts, ParseError> {
    let mut o = ServiceOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--out" || a.starts_with("--out=") {
            let (v, adv) = flag_value(args, i, "--out")?;
            o.out = v;
            i += adv;
        } else if a.starts_with('-') {
            if !o.common.take(args, &mut i)? {
                return Err(unknown_flag("service", a));
            }
        } else if o.sub.is_empty() {
            o.sub = a.to_owned();
        } else {
            return Err(invalid(format!("service: 인자가 너무 많습니다: {a}")));
        }
        i += 1;
    }
    if o.sub != "install" {
        return Err(invalid("service: 하위 명령은 install 입니다"));
    }
    Ok(o)
}

pub fn run_service(o: &ServiceOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_service_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_service_in(
    o: &ServiceOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let kind = o.os_kind.unwrap_or(otter_shared_platform::current().os);
    let exe = if o.exe.is_empty() {
        match std::env::current_exe() {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(e) => {
                let _ = writeln!(
                    stderr,
                    "실행 파일의 자리를 알 수 없습니다: {}",
                    go_error_string(&e)
                );
                return 1;
            }
        }
    } else {
        o.exe.clone()
    };
    let getenv = |k: &str| env.get(k);
    let log = default_log_file(&home);
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: Path::new(&home),
        getenv: Some(&getenv),
        default_log_file: &log,
        ..Default::default()
    });
    let level = &conf.log_level.value;

    let (body, hint) = match kind {
        OsKind::Darwin => (
            launchd_plist(&exe, &home, level, &conf.log_file.value),
            darwin_hint(&o.out),
        ),
        OsKind::Linux | OsKind::Wsl => (systemd_unit(&exe, &home, level), linux_hint(&o.out)),
        OsKind::Windows => {
            // 조용히 빈 파일을 쓰지 않는다 — 사용자는 감독이 걸린 줄 안다.
            let _ = writeln!(
                stderr,
                "감독자 정의를 만들 수 없습니다: {kind} 는 아직 지원하지 않습니다."
            );
            let _ = writeln!(
                stderr,
                "Windows 에서는 작업 스케줄러의 '로그온 시 시작' 으로 같은 일을 할 수 있습니다."
            );
            let _ = writeln!(stderr, "  프로그램: {exe}");
            let _ = writeln!(stderr, "  인수:     start --foreground");
            return 1;
        }
    };

    if o.out.is_empty() {
        let _ = write!(stdout, "{body}\n{hint}");
        return 0;
    }
    let dir = filepath::dir(&o.out);
    if let Err(e) = mkdir_all(&dir, OUT_DIR_PERM) {
        let _ = writeln!(stderr, "{}", go_error_string(&e));
        return 1;
    }
    if let Err(e) = write_file(&o.out, body.as_bytes()) {
        let _ = writeln!(
            stderr,
            "쓰지 못했습니다: {}",
            go_error_string(&path_error("open", &o.out, e))
        );
        return 1;
    }
    let _ = write!(stdout, "✅ {}\n\n{hint}", o.out);
    0
}

fn write_file(path: &str, data: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o644);
    opts.open(path)?.write_all(data)
}

/// 감독자가 쓰는 이름이다.
const SERVICE_LABEL: &str = "com.otterminal.server";
/// `--out` 상위 디렉터리의 권한 (Go `os.MkdirAll(filepath.Dir(o.Out), 0o755)`).
const OUT_DIR_PERM: u32 = 0o755;

/// `darwin_hint`·`linux_hint` 가 안내하는 설치 자리다.
pub(crate) fn installed_service_files(env: &Env<'_>) -> Vec<String> {
    let Ok(user) = env.user_home_dir() else {
        return Vec::new();
    };
    let plist = format!("{SERVICE_LABEL}.plist");
    vec![
        filepath::join(&[user.as_str(), "Library", "LaunchAgents", &plist]),
        filepath::join(&[
            user.as_str(),
            ".config",
            "systemd",
            "user",
            "otterminal.service",
        ]),
    ]
}

/// 예전 서비스 파일이 바인드를 넣던 모양이다.
fn service_bind_env_marks() -> [String; 6] {
    let (host, port) = (otterenv::ENV_HOST, otterenv::ENV_PORT);
    [
        format!("<key>{host}</key>"),
        format!("<key>{port}</key>"),
        format!("<key>{ENV_PORT}</key>"),
        format!("Environment={host}="),
        format!("Environment={port}="),
        format!("Environment={ENV_PORT}="),
    ]
}

/// 설치된 서비스 파일에 바인드 환경변수가 남아 있을 때의 경고 한 줄이다 (FR-HRB-6).
pub(crate) fn service_bind_env_warning(paths: &[String]) -> String {
    let marks = service_bind_env_marks();
    let stale: Vec<&str> = paths
        .iter()
        .filter(|p| {
            std::fs::read(p).is_ok_and(|d| {
                let s = String::from_utf8_lossy(&d);
                marks.iter().any(|m| s.contains(m.as_str()))
            })
        })
        .map(String::as_str)
        .collect();
    if stale.is_empty() {
        return String::new();
    }
    format!(
        "서비스 파일 {} 에 바인드 환경변수가 남아 있습니다 (무시됩니다) — otterminal service install 로 다시 만드세요",
        stale.join(", ")
    )
}

/// macOS 의 정의다. `KeepAlive` 가 감독의 본체다.
pub(crate) fn launchd_plist(exe: &str, home: &str, log_level: &str, log_file: &str) -> String {
    let (exe, home, level, log) = (
        xml_esc(exe),
        xml_esc(home),
        xml_esc(log_level),
        xml_esc(log_file),
    );
    let (eh, el) = (otterenv::ENV_HOME, otterenv::ENV_LOG_LEVEL);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- otterminal 웹서버 감독 (M5 SEC-23).
     "otterminal service install" 이 만들었습니다. 경로·환경변수를 고쳤으면
     이 파일도 함께 고치세요 — 이 파일은 다시 생성되지 않습니다. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>{SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <!-- 감독의 본체. 이것이 없으면 "로그인할 때 한 번 띄운다" 이지 감독이 아니다. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>{eh}</key><string>{home}</string>
    <key>{el}</key><string>{level}</string>
  </dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    )
}

/// Linux·WSL 의 정의다. user unit 이다 — 이 제품은 사용자의 홈과 세션에 매여 있다.
pub(crate) fn systemd_unit(exe: &str, home: &str, log_level: &str) -> String {
    let (eh, el) = (otterenv::ENV_HOME, otterenv::ENV_LOG_LEVEL);
    format!(
        r#"# otterminal 웹서버 감독 (M5 SEC-23).
# "otterminal service install" 이 만들었습니다. 경로·환경변수를 고쳤으면
# 이 파일도 함께 고치세요 — 이 파일은 다시 생성되지 않습니다.
#
# **user unit 입니다.** 시스템 단위가 아닌 이유는 이 제품이 사용자의 홈과 세션에
# 매여 있기 때문입니다 — 도구 셸이 사용자의 rc 를 읽고, 홈이 0700 이며, git
# 자격증명이 그 사용자의 것입니다.
[Unit]
Description=otterminal — 브라우저에서 쓰는 터미널 워크스페이스
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exe} start --foreground
Environment={eh}={home}
Environment={el}={log_level}
# 감독의 본체. 종료 코드를 가리지 않는 이유는, 우리가 "정상 종료" 로 세는 것이
# 사용자가 직접 내린 경우뿐이고 그때는 systemctl 로 내리기 때문입니다.
Restart=always
RestartSec=3
# 죽고 되살아나기를 반복하면 멎는다 — 되살릴수록 나빠지는 상태가 있고
# (포트 점유·디스크 가득), 그때 무한 재시작은 로그만 채웁니다.
StartLimitIntervalSec=120
StartLimitBurst=5

[Install]
WantedBy=default.target
"#
    )
}

fn darwin_hint(out: &str) -> String {
    let target = if out.is_empty() {
        format!("~/Library/LaunchAgents/{SERVICE_LABEL}.plist")
    } else {
        out.to_owned()
    };
    format!(
        r#"다음 걸음 (이 명령이 대신 하지 않습니다):

  cp {target} ~/Library/LaunchAgents/{SERVICE_LABEL}.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{SERVICE_LABEL}.plist
  launchctl print gui/$(id -u)/{SERVICE_LABEL}

  내리려면: launchctl bootout gui/$(id -u)/{SERVICE_LABEL}

확인: 서버를 강제로 죽인 뒤(kill -9) 몇 초 안에 되살아나는지 보세요.
"#
    )
}

fn linux_hint(out: &str) -> String {
    let target = if out.is_empty() {
        "~/.config/systemd/user/otterminal.service"
    } else {
        out
    };
    format!(
        r#"다음 걸음 (이 명령이 대신 하지 않습니다):

  mkdir -p ~/.config/systemd/user
  cp {target} ~/.config/systemd/user/otterminal.service
  systemctl --user daemon-reload
  systemctl --user enable --now otterminal
  systemctl --user status otterminal

  로그아웃해도 살아 있게 하려면: sudo loginctl enable-linger $USER
  내리려면: systemctl --user disable --now otterminal

확인: 서버를 강제로 죽인 뒤(kill -9) 몇 초 안에 되살아나는지 보세요.
"#
    )
}

/// plist 에 들어갈 값을 이스케이프한다.
fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
