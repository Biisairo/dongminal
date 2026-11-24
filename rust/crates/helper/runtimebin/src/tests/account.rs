//! `dmctl account` (Go dmctl_account*_test.go·httpexit_test.go 의 관측 기대값).

use std::collections::HashMap;

use serde_json::Value;

use super::*;
use crate::dmctl::account::span_for_test;

const ACCOUNTS_FAKE_JSON: &str = r#"{"activeId":"id-b","accounts":[
 {"id":"id-a","email":"a@x.com","organizationName":"Org A","alias":"work","color":"acct-1","disabled":false,"priority":0},
 {"id":"id-b","email":"b@x.com","organizationName":"Org B","color":"acct-2","disabled":true,"priority":3}]}"#;

const ACCOUNTS_USAGE_JSON: &str = r#"{"activeId":"id-a","accounts":[
 {"id":"id-a","email":"a@x.com","alias":"work","color":"acct-1","active":true,"usage":{
   "status":"ok","fetchedAt":1794000000,"ageSeconds":30,
   "windows":{"fiveHour":{"pct":34.4,"resetsAt":1794007800,"resetsInSec":7800,"level":""},
     "sevenDay":{"pct":72,"resetsAt":1794368000,"resetsInSec":368000,"level":"warn"},
     "scoped":[{"name":"Opus","pct":95,"level":"critical"}],
     "spend":{"used":12.4,"limit":50,"pct":24.8,"currency":"USD"}},
   "pace":{"sevenDay":{"expectedPct":22,"aheadOfPace":true,"willLastToReset":false}},
   "loginExpiresAt":1796000000,"loginExpiringSoon":true}},
 {"id":"id-b","email":"b@x.com","color":"acct-2","active":false,"usage":{
   "status":"relogin_required","stale":true,"ageSeconds":420,
   "windows":{"fiveHour":{"pct":5,"level":""}},"pace":{}}},
 {"id":"id-c","email":"c@x.com","color":"acct-3","active":false,"usage":{"pace":{}}}]}"#;

const ACCOUNTS_RESETS_JSON: &str = r#"{"activeId":"id-a","accounts":[
 {"id":"id-a","email":"a@x.com","alias":"work","active":true,"usage":{"status":"ok",
   "windows":{"fiveHour":{"pct":100,"level":"critical"}},"pace":{},
   "resets":{"fetchedAt":1794000000,
     "juniperTide":{"eligible":true,"available":false,"nextAvailableAt":1794100000},
     "cedarEmber":{"eligible":true,"atLimit":true,"exhausted":[],"grants":[
       {"id":"g_1","label":"Fable reset","resetsTotal":3,"resetsLeft":2,"endsAt":1796000000,"clears":["five_hour","seven_day"],
        "paused":false,"usableNow":true,"useRequiresLimit":true,"blocking":[],"givesBackWeekly":true},
       {"id":"g_0","label":"Used up","resetsTotal":1,"resetsLeft":0,"clears":[],"paused":false,"usableNow":false,"useRequiresLimit":true,"blocking":[],"givesBackWeekly":false}]}}}}]}"#;

const AUTO_FAKE_JSON: &str = r#"{"settings":{"enabled":true,"threshold":90,"weeklyThreshold":null,"intervalSeconds":60,"cooldownSeconds":300,
 "hysteresisPct":10,"strategy":"best","unhealthyTicks":3,"models":null},
 "state":{"status":"on","lastSwitch":{"at":1800000000,"from":"id-b","to":"id-a","trigger":"proactive","leftHeadroom":8},"quarantined":[]}}"#;

const MAPPINGS_FAKE_JSON: &str =
    r#"{"folders":{"/repo":{"accountId":"id-a"}},"tabs":{"tool-9":{"accountId":"id-b"}}}"#;

/// "METHOD /path" → 본문. 없는 길은 404 `{code,message}` 다 (Go withAccountServer).
struct Acct {
    srv: TestServer,
    _home: tempfile::TempDir,
    env: Env,
}

