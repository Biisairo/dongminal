//! Go 기준선 바이너리의 실제 출력과 바이트 단위로 대조한다 (FR-RSP-3).
//!
//! `testdata/*.json` 은 `127ff7d9` 를 go1.27.2 로 빌드한 바이너리를 격리 실행(DONGMINAL_* 없음)으로
//! 돌려 뽑았다. 입력은 도움말, 파서가 실행 전에 거절하는 인자, 그리고 없는 홈을 겨눈 읽기 전용
//! `config show|validate|get` 이다.

use serde::Deserialize;

use super::{Vars, args, no_serve, with_env};
use crate::VERSION;
use crate::actions::dispatch_in;

#[derive(Default, Deserialize)]
#[serde(default)]
struct Case {
    args: Vec<String>,
    exit: i32,
    stdout: String,
    stderr: String,
}

const CLI: &str = include_str!("../../testdata/go_cli_golden.json");
#[cfg(unix)]
const CONFIG: &str = include_str!("../../testdata/go_cli_golden_home.json");

/// 정답 자료는 새기지 않은 Go 빌드(`dev`)에서 뽑았다.
fn stamp(s: &str) -> String {
    s.replace("dongminal dev ", &format!("dongminal {VERSION} "))
}

fn check(golden: &str) {
    let cases: Vec<Case> = dm_gocompat::json::unmarshal(golden.as_bytes()).unwrap();
    assert!(!cases.is_empty(), "정답 자료가 비었다");
    // 격리 실행과 같은 전제: DONGMINAL_* 가 없고, 사용자 홈은 없는 자리다.
    let vars = Vars::new(&[(super::USER_HOME_VAR, "/tmp/dm611-nouser")]);
    let mut bad = Vec::new();
    for c in &cases {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = with_env(&vars, |env| {
            dispatch_in(&args_of(c), env, &no_serve, &mut out, &mut err)
        });
        let (out, err) = (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        );
        if code != c.exit || out != stamp(&c.stdout) || err != stamp(&c.stderr) {
            bad.push(format!(
                "{:?}\n  exit go={} rust={}\n  stdout go={:?}\n       rust={:?}\n  stderr go={:?}\n       rust={:?}",
                c.args, c.exit, code, c.stdout, out, c.stderr, err
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{}건 다르다:\n{}",
        bad.len(),
        bad.join("\n")
    );
}

fn args_of(c: &Case) -> Vec<String> {
    let a: Vec<&str> = c.args.iter().map(String::as_str).collect();
    args(&a)
}

#[test]
fn help_and_parse_errors_match_go() {
    check(CLI);
}

#[cfg(unix)]
#[test]
fn config_reads_match_go() {
    check(CONFIG);
}
