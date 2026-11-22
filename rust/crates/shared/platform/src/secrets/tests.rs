//! Go `secrets_test.go` (CLAUDE_ACCOUNTS_SRS TC-CAC-2) 를 옮겼다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::*;

#[derive(Clone, Debug, PartialEq)]
struct Call {
    stdin: Option<String>,
    name: String,
    args: Vec<String>,
}

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<Call>>,
}

fn keychain(
    out: &[u8],
    code: i32,
    err: Option<&str>,
    env: &[(&str, &str)],
) -> (MacKeychain, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    let f = Arc::clone(&fake);
    let out = out.to_vec();
    let err = err.map(str::to_owned);
    let run: RunFn = Box::new(move |stdin, name, args| {
        f.calls.lock().unwrap().push(Call {
            stdin: stdin.map(|b| String::from_utf8_lossy(b).into_owned()),
            name: name.to_owned(),
            args: args.iter().map(|a| a.to_string()).collect(),
        });
        match &err {
            Some(e) => Err(e.clone()),
            None => Ok((out.clone(), code)),
        }
    });
    let m: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let k = MacKeychain {
        run,
        env: Box::new(move |k| m.get(k).cloned().unwrap_or_default()),
        home: Box::new(|| Some("/Users/someone".to_owned())),
    };
    (k, fake)
}

fn calls(f: &Fake) -> Vec<Call> {
    f.calls.lock().unwrap().clone()
}

#[test]
fn keychain_get_found() {
    let (k, f) = keychain(b"{\"a\":1}\n", 0, None, &[]);
    assert_eq!(k.get("svc", "acct"), Ok(Some("{\"a\":1}".to_owned())));
    let c = &calls(&f)[0];
    assert_eq!(c.name, "/usr/bin/security");
    assert_eq!(c.stdin, None);
    assert_eq!(
        c.args,
        ["find-generic-password", "-a", "acct", "-w", "-s", "svc"]
    );
}

#[test]
fn keychain_get_strips_only_one_newline() {
    let (k, _) = keychain(b"x\n\n", 0, None, &[]);
    assert_eq!(k.get("s", "a"), Ok(Some("x\n".to_owned())));
}

#[test]
fn keychain_get_not_found() {
    let (k, _) = keychain(b"", KEYCHAIN_NOT_FOUND, None, &[]);
    assert_eq!(k.get("s", "a"), Ok(None));
}

#[test]
fn keychain_get_error_hides_output() {
    let (k, _) = keychain(b"SECRET-VALUE", 51, None, &[]);
    let e = k.get("s", "a").expect_err("want error");
    assert_eq!(e.to_string(), "keychain read failed (rc=51)");
}

#[test]
fn keychain_run_error_texts() {
    let (k, _) = keychain(b"", 0, Some("signal: killed"), &[]);
    assert_eq!(
        k.get("s", "a").unwrap_err().to_string(),
        "keychain read: signal: killed"
    );
    assert_eq!(
        k.set("s", "a", "v").unwrap_err().to_string(),
        "keychain write: signal: killed"
    );
    assert_eq!(
        k.delete("s", "a").unwrap_err().to_string(),
        "keychain delete: signal: killed"
    );
}

#[test]
fn keychain_set_uses_stdin() {
    let (k, f) = keychain(b"", 0, None, &[]);
    assert_eq!(k.set("Claude Code-credentials", "me", "tok\"en"), Ok(()));
    let c = &calls(&f)[0];
    assert_eq!(c.args, ["-i"]);
    let want = format!(
        "add-generic-password -U -a \"me\" -s \"Claude Code-credentials\" -X {}\n",
        "746f6b22656e"
    );
    assert_eq!(c.stdin.as_deref(), Some(want.as_str()));
}

