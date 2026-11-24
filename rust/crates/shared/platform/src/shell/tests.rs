//! Go `shell_test.go`·`shell_bash_test.go` 를 옮겼다.

use std::collections::HashMap;
use std::path::Path;

use super::*;
use dm_gocompat::filepath;

fn fake_env(kv: &[(&str, &str)]) -> EnvFn {
    let m: HashMap<String, String> = kv
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Box::new(move |k| m.get(k).cloned().unwrap_or_default())
}

fn fake_stat(exist: &[&str]) -> StatFn {
    let v: Vec<String> = exist.iter().map(|s| s.to_string()).collect();
    Box::new(move |p| v.iter().any(|e| e == p))
}

/// 주어진 이름만 찾아지는 LookPath 대역. 반환 경로는 `/usr/bin/<name>` 이다.
pub(crate) fn fake_look(found: &[&str]) -> LookFn {
    let v: Vec<String> = found.iter().map(|s| s.to_string()).collect();
    Box::new(move |n| v.iter().any(|e| e == n).then(|| format!("/usr/bin/{n}")))
}

fn posix(env: &[(&str, &str)], exist: &[&str]) -> PosixShell {
    PosixShell {
        env: fake_env(env),
        stat: fake_stat(exist),
    }
}

fn windows(env: &[(&str, &str)], found: &[&str]) -> WindowsShell {
    WindowsShell {
        env: fake_env(env),
        look: fake_look(found),
    }
}

fn shell(p: &dyn ShellProvider, bin: &str) -> ShellSpec {
    p.shell(Path::new(bin))
}

#[test]
fn posix_shell_prefers_shell() {
    let s = posix(
        &[("SHELL", "/usr/local/bin/fish")],
        &["/usr/local/bin/fish", "/bin/bash", "/bin/sh"],
    );
    let spec = shell(&s, "/home/u/.dongminal/bin");
    assert_eq!(spec.path, "/usr/local/bin/fish");
    assert_eq!(spec.args, ["-l"]);
    assert_eq!(
        spec.env,
        [
            "LANG=en_US.UTF-8",
            "LC_ALL=en_US.UTF-8",
            "LC_CTYPE=en_US.UTF-8",
            "SHELL_SESSIONS_DISABLE=1",
            "SHELL=/usr/local/bin/fish",
        ]
    );
}

#[test]
fn posix_shell_falls_back_when_shell_missing() {
    let s = posix(&[("SHELL", "/opt/removed/zsh")], &["/bin/bash", "/bin/sh"]);
    assert_eq!(shell(&s, "/b").path, "/bin/bash");
}

#[test]
fn posix_shell_falls_back_to_sh() {
    let s = posix(&[], &["/bin/sh"]);
    assert_eq!(shell(&s, "/b").path, "/bin/sh");
}

#[test]
fn posix_shell_never_returns_empty() {
    let s = posix(&[], &[]);
    assert_eq!(shell(&s, "/b").path, "/bin/sh");
}

#[test]
fn posix_shell_hook_env_zsh() {
    let bin = "/home/u/bin";
    let s = posix(&[("SHELL", "/bin/zsh")], &["/bin/zsh"]);
    let spec = shell(&s, bin);
    assert_eq!(spec.args, ["-l"], "zsh 는 로그인 셸 그대로다");
    let want = format!("ZDOTDIR={}", filepath::join(&[bin, "zdotdir"]));
    assert_eq!(spec.env.last(), Some(&want));
    assert!(spec.env.contains(&"SHELL=/bin/zsh".to_owned()));
}

#[test]
fn posix_shell_bash_uses_rcfile() {
    let bin = "/home/u/bin";
    let s = posix(&[("SHELL", "/bin/bash")], &["/bin/bash"]);
    let spec = shell(&s, bin);
    assert_eq!(
        spec.args,
        [
            "--rcfile".to_owned(),
            filepath::join(&[bin, "bash-hook.sh"])
        ]
    );
    assert!(!spec.env.iter().any(|e| e.starts_with("BASH_ENV=")));
    assert!(spec.env.contains(&"SHELL=/bin/bash".to_owned()));
}

