//! Go `browser_test.go`·`opener_test.go` 를 옮겼다.

use super::*;
use crate::shell::tests::fake_look;

const URL: &str = "http://x/";

fn ok(r: io::Result<(String, Vec<String>)>) -> (String, Vec<String>) {
    match r {
        Ok(v) => v,
        Err(e) => panic!("err = {e}"),
    }
}

fn no_file() -> StatFn {
    Box::new(|_| false)
}

fn any_file() -> StatFn {
    Box::new(|_| true)
}

#[test]
fn mac_browser_opens_chrome_app() {
    let (name, args) = ok(mac_browser().frameless_command(URL));
    assert_eq!(name, "open");
    assert_eq!(args, ["-na", "Google Chrome", "--args", "--app=http://x/"]);
}

#[test]
fn unix_browser_prefers_first_chromium() {
    let (name, args) =
        ok(unix_browser(fake_look(&["chromium", "google-chrome"])).frameless_command(URL));
    assert_eq!(name, "/usr/bin/google-chrome");
    assert_eq!(args, ["--app=http://x/"]);
}

#[test]
fn unix_browser_chromium_beats_host_opener() {
    let (name, _) = ok(
        unix_browser(fake_look(&["chromium", "wslview", "powershell.exe"])).frameless_command(URL),
    );
    assert_eq!(name, "/usr/bin/chromium");
}

#[test]
fn unix_browser_falls_back_to_wslview() {
    let (name, args) =
        ok(unix_browser(fake_look(&["wslview", "powershell.exe"])).frameless_command(URL));
    assert_eq!(name, "/usr/bin/wslview");
    assert_eq!(args, [URL]);
}

#[test]
fn unix_browser_falls_back_to_powershell() {
    let (name, args) = ok(unix_browser(fake_look(&["powershell.exe"])).frameless_command(URL));
    assert_eq!(name, "/usr/bin/powershell.exe");
    assert_eq!(
        args,
        [
            "-NoProfile",
            "-Command",
            "Start-Process -FilePath 'http://x/'"
        ]
    );
}

#[test]
fn unix_browser_none_found() {
    let e = unix_browser(fake_look(&[]))
        .frameless_command(URL)
        .expect_err("아무 수단도 없는데 성공했다");
    assert_eq!(
        e.to_string(),
        "브라우저를 열 수단을 찾지 못했습니다. Chrome 또는 Chromium 을 설치하세요 (WSL 이라면 wslu 설치로 호스트 브라우저를 쓸 수 있습니다)"
    );
}

#[test]
fn win_browser_prefers_path() {
    let (name, args) =
        ok(win_browser(fake_look(&["chrome.exe"]), no_env(), no_file()).frameless_command(URL));
    assert_eq!(name, "/usr/bin/chrome.exe");
    assert_eq!(args, ["--app=http://x/"]);
}

#[test]
fn win_browser_finds_standard_install() {
    let base = Conv::HOST.join(&["C:", "Program Files"]);
    let want = Conv::HOST.join(&[&base, CHROME_REL_PATH]);
    let env_base = base.clone();
    let env: EnvFn = Box::new(move |k| {
        if k == "ProgramFiles" {
            env_base.clone()
        } else {
            String::new()
        }
    });
    let stat_want = want.clone();
    let stat: StatFn = Box::new(move |p| p == stat_want);
    let (name, args) = ok(win_browser(fake_look(&[]), env, stat).frameless_command(URL));
    assert_eq!(name, want);
    assert_eq!(args, ["--app=http://x/"]);
}

#[test]
fn win_browser_install_order() {
    // Chrome 의 세 자리가 Edge 보다 먼저다.
    let env: EnvFn = Box::new(|k| format!("/{k}"));
    let edge_only: StatFn = Box::new(|p| p.contains("msedge"));
    let (name, _) = ok(win_browser(fake_look(&[]), env, edge_only).frameless_command(URL));
    assert_eq!(
        name,
        Conv::HOST.join(&["/ProgramFiles(x86)", EDGE_REL_PATH])
    );
}

#[test]
fn win_browser_falls_back_to_default_handler() {
    let (name, args) = ok(win_browser(fake_look(&[]), no_env(), no_file()).frameless_command(URL));
    assert_eq!(name, "rundll32");
    assert_eq!(args, ["url.dll,FileProtocolHandler", URL]);
}