impl Acct {
    fn new(routes: &[(&str, &str)]) -> Self {
        let routes: HashMap<String, String> = routes
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let srv =
            TestServer::new(
                move |r| match routes.get(&format!("{} {}", r.method, r.path())) {
                    Some(b) => (200, b.clone().into_bytes()),
                    None => (
                        404,
                        r#"{"code":"claude_account_not_found","message":"없음"}"#
                            .as_bytes()
                            .to_vec(),
                    ),
                },
            );
        let home = tempfile::tempdir().unwrap();
        let env = srv.env(home.path());
        Self {
            srv,
            _home: home,
            env,
        }
    }
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let mut full = vec!["account"];
        full.extend_from_slice(args);
        dm(&self.env, &full)
    }
    fn stdin(&self, input: &str, args: &[&str]) -> (i32, String, String) {
        run_with(
            &self.env,
            crate::dmctl::account::run_dmctl_account,
            args,
            input.as_bytes(),
        )
    }
    fn reqs(&self) -> Vec<Req> {
        self.srv.requests()
    }
    fn last(&self) -> Req {
        self.reqs().pop().unwrap()
    }
}

#[test]
fn list_text_and_json() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON)]);
    let (rc, out, err) = a.run(&["list"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        out,
        "  work <a@x.com>  org=Org A  id=id-a\n* b@x.com  org=Org B  id=id-b  disabled\n"
    );
    let (rc, out, _) = a.run(&["list", "--json"]);
    assert_eq!(rc, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["schemaVersion"], 1);
    assert_eq!(v["activeId"], "id-b");
    assert!(out.starts_with(r#"{"accounts":[{"alias":"work","color":"acct-1","disabled":false,"email":"a@x.com","id":"id-a","organizationName":"Org A","priority":0}"#), "{out}");
}

/// FR-RDG-26 (DM-F5): account list --json 은 본문이 객체가 아니면 빈 객체에서 시작한다.
#[test]
fn list_json_null_body() {
    let srv = TestServer::fixed(200, "null");
    let home = tempfile::tempdir().unwrap();
    let (rc, out, err) = dm(&srv.env(home.path()), &["account", "list", "--json"]);
    assert_eq!(
        (rc, out.as_str(), err.as_str()),
        (0, "{\"schemaVersion\":1}\n", "")
    );
}

#[test]
fn add() {
    let a = Acct::new(&[(
        "POST /api/claude-accounts/add",
        r#"{"created":true,"account":{"id":"id-c","email":"c@x.com"}}"#,
    )]);
    let (rc, out, err) = a.run(&["add"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(a.reqs()[0].path(), "/api/claude-accounts/add");
    assert_eq!(out, "등록: c@x.com  id=id-c\n");
}

const SWITCH_ROUTES: &[(&str, &str)] = &[
    ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
    (
        "POST /api/claude-accounts/switch",
        r#"{"from":"id-b","to":"id-a"}"#,
    ),
];

#[test]
fn switch_resolves_ref_and_sends_by() {
    for r in ["id-a", "work", "a@x.com", "A@X.COM"] {
        let a = Acct::new(SWITCH_ROUTES);
        let (rc, out, err) = a.run(&["switch", r]);
        assert_eq!(rc, 0, "{r}: {err}");
        let last = a.last();
        assert_eq!(last.path(), "/api/claude-accounts/switch");
        assert_eq!(
            last.json(),
            serde_json::json!({"id": "id-a", "by": "dmctl"})
        );
        assert_eq!(
            out,
            "전환: work <a@x.com>\n새로 시작하는 Claude Code 세션부터 새 계정을 씁니다. 실행 중인 세션은 건드리지 않습니다.\n"
        );
    }
    for strat in ["next", "next-available"] {
        let a = Acct::new(SWITCH_ROUTES);
        assert_eq!(a.run(&["switch", "--strategy", strat]).0, 0);
        assert_eq!(
            a.last().json(),
            serde_json::json!({"strategy": strat, "by": "dmctl"})
        );
    }
}

#[test]
fn switch_best_stays_and_pinned_notice() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        (
            "POST /api/claude-accounts/switch",
            r#"{"from":"id-b","to":"id-b","noop":true,"reason":"current-unavailable"}"#,
        ),
    ]);
    let (rc, out, _) = a.run(&["switch", "--strategy", "best"]);
    assert_eq!(rc, 0);
    assert_eq!(out, "전환하지 않았습니다: 활성 계정의 사용량을 모릅니다\n");
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        (
            "POST /api/claude-accounts/switch",
            r#"{"from":"id-b","to":"id-a","pinnedRunning":true}"#,
        ),
    ]);
    let (rc, out, _) = a.run(&["switch", "work"]);
    assert_eq!(rc, 0);
    assert!(out.contains("고정 실행 중인 탭이 있습니다"), "{out}");
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        (
            "POST /api/claude-accounts/switch",
            r#"{"to":"id-b","noop":true}"#,
        ),
    ]);
    assert_eq!(
        a.run(&["switch", "b@x.com"]).1,
        "이미 활성 계정입니다: b@x.com\n"
    );
}