#[test]
fn posix_shell_hook_path_is_cleaned() {
    let s = posix(&[("SHELL", "/bin/zsh")], &["/bin/zsh"]);
    let spec = shell(&s, "/home/u/./x/../bin/");
    assert_eq!(
        spec.env.last().map(String::as_str),
        Some("ZDOTDIR=/home/u/bin/zdotdir")
    );
}

#[test]
fn posix_shell_no_hook_for_unknown_shell() {
    let s = posix(&[("SHELL", "/bin/fish")], &["/bin/fish"]);
    let spec = shell(&s, "/b");
    assert_eq!(spec.args, ["-l"]);
    assert!(
        !spec
            .env
            .iter()
            .any(|e| e.starts_with("ZDOTDIR=") || e.starts_with("BASH_ENV="))
    );
}

#[test]
fn posix_shell_commands() {
    let s = posix(&[("SHELL", "/bin/zsh")], &["/bin/zsh"]);
    assert_eq!(
        s.echo_command("hi there"),
        ["/bin/zsh", "-c", "echo hi there"]
    );
    assert_eq!(s.run_command("ls -l"), ["/bin/zsh", "-c", "ls -l"]);
}

#[test]
fn posix_hook_root() {
    assert_eq!(posix(&[], &[]).hook_root(), POSIX_HOOK_ROOT);
}

// ── windows ──────────────────────────────────────────

#[test]
fn windows_shell_prefers_pwsh() {
    let s = windows(&[], &["pwsh.exe", "powershell.exe", "cmd.exe"]);
    let spec = shell(&s, r"C:\home\bin");
    assert_eq!(spec.path, "/usr/bin/pwsh.exe");
    let want = dot_source(&filepath::join(&[r"C:\home\bin", POWERSHELL_HOOK_FILE]));
    assert_eq!(
        spec.args,
        [
            "-NoLogo",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            want.as_str()
        ]
    );
    assert!(spec.env.is_empty());
}

#[test]
fn dot_source_escapes_quote() {
    assert_eq!(
        dot_source(r"C:\Users\O'Brien\bin\hook.ps1"),
        r". 'C:\Users\O''Brien\bin\hook.ps1'"
    );
}

#[test]
fn windows_shell_honors_override() {
    let s = windows(&[("DONGMINAL_SHELL", r"C:\nu\nu.exe")], &["pwsh.exe"]);
    let spec = shell(&s, r"C:\b");
    assert_eq!(spec.path, r"C:\nu\nu.exe");
    assert!(spec.args.is_empty());
}

#[test]
fn windows_shell_cmd_gets_no_hook() {
    let s = windows(&[], &["cmd.exe"]);
    let spec = shell(&s, r"C:\b");
    assert_eq!(spec.path, "/usr/bin/cmd.exe");
    assert!(spec.args.is_empty());
}

#[test]
fn windows_shell_never_returns_empty() {
    let s = windows(&[], &[]);
    assert_eq!(shell(&s, r"C:\b").path, "cmd.exe");
}

#[test]
fn windows_shell_commands() {
    let s = windows(&[], &["powershell.exe"]);
    assert_eq!(
        s.run_command("Get-Date"),
        [
            "/usr/bin/powershell.exe",
            "-NoLogo",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Get-Date"
        ]
    );
    let c = windows(&[], &["cmd.exe"]);
    assert_eq!(c.run_command("dir"), ["/usr/bin/cmd.exe", "/c", "dir"]);
    assert_eq!(c.echo_command("x"), ["cmd.exe", "/c", "echo x"]);
    let e = windows(&[("ComSpec", r"C:\Windows\system32\cmd.exe")], &[]);
    assert_eq!(
        e.echo_command("x"),
        [r"C:\Windows\system32\cmd.exe", "/c", "echo x"]
    );
}

#[test]
fn windows_hook_root() {
    assert_eq!(windows(&[], &[]).hook_root(), WINDOWS_HOOK_ROOT);
}

// ── 인용 ─────────────────────────────────────────────