#[test]
fn keychain_set_quotes_escapes() {
    let (k, f) = keychain(b"", 0, None, &[]);
    let _ = k.set(r#"s"v\c"#, "a", "v");
    let stdin = calls(&f)[0].stdin.clone().unwrap();
    assert!(stdin.contains(r#"-s "s\"v\\c""#), "stdin {stdin:?}");
}

#[test]
fn keychain_set_long_refuses_argv() {
    let (k, f) = keychain(b"", 0, None, &[]);
    let long = "x".repeat(KEYCHAIN_LINE_MAX);
    assert_eq!(k.set("s", "a", &long), Err(SecretsError::TooLong));
    assert!(calls(&f).is_empty(), "security 를 부르지 않는다");
    assert_eq!(
        SecretsError::TooLong.to_string(),
        "keychain write: value too long for security -i"
    );
}

#[test]
fn keychain_set_line_boundary() {
    let prefix = r#"add-generic-password -U -a "a" -s "s" -X "#;
    let n = (KEYCHAIN_LINE_MAX - prefix.len() - 1) / 2;
    let (k, f) = keychain(b"", 0, None, &[]);
    assert_eq!(k.set("s", "a", &"y".repeat(n)), Ok(()));
    let c = &calls(&f)[0];
    assert!(c.stdin.as_ref().unwrap().len() <= KEYCHAIN_LINE_MAX);
    assert_eq!(c.args, ["-i"]);
    // 한 바이트 더 길면 상한을 넘는다.
    let (k, _) = keychain(b"", 0, None, &[]);
    assert_eq!(
        k.set("s", "a", &"y".repeat(n + 1)),
        Err(SecretsError::TooLong)
    );
}

#[test]
fn keychain_set_failure() {
    let (k, _) = keychain(b"", 1, None, &[]);
    assert_eq!(
        k.set("s", "a", "v").unwrap_err().to_string(),
        "keychain write failed (rc=1)"
    );
}

#[test]
fn keychain_delete() {
    for code in [0, KEYCHAIN_NOT_FOUND] {
        let (k, f) = keychain(b"", code, None, &[]);
        assert_eq!(k.delete("s", "a"), Ok(()), "code {code}");
        assert_eq!(
            calls(&f)[0].args,
            ["delete-generic-password", "-a", "a", "-s", "s"]
        );
    }
    let (k, _) = keychain(b"", 2, None, &[]);
    assert_eq!(
        k.delete("s", "a").unwrap_err().to_string(),
        "keychain delete failed (rc=2)"
    );
}

#[test]
fn keychain_account() {
    let (k, _) = keychain(b"", 0, None, &[("USER", "alice")]);
    assert_eq!(k.account(), "alice");
    let (k, _) = keychain(b"", 0, None, &[]);
    assert_eq!(k.account(), "someone");
    let (mut k, _) = keychain(b"", 0, None, &[]);
    k.home = Box::new(|| None);
    assert_eq!(k.account(), KEYCHAIN_DEFAULT_ACCOUNT);
    k.home = Box::new(|| Some("/".to_owned()));
    assert_eq!(k.account(), KEYCHAIN_DEFAULT_ACCOUNT);
    assert!(k.available());
}

#[test]
fn hex_matches_go() {
    assert_eq!(hex_encode(b""), "");
    assert_eq!(hex_encode(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
    assert_eq!(hex_encode("한".as_bytes()), "ed959c");
}

#[test]
fn no_secrets_contract() {
    let s = NoSecrets;
    assert!(!s.available());
    assert_eq!(s.account(), "claude-code-user");
    assert_eq!(s.get("a", "b"), Err(SecretsError::Unavailable));
    assert_eq!(s.set("a", "b", "c"), Err(SecretsError::Unavailable));
    assert_eq!(s.delete("a", "b"), Ok(()));
    assert_eq!(
        SecretsError::Unavailable.to_string(),
        "비밀 저장소가 없습니다"
    );
}

#[test]
fn current_matches_build() {
    assert_eq!(
        crate::current().secrets.available(),
        cfg!(target_os = "macos")
    );
}

// 실제 프로세스로 실행기 계약을 잰다. security 는 부르지 않는다.
#[cfg(unix)]
#[test]
fn run_with_stdin_real_process() {
    let (out, code) = run_with_stdin(Some(b"abc"), "/bin/cat", &[]).unwrap();
    assert_eq!((out.as_slice(), code), (&b"abc"[..], 0));
    let (out, code) = run_with_stdin(None, "/bin/sh", &["-c", "printf x; exit 44"]).unwrap();
    assert_eq!((out.as_slice(), code), (&b"x"[..], 44));
    let (out, _) = run_with_stdin(None, "/bin/cat", &[]).unwrap();
    assert!(out.is_empty(), "표준 입력이 없으면 /dev/null 이다");
    assert_eq!(
        run_with_stdin(None, "/nonexistent/security", &[]).unwrap_err(),
        "fork/exec /nonexistent/security: no such file or directory"
    );
}