#[test]
fn errors() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON)]);
    let (rc, _, err) = a.run(&["switch", "nobody"]);
    assert_eq!(
        (rc, err.as_str()),
        (1, "dmctl account: 그런 계정이 없습니다: nobody\n")
    );
    assert_eq!(a.run(&["switch"]).0, 2);
    let (rc, _, err) = a.run(&["switch", "--strategy", "random"]);
    assert!(rc == 2 && err.contains("next-available"), "{err}");
    let (rc, _, err) = a.run(&["bogus"]);
    assert!(rc == 2 && err.starts_with("dmctl account: 모르는 하위 명령 \"bogus\"\n"));
    let (rc, out, _) = a.run(&["--help"]);
    assert!(rc == 0 && out.contains("dmctl account"));
    let (rc, _, err) = a.run(&["list", "--bogus"]);
    assert_eq!(
        (rc, err.as_str()),
        (2, "dmctl account list: unknown argument: --bogus\n")
    );
    let (rc, _, err) = a.run(&["add", "x"]);
    assert_eq!(
        (rc, err.as_str()),
        (2, "dmctl account add: 인자가 0 개여야 합니다\n")
    );
    let (rc, _, err) = dm(&a.env, &["account"]);
    assert!(rc == 2 && err.starts_with("dmctl account — "));
}

#[test]
fn span() {
    for (sec, want) in [
        (368000, "4일 6시간"),
        (7800, "2시간 10분"),
        (2100, "35분"),
        (0, "곧"),
    ] {
        assert_eq!(span_for_test(sec), want);
    }
}

#[test]
fn usage_text() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_USAGE_JSON)]);
    let (rc, out, err) = a.run(&["usage"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(a.reqs().len(), 1);
    for want in [
        "* work <a@x.com>\n",
        "    5시간 34%  2시간 10분 후 초기화\n",
        "    주간 72% (경고)  4일 6시간 후 초기화\n",
        "    주간 예측 예상 22% · 속도가 앞섬 · 초기화 전 소진\n",
        "    Opus 95% (위험)\n",
        "    추가 사용량 $12.40 / $50\n",
        "로그인 만료",
        "(7일 안)",
        "  b@x.com · relogin_required · 7분 전\n    5시간 5%\n",
        "  c@x.com\n    아직 조회하지 않음\n",
    ] {
        assert!(out.contains(want), "{want:?} 없음:\n{out}");
    }
    let (w, b, c) = (
        out.find("work").unwrap(),
        out.find("b@x.com").unwrap(),
        out.find("c@x.com").unwrap(),
    );
    assert!(w < b && b < c);
}

#[test]
fn usage_one() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_USAGE_JSON)]);
    let (rc, out, _) = a.run(&["usage", "B@X.com"]);
    assert!(
        rc == 0 && out.contains("b@x.com") && !out.contains("work") && !out.contains("c@x.com")
    );
    let (rc, _, err) = a.run(&["usage", "nobody"]);
    assert!(rc == 1 && err.contains("nobody"));
    assert_eq!(a.run(&["usage", "a", "b"]).0, 2);
}

#[test]
fn usage_refresh() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_USAGE_JSON),
        ("POST /api/claude-accounts/refresh", r#"{"ok":true}"#),
    ]);
    let (rc, out, err) = a.run(&["usage", "work", "--refresh"]);
    assert_eq!(rc, 0, "{err}");
    let reqs = a.reqs();
    let got: Vec<String> = reqs
        .iter()
        .map(|r| format!("{} {}", r.method, r.path()))
        .collect();
    assert_eq!(
        got,
        [
            "GET /api/claude-accounts",
            "POST /api/claude-accounts/refresh",
            "GET /api/claude-accounts"
        ]
    );
    assert_eq!(reqs[1].json()["id"], "id-a");
    assert!(out.contains("work"));
}

