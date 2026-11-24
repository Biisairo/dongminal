//! Go 기준선 바이너리의 실제 출력과 바이트 단위로 대조한다 (FR-RSP-3).
//!
//! `testdata/*.json` 은 `127ff7d9` 를 go1.27.2 로 빌드한 바이너리를 격리 실행(OTTERMINAL_* 없음)으로
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
    s.replace("otterminal dev ", &format!("otterminal {VERSION} "))
}

fn check(golden: &str) {
    // OTTERMINAL_RENAME_SRS FR-REN-10: 정답 자료는 옛 이름으로 기록되어 있다.
    let golden = &otter_shared_otterenv::legacy::current_names(golden);
    let cases: Vec<Case> = otter_gocompat::json::unmarshal(golden.as_bytes()).unwrap();
    assert!(!cases.is_empty(), "정답 자료가 비었다");
    // 격리 실행과 같은 전제: OTTERMINAL_* 가 없고, 사용자 홈은 없는 자리다.
    let vars = Vars::new(&[(super::USER_HOME_VAR, "/tmp/dm611-nouser")]);
    let mut bad = Vec::new();
    for c in &cases {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = with_env(&vars, |env| {
            dispatch_in(&args_of(c), env, &no_serve, &mut out, &mut err)
        });
        let (out, err) = (
            without_post_go_settings(&String::from_utf8(out).unwrap()),
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

/// Go 기준선 뒤에 더한 설정. 정답 자료에 없으므로 견주기 전에 뺀다 (OTTERMINAL_RENAME_SRS FR-FAV-4).
const POST_GO_SETTINGS: &[&str] = &["attnFavicon"];

fn without_post_go_settings(out: &str) -> String {
    POST_GO_SETTINGS.iter().fold(out.to_owned(), |acc, key| {
        let head = format!(",\n    {{\n      \"key\": \"{key}\",");
        let Some(start) = acc.find(&head) else {
            return acc;
        };
        let Some(len) = acc[start + 1..].find("\n    }") else {
            return acc;
        };
        format!(
            "{}{}",
            &acc[..start],
            &acc[start + 1 + len + "\n    }".len()..]
        )
    })
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