#[test]
fn win_browser_skips_empty_env() {
    let (name, _) = ok(win_browser(fake_look(&[]), no_env(), any_file()).frameless_command(URL));
    assert_eq!(name, "rundll32", "빈 환경변수 후보를 골랐다");
}

// ── opener ───────────────────────────────────────────

#[test]
fn mac_opener_uses_plain_open() {
    let (name, args) = ok(mac_opener().open_command("https://x.dev/a?b=1"));
    assert_eq!(name, "open");
    assert_eq!(args, ["https://x.dev/a?b=1"]);
}

#[test]
fn unix_opener_prefers_xdg_open() {
    let (name, args) =
        ok(unix_opener(fake_look(&["xdg-open", "wslview"])).open_command("https://x.dev/"));
    assert_eq!(name, "/usr/bin/xdg-open");
    assert_eq!(args, ["https://x.dev/"]);
}

#[test]
fn unix_opener_falls_back_to_host_opener() {
    let (name, _) = ok(unix_opener(fake_look(&["wslview"])).open_command("https://x.dev/"));
    assert_eq!(name, "/usr/bin/wslview");
}

#[test]
fn unix_opener_nothing_available() {
    let e = unix_opener(fake_look(&[]))
        .open_command("https://x.dev/")
        .expect_err("열 수단이 없는데 성공했다");
    assert_eq!(
        e.to_string(),
        "URL 을 열 수단을 찾지 못했습니다. xdg-utils 를 설치하세요 (WSL 이라면 wslu 로 호스트 브라우저를 쓸 수 있습니다)"
    );
}

#[test]
fn win_opener_default_handler() {
    let (name, args) = ok(win_opener().open_command("https://x.dev/"));
    assert_eq!(name, "rundll32");
    assert_eq!(args, ["url.dll,FileProtocolHandler", "https://x.dev/"]);
}

#[test]
fn current_chains_exist() {
    let p = crate::current();
    if cfg!(target_os = "macos") {
        assert_eq!(ok(p.opener.open_command(URL)).0, "open");
        assert_eq!(ok(p.browser.frameless_command(URL)).0, "open");
    }
    if cfg!(windows) {
        assert_eq!(ok(p.opener.open_command(URL)).0, "rundll32");
    }
}

/// PowerShell 축자 문자열의 해제. 안쪽 홑따옴표 문자는 겹쳐 있어야 하고, 하나만 있으면 거기서
/// 문자열이 닫힌 것이다(그 뒤가 스크립트로 읽힌다).
fn unquote_power_shell_literal(s: &str) -> Option<String> {
    const Q: &[char] = &['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];
    let body = s.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut out = String::new();
    let mut it = body.chars().peekable();
    while let Some(c) = it.next() {
        if Q.contains(&c) {
            match it.next() {
                Some(d) if Q.contains(&d) => out.push(d),
                _ => return None,
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

// RUST_PORT_SRS 3.7 D-2: 주입 시도가 축자 문자열 안에 그대로 남는다.
#[test]
fn powershell_fallback_keeps_url_literal() {
    for url in [
        "https://x.dev/a?b=1&c=2",
        "http://x/;calc.exe",
        "http://x/$(Remove-Item -Recurse ~)",
        "http://x/'; Start-Process calc; '",
        "http://x/\u{2019}; calc; \u{2018}",
        "http://x/\"q\"`n$env:USERPROFILE",
    ] {
        let (name, args) = ok(unix_browser(fake_look(&["powershell.exe"])).frameless_command(url));
        assert_eq!(name, "/usr/bin/powershell.exe");
        assert_eq!(
            args.len(),
            3,
            "url 이 별도 인자로 새면 스크립트가 된다: {args:?}"
        );
        assert_eq!(&args[..2], ["-NoProfile", "-Command"]);
        let lit = args[2]
            .strip_prefix("Start-Process -FilePath ")
            .expect("명령 모양");
        assert_eq!(
            unquote_power_shell_literal(lit).as_deref(),
            Some(url),
            "{lit}"
        );
        let (_, oargs) = ok(unix_opener(fake_look(&["powershell.exe"])).open_command(url));
        assert_eq!(oargs, args);
    }
}