#[test]
fn usage_refresh_all_and_failure() {
    let n = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let n2 = n.clone();
    let srv = TestServer::new(move |r| {
        if r.method == "GET" {
            return (200, ACCOUNTS_USAGE_JSON.as_bytes().to_vec());
        }
        if n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == 2 {
            return (
                409,
                r#"{"code":"claude_too_soon","message":"1분 뒤에 다시 조회할 수 있습니다"}"#
                    .as_bytes()
                    .to_vec(),
            );
        }
        (200, br#"{"ok":true}"#.to_vec())
    });
    let home = tempfile::tempdir().unwrap();
    let (rc, out, err) = dm(&srv.env(home.path()), &["account", "usage", "--refresh"]);
    assert_eq!(n.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(rc, 1);
    assert_eq!(
        err,
        "dmctl: claude_too_soon: 1분 뒤에 다시 조회할 수 있습니다\n"
    );
    assert!(out.contains("c@x.com"));
}

#[test]
fn usage_json() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_USAGE_JSON)]);
    let (rc, out, _) = a.run(&["usage", "work", "--json"]);
    assert_eq!(rc, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["schemaVersion"], 1);
    assert_eq!(v["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(v["accounts"][0]["id"], "id-a");
    assert!(!v["accounts"][0]["usage"].is_null());
    assert!(out.starts_with(r#"{"accounts":[{"active":true,"alias":"work","color":"acct-1","email":"a@x.com","id":"id-a","usage":{"ageSeconds":30,"fetchedAt":1794000000,"#), "{out}");
}

#[test]
fn usage_shows_resets() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_RESETS_JSON)]);
    let (rc, out, _) = a.run(&["usage"]);
    assert_eq!(rc, 0);
    for want in [
        "    주간 5시간 초기화: 다음 가능 ",
        "    초기화 티켓 Fable reset: 2/3회 남음 · ",
        "까지 · 쓸 수 있음  (--grant g_1)\n",
    ] {
        assert!(out.contains(want), "{want:?} 없음:\n{out}");
    }
    assert!(!out.contains("Used up"));
}

#[test]
fn reset_confirm() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_RESETS_JSON),
        (
            "POST /api/claude-accounts/reset",
            r#"{"result":"reset","resetsLeft":1,"cleared":["five_hour"]}"#,
        ),
    ]);
    let args = [
        "reset",
        "work",
        "--program",
        "cedar_ember",
        "--grant",
        "g_1",
    ];
    let (rc, out, _) = a.stdin("n\n", &args);
    assert_eq!(rc, 1);
    assert_eq!(a.reqs().len(), 1);
    assert!(
        out.starts_with(
            "계정: work <a@x.com>\n초기화 티켓 Fable reset 를 씁니다.\n  채우는 것: 5시간, 주간\n  남은 횟수 2/3\n  기한: "
        ),
        "{out}"
    );
    assert!(
        out.ends_with("  쓴 만큼 주간 한도를 돌려받습니다.\n계속할까요? [y/N] \n취소했습니다.\n"),
        "{out}"
    );
    let (rc, out, err) = a.stdin("y\n", &args);
    assert_eq!(rc, 0, "{err}");
    assert!(
        out.ends_with("[y/N] 초기화했습니다 (남은 횟수 1)\n"),
        "{out}"
    );
    assert_eq!(
        a.last().json(),
        serde_json::json!({"id": "id-a", "program": "cedar_ember", "grantId": "g_1"})
    );
}

#[test]
fn reset_yes_and_results() {
    for (body, rc_want, want) in [
        (r#"{"result":"already_used"}"#, 1, "이미 썼습니다\n"),
        (
            r#"{"result":"unconfirmed"}"#,
            1,
            "확인하지 못했습니다 — 잠시 뒤 사용량을 확인하세요. 자동으로 다시 보내지 않습니다\n",
        ),
        (r#"{"result":"weird"}"#, 1, "알 수 없는 결과: weird\n"),
    ] {
        let a = Acct::new(&[
            ("GET /api/claude-accounts", ACCOUNTS_RESETS_JSON),
            ("POST /api/claude-accounts/reset", body),
        ]);
        let (rc, out, _) = a.stdin("", &["reset", "work", "--program", "juniper_tide", "--yes"]);
        assert_eq!((rc, out.as_str()), (rc_want, want), "{body}");
        assert!(a.last().json().get("grantId").is_none());
    }
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_RESETS_JSON),
        (
            "POST /api/claude-accounts/reset",
            r#"{"result":"reset","nextAvailableAt":1794200000}"#,
        ),
    ]);
    let (rc, out, _) = a.stdin("", &["reset", "work", "--program", "juniper_tide", "--yes"]);
    assert!(
        rc == 0 && out.starts_with("초기화했습니다 — 다음 가능 "),
        "{out}"
    );
}