#[test]
fn shell_quote_escapes_apostrophe() {
    let input = r#"it's "quoted" $HOME"#;
    assert_eq!(posix(&[], &[]).quote(input), r#"'it'\''s "quoted" $HOME'"#);
    assert_eq!(windows(&[], &[]).quote(input), r#"'it''s "quoted" $HOME'"#);
}

#[test]
fn dot_source_uses_the_windows_quoting() {
    let p = r"C:\Users\O'Brien\bin\hook.ps1";
    assert_eq!(dot_source(p), format!(". {}", windows(&[], &[]).quote(p)));
}

/// sh 의 인용 해제. 인용 밖의 맨 문자는 전개될 수 있으므로 실패로 본다.
fn unquote_posix(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' => {
                let j = b[i + 1..].iter().position(|&c| c == b'\'')?;
                out.extend_from_slice(&b[i + 1..i + 1 + j]);
                i += j + 2;
            }
            b'\\' => {
                out.push(*b.get(i + 1)?);
                i += 2;
            }
            _ => return None,
        }
    }
    String::from_utf8(out).ok()
}

/// PowerShell 축자 문자열의 해제. 안쪽 홑따옴표는 짝을 이뤄야 한다.
fn unquote_power_shell(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() < 2 || b[0] != b'\'' || b[b.len() - 1] != b'\'' {
        return None;
    }
    let body = &b[1..b.len() - 1];
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if body[i] != b'\'' {
            out.push(body[i]);
            i += 1;
            continue;
        }
        if body.get(i + 1) != Some(&b'\'') {
            return None;
        }
        out.push(b'\'');
        i += 2;
    }
    String::from_utf8(out).ok()
}

#[test]
fn shell_quote_round_trips() {
    let p = posix(&[], &[]);
    let w = windows(&[], &[]);
    for input in [
        "",
        "plain",
        "it's",
        "'",
        "''",
        "a'b'c",
        "여러\n줄",
        "$HOME `date` \"q\" \\ *",
        r"C:\Users\O'Brien\bin",
    ] {
        assert_eq!(unquote_posix(&p.quote(input)).as_deref(), Some(input));
        assert_eq!(unquote_power_shell(&w.quote(input)).as_deref(), Some(input));
    }
}

#[test]
fn shell_quote_rules_are_not_interchangeable() {
    let input = "it's";
    assert_eq!(unquote_power_shell(&posix(&[], &[]).quote(input)), None);
    assert_ne!(
        unquote_posix(&windows(&[], &[]).quote(input)).as_deref(),
        Some(input)
    );
}

// ── 상대경로 훅은 걸지 않는다 ──────────────────────────

#[test]
fn posix_shell_skips_relative_hook_dir() {
    for bin in ["", "bin", "./bin", "../bin"] {
        let z = posix(&[("SHELL", "/bin/zsh")], &["/bin/zsh"]);
        assert!(
            !shell(&z, bin).env.iter().any(|e| e.starts_with("ZDOTDIR=")),
            "bin={bin:?}"
        );
        let b = posix(&[("SHELL", "/bin/bash")], &["/bin/bash"]);
        assert_eq!(shell(&b, bin).args, ["-l"], "bin={bin:?}");
    }
}

#[test]
fn windows_shell_skips_relative_hook_dir() {
    for bin in ["", "bin", r"bin\sub", r".\bin"] {
        let s = windows(&[], &["pwsh.exe"]);
        assert!(shell(&s, bin).args.is_empty(), "bin={bin:?}");
    }
}

#[test]
fn windows_shell_keeps_absolute_hook_dir() {
    for bin in [r"C:\home\bin", "C:/home/bin", r"\\srv\share\bin"] {
        let s = windows(&[], &["pwsh.exe"]);
        let want = dot_source(&filepath::join(&[bin, POWERSHELL_HOOK_FILE]));
        assert!(shell(&s, bin).args.contains(&want), "bin={bin:?}");
    }
}

#[test]
fn current_hook_root_matches_build() {
    let want = if cfg!(windows) {
        WINDOWS_HOOK_ROOT
    } else {
        POSIX_HOOK_ROOT
    };
    assert_eq!(current().hook_root(), want);
}

// RUST_PORT_SRS 3.7 D-2: PowerShell 은 굽은 홑따옴표도 문자열을 닫는 따옴표로 읽는다.
#[test]
fn power_shell_quote_doubles_curly_quotes() {
    let w = windows(&[], &[]);
    assert_eq!(w.quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
    assert_eq!(
        w.quote("\u{2018}\u{201A}\u{201B}'"),
        "'\u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}'''"
    );
    assert_eq!(w.quote("plain"), "'plain'");
}
