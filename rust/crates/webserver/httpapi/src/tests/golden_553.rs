//! 5.5.3 종단의 Go 골든 대조. 기대값은 go1.27.2 기준선의 핸들러를 임시 시험으로 돌려 뽑았다. 시각에
//! 기대는 값(`updatedAt`·`observedAt`·`waitedMs`·`resetsInSec`·`quietMs`·`lastOutputAt`)과 프로세스 전역 계수 `seq` 는 양쪽에서
//! `N` 으로 가린다.

use std::sync::{Arc, Mutex};

use super::attnenv::*;
use super::fakes::FakeSettings;
use super::support::*;
use crate::{Deps, Server};

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn mask(s: &str) -> String {
    let re = regex::Regex::new(
        r#""(updatedAt|observedAt|waitedMs|resetsInSec|quietMs|lastOutputAt|seq)":-?[0-9.e+]+"#,
    )
    .unwrap();
    re.replace_all(s, r#""$1":N"#).into_owned()
}

fn dump(m: &str, p: &str, r: &Resp) -> String {
    let mut hs: Vec<String> = r
        .headers
        .iter()
        .filter(|(k, _)| k.as_str() != "x-request-id")
        .map(|(k, v)| format!("{}={}", canon(k.as_str()), v.to_str().unwrap()))
        .collect();
    hs.sort();
    format!(
        "== {m} {p}\n{} {}\n{}\n",
        r.status,
        hs.join("|"),
        dm_gocompat::strconv::quote(&mask(&r.body))
    )
}

#[tokio::test]
async fn golden_553() {
    let st = Arc::new(FakeSettings {
        blob: Mutex::new(br#"{"migrationHook":true}"#.to_vec()),
    });
    let env = tracked_with(&["p1"], move |d| d.settings = Some(st));
    let d2 = tempfile::tempdir().unwrap();
    let nosrv = server(d2.path(), Deps::default());
    let srv = &env.srv;
    let usage = r#"{"toolId":"p1","usage":{"sessionId":"s1","model":{"id":"claude-opus-5-5","displayName":"Opus 5.5"},"effort":"medium","contextWindow":{"windowTokens":1000000,"usedPct":6,"currentUsage":{"inputTokens":6,"cacheCreationInputTokens":62146}},"rateLimits":{"seven_day":{"usedPct":91},"five_hour":{"usedPct":72.5,"resetsAt":4102444800000}},"transcriptPath":"/x"}}"#;
    let subs = r#"{"toolId":"p1","tasks":[{"id":"late","agentType":"Plan","status":"completed","model":"m","effortBudget":8000,"windowTokens":200000,"tokens":180000,"startTime":2000},{"id":"nost","status":"running"},{"id":"early","agentType":"Explore","status":"running","effort":"low","windowTokens":1000000,"tokens":19250,"startTime":1000,"description":"Find\u0007 it <&>"}]}"#;
    let reqs: Vec<(&Arc<Server>, &str, &str, &str)> = vec![
        (srv, "GET", "/api/tools/attention", ""),
        (
            srv,
            "POST",
            "/api/tools/attention/set",
            r#"{"toolId":"p1","reason":"done"}"#,
        ),
        (srv, "GET", "/api/tools/attention", ""),
        (srv, "POST", "/api/tools/attention/set", "{bad"),
        (srv, "POST", "/api/tools/attention/set", "{}"),
        (srv, "POST", "/api/tools/attention/set", ""),
        (
            srv,
            "POST",
            "/api/tools/attention/clear",
            r#"{"toolId":"p1","typed":true}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/attention/clear",
            r#"{"typed":true}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/attention/set",
            r#"{"toolId":"p1"}"#,
        ),
        (srv, "POST", "/api/tools/attention/clear-all", ""),
        (
            srv,
            "POST",
            "/api/tools/attention/claim",
            r#"{"seq":5,"kinds":["banner","x","sound"]}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/attention/claim",
            r#"{"seq":5,"kinds":["banner"]}"#,
        ),
        (srv, "POST", "/api/tools/attention/claim", r#"{"seq":0}"#),
        (srv, "POST", "/api/tools/attention/claim", "not json"),
        (srv, "POST", "/api/tools/attention/claim", r#"{"seq":6}"#),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","state":"working","tool":"Bash","detail":"go\u0007 test <&>"}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","state":"bogus"}"#,
        ),
        (srv, "POST", "/api/tools/activity/set", r#"{"toolId":"p1"}"#),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","agentId":"a1","state":"idle"}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","agentId":"a1","agentType":"Plan","state":"working","tool":"Read","detail":"x"}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","agentId":"hook","agentType":"gp","state":"waiting"}"#,
        ),
        (srv, "POST", "/api/tools/usage", usage),
        (srv, "POST", "/api/tools/usage", r#"{"usage":{}}"#),
        (srv, "POST", "/api/tools/usage", "{bad"),
        (srv, "POST", "/api/tools/subagents", subs),
        (srv, "POST", "/api/tools/subagents", r#"{"tasks":[]}"#),
        (srv, "POST", "/api/tools/subagents", "[]"),
        (srv, "GET", "/api/tools/activity", ""),
        (srv, "GET", "/api/tools/activity/get?id=p1", ""),
        (srv, "GET", "/api/tools/activity/get?id=nope", ""),
        (srv, "GET", "/api/tools/activity/get", ""),
        (srv, "GET", "/api/tools/activity/wait?id=p1&for=bogus", ""),
        (
            srv,
            "GET",
            "/api/tools/activity/wait?id=p1&for=ready&timeoutMs=abc",
            "",
        ),
        (srv, "GET", "/api/tools/activity/wait?id=nope&for=ready", ""),
        (
            srv,
            "GET",
            "/api/tools/activity/wait?id=p1&for=ready&timeoutMs=1",
            "",
        ),
        (srv, "GET", "/api/tools/migration-advice?id=p1", ""),
        (srv, "GET", "/api/tools/migration-advice?id=%20zz%20", ""),
        (srv, "GET", "/api/tools/migration-advice?id=zz", ""),
        (&nosrv, "GET", "/api/tools/migration-advice?id=zz", ""),
        (srv, "GET", "/api/tools/background", ""),
        (
            srv,
            "POST",
            "/api/tools/background/set",
            r#"{"toolId":"nope","background":true}"#,
        ),
        (srv, "POST", "/api/tools/background/set", "{}"),
        (srv, "POST", "/api/tools/background/set", "{bad"),
        (
            srv,
            "GET",
            "/api/snapshot?parts=attention,activity,background,focus,bogus,activity",
            "",
        ),
        (srv, "GET", "/api/snapshot", ""),
        (
            &nosrv,
            "GET",
            "/api/snapshot?parts=attention,activity,background",
            "",
        ),
        (&nosrv, "GET", "/api/tools/activity", ""),
        (&nosrv, "GET", "/api/tools/activity/get?id=p1", ""),
        (
            &nosrv,
            "GET",
            "/api/tools/activity/wait?id=p1&for=ready",
            "",
        ),
        (&nosrv, "POST", "/api/tools/attention/clear-all", ""),
        (
            &nosrv,
            "POST",
            "/api/tools/background/set",
            r#"{"toolId":"p1"}"#,
        ),
        (
            srv,
            "POST",
            "/api/tools/activity/set",
            r#"{"toolId":"p1","state":"ended"}"#,
        ),
        (srv, "GET", "/api/tools/activity", ""),
    ];
    let mut out = String::new();
    for (s, m, p, body) in reqs {
        let h: &[(&str, &str)] = if m == "GET" {
            &[]
        } else {
            &[("Content-Type", "application/json")]
        };
        let r = call(s, m, p, h, body, LOCAL).await;
        out.push_str(&dump(m, p, &r));
    }
    for b in env.cmds.published() {
        out.push_str(&format!(
            "== broadcast\n{}\n",
            dm_gocompat::strconv::quote(&mask(&b))
        ));
    }
    let want = include_str!("go_golden_553.txt");
    if out != want {
        for (i, (a, b)) in out.lines().zip(want.lines()).enumerate() {
            if a != b {
                panic!("{i} 줄이 다르다\nrust: {a}\ngo:   {b}");
            }
        }
        panic!(
            "줄 수가 다르다: rust {} go {}",
            out.lines().count(),
            want.lines().count()
        );
    }
}