#[test]
fn reset_args() {
    let a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_RESETS_JSON)]);
    for args in [
        &["reset", "work"][..],
        &["reset", "work", "--program", "nope"],
        &["reset", "work", "--program", "cedar_ember"],
        &[
            "reset",
            "work",
            "--program",
            "juniper_tide",
            "--grant",
            "g_1",
        ],
        &["reset", "--program", "juniper_tide"],
    ] {
        assert_eq!(a.stdin("", args).0, 2, "{args:?}");
    }
    let (rc, _, err) = a.stdin(
        "",
        &["reset", "nobody", "--program", "juniper_tide", "--yes"],
    );
    assert!(rc == 1 && err.contains("nobody"));
}

#[test]
fn auto_on_off() {
    for (arg, want) in [("on", true), ("off", false)] {
        let a = Acct::new(&[("PUT /api/claude-accounts/autoswitch", AUTO_FAKE_JSON)]);
        let (rc, out, err) = a.run(&["auto", arg]);
        assert_eq!(rc, 0, "{err}");
        let last = a.last();
        assert_eq!(
            (last.method.as_str(), last.path()),
            ("PUT", "/api/claude-accounts/autoswitch")
        );
        assert_eq!(last.json(), serde_json::json!({ "enabled": want }));
        assert_eq!(out, "자동 전환: 켜짐\n");
    }
}

#[test]
fn auto_status() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        ("GET /api/claude-accounts/autoswitch", AUTO_FAKE_JSON),
    ]);
    let (rc, out, err) = a.run(&["auto", "status"]);
    assert_eq!(rc, 0, "{err}");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "자동 전환: 켜짐");
    assert_eq!(
        lines[1],
        "문턱값 90% · 주간 문턱값 문턱값과 같음 · 전략 best · 판단 간격 60초 · 쿨다운 300초 · 히스테리시스 10%p · 모름 허용 3번 · 모델 5시간·주간만"
    );
    assert!(
        lines[2].starts_with("마지막 전환: ")
            && lines[2].ends_with("  b@x.com → work <a@x.com>  (proactive)")
    );
    assert_eq!(lines.len(), 3);
    let (rc, out, _) = a.run(&["auto", "status", "--json"]);
    assert_eq!(rc, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["schemaVersion"], 1);
    assert!(v["settings"].is_object() && v["state"].is_object());
    assert!(
        out.starts_with(
            "{\n  \"schemaVersion\": 1,\n  \"settings\": {\n    \"cooldownSeconds\": 300,"
        ),
        "{out}"
    );
}

#[test]
fn auto_errors() {
    let srv = TestServer::fixed(
        409,
        r#"{"code":"claude_cswap_running","message":"cswap 자동 전환이 돌고 있습니다"}"#,
    );
    let home = tempfile::tempdir().unwrap();
    let env = srv.env(home.path());
    let (rc, _, err) = dm(&env, &["account", "auto", "on"]);
    assert!(rc == 1 && err.contains("cswap"), "{err}");
    let (rc, _, err) = dm(&env, &["account", "auto", "maybe"]);
    assert_eq!(
        (rc, err.as_str()),
        (
            2,
            "dmctl account auto: on, off, status 중 하나여야 합니다: maybe\n"
        )
    );
    assert_eq!(dm(&env, &["account", "auto"]).0, 2);
}

#[test]
fn history() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        (
            "GET /api/claude-accounts/history",
            r#"{"entries":[
		  {"at":1800000000,"from":"id-b","to":"id-a","trigger":"proactive","headroomFrom":8,"headroomTo":70,"by":"auto"},
		  {"at":1799990000,"from":"id-gone","to":"id-b","trigger":"manual","headroomFrom":null,"headroomTo":null,"by":"dmctl"}]}"#,
        ),
    ]);
    let (rc, out, err) = a.run(&["history", "--limit", "5"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(a.last().target, "/api/claude-accounts/history?limit=5");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(
        lines[0].ends_with("  b@x.com → work <a@x.com>  proactive  auto"),
        "{out}"
    );
    assert!(
        lines[1].ends_with("  삭제된 계정 → b@x.com  manual  dmctl"),
        "{out}"
    );
    for bad in ["0", "1001", "x"] {
        let (rc, _, err) = a.run(&["history", "--limit", bad]);
        assert_eq!(
            (rc, err.as_str()),
            (2, "dmctl account history: --limit 은 1~1000 입니다\n")
        );
    }
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        ("GET /api/claude-accounts/history", r#"{"entries":[]}"#),
    ]);
    assert_eq!(a.run(&["history"]).1, "전환 기록이 없습니다.\n");
    assert_eq!(a.last().target, "/api/claude-accounts/history?limit=20");
}

#[test]
fn pin() {
    let mut a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        ("PUT /api/claude-accounts/mappings", MAPPINGS_FAKE_JSON),
    ]);
    a.env.set(dm_shared_dmenv::ENV_TOOL_ID, "tool-self");
    let (rc, out, err) = a.run(&["pin", "work"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        out,
        "탭 지정: tool-self → work <a@x.com>\n실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용됩니다.\n"
    );
    let last = a.last();
    assert_eq!(last.method, "PUT");
    assert_eq!(
        last.json(),
        serde_json::json!({"toolId": "tool-self", "accountId": "id-a"})
    );
    assert_eq!(a.run(&["pin", "--tab", "tool-9", "b@x.com"]).0, 0);
    assert_eq!(
        a.last().json(),
        serde_json::json!({"toolId": "tool-9", "accountId": "id-b"})
    );
    let (rc, out, _) = a.run(&["pin", "--clear"]);
    assert_eq!(rc, 0);
    assert_eq!(
        a.last().json(),
        serde_json::json!({"toolId": "tool-self", "accountId": ""})
    );
    assert!(out.starts_with("탭 지정을 풀었습니다: tool-self\n") && out.contains("다음 실행부터"));
}

#[test]
fn pin_errors() {
    let mut a = Acct::new(&[("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON)]);
    a.env.set(dm_shared_dmenv::ENV_TOOL_ID, "");
    for args in [
        &["pin", "work"][..],
        &["pin", "--tab", "t"],
        &["pin", "--tab", "t", "nope"],
        &["pin", "--clear", "--tab", "t", "work"],
    ] {
        assert_ne!(a.run(args).0, 0, "{args:?}");
    }
}

#[test]
fn map_unmap() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        ("PUT /api/claude-accounts/mappings", MAPPINGS_FAKE_JSON),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().to_str().unwrap();
    let (rc, out, err) = a.run(&["map", "work", d]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        a.last().json(),
        serde_json::json!({"folder": d, "accountId": "id-a"})
    );
    assert_eq!(
        out,
        format!("폴더 연결: {d} → work <a@x.com>\n다음 claude 실행부터 적용됩니다.\n")
    );
    let wd = std::env::current_dir().unwrap();
    assert_eq!(a.run(&["map", "work"]).0, 0);
    assert_eq!(a.last().json()["folder"], wd.to_str().unwrap());
    let (rc, out, _) = a.run(&["unmap", "sub"]);
    assert_eq!(rc, 0);
    let sub = wd.join("sub");
    assert_eq!(
        a.last().json(),
        serde_json::json!({"folder": sub.to_str().unwrap(), "accountId": ""})
    );
    assert_eq!(out, format!("폴더 연결을 풀었습니다: {}\n", sub.display()));
    assert_ne!(a.run(&["map", "nope", d]).0, 0);
    assert_eq!(a.run(&["map"]).0, 2);
    assert_eq!(a.run(&["unmap", "a", "b"]).0, 2);
}

#[test]
fn maps() {
    let a = Acct::new(&[
        ("GET /api/claude-accounts", ACCOUNTS_FAKE_JSON),
        (
            "GET /api/claude-accounts/mappings",
            r#"{"folders":{"/repo":{"accountId":"id-a"},"/gone":{"accountId":"id-x"}},"tabs":{"tool-9":{"accountId":"id-b"}}}"#,
        ),
    ]);
    let (rc, out, err) = a.run(&["maps"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        out,
        "폴더 연결:\n  /gone → (삭제된 계정)\n  /repo → work <a@x.com>\n탭 지정:\n  tool-9 → b@x.com\n"
    );
}
