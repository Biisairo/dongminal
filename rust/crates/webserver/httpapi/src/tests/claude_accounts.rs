//! `/api/claude-accounts/*` (Go `claude_accounts_*_test.go`).

use std::path::Path;
use std::sync::{Arc, Mutex};

use dm_shared_platform::{Secrets, SecretsError};

use super::fakes::FakeHub;
use super::fsenv::qe;
use super::support::{self, call};
use crate::{ClaudeHooks, Config, Deps, Server};

/// Go `caNoSecrets`: 비밀 저장소가 없는 OS 다.
pub(crate) struct NoSecrets;

impl Secrets for NoSecrets {
    fn available(&self) -> bool {
        false
    }
    fn account(&self) -> String {
        "t".into()
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), SecretsError> {
        Ok(())
    }
}

struct CaEnv {
    home: tempfile::TempDir,
    data: tempfile::TempDir,
    srv: Arc<Server>,
}

/// Go `newCAEnv`·`newCAEnvProcs`. API 주소는 듣는 이가 없는 곳이다(포트 0).
fn ca_env_procs(procs: Arc<Mutex<Vec<String>>>) -> CaEnv {
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let srv = Server::new(
        Config {
            data_dir: data.path().to_path_buf(),
            claude_home: home.path().to_path_buf(),
            claude_api: "http://127.0.0.1:0".into(),
            ..Config::default()
        },
        Deps {
            tools: Some(Arc::new(FakeHub::default())),
            claude: ClaudeHooks {
                secrets: Some(Arc::new(NoSecrets)),
                procs: Some(Arc::new(move || Ok(procs.lock().unwrap().clone()))),
            },
            ..Deps::default()
        },
    );
    CaEnv { home, data, srv }
}

fn ca_env() -> CaEnv {
    ca_env_procs(Arc::default())
}

impl CaEnv {
    fn login(&self, email: &str, org: &str, access: &str, refresh: &str) {
        let h = self.home.path();
        std::fs::create_dir_all(h.join(".claude")).unwrap();
        std::fs::write(
            h.join(".claude/.credentials.json"),
            format!(
                r#"{{"claudeAiOauth":{{"accessToken":"{access}","refreshToken":"{refresh}","expiresAt":1}}}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            h.join(".claude.json"),
            format!(
                r#"{{"oauthAccount":{{"emailAddress":"{email}","organizationUuid":"{org}","accountUuid":"acc-{org}"}}}}"#
            ),
        )
        .unwrap();
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: &str,
    ) -> (support::Resp, serde_json::Value) {
        let r = call(
            &self.srv,
            method,
            path,
            &[("Content-Type", "application/json")],
            body,
            support::LOCAL,
        )
        .await;
        let v = r.json();
        (r, v)
    }

    /// Go `addOne`.
    async fn add_one(&self) -> String {
        self.login("a@x.com", "org-a", "SECRET-A", "RT-A");
        let (r, v) = self.call("POST", "/api/claude-accounts/add", "{}").await;
        assert_eq!(r.status, 200, "{}", r.body);
        v["account"]["id"].as_str().unwrap().to_owned()
    }
}

/// Go `twoCAAccounts`.
async fn two_accounts() -> (CaEnv, String, String) {
    let e = ca_env();
    let a = e.add_one().await;
    e.login("b@x.com", "org-b", "SECRET-B", "RT-B");
    let (_, v) = e.call("POST", "/api/claude-accounts/add", "{}").await;
    let b = v["account"]["id"].as_str().unwrap().to_owned();
    (e, a, b)
}

fn code(r: &support::Resp) -> (u16, String) {
    (r.status, r.header("X-Error-Code"))
}

#[tokio::test]
async fn claude_accounts_add_list_switch() {
    let e = ca_env();
    let (r, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(v["accounts"], serde_json::json!([]));
    assert_eq!(v["otherStatusLines"], serde_json::json!([]));
    let (e, id_a, id_b) = two_accounts().await;
    let (r, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert_eq!(v["activeId"], id_b.as_str());
    assert_eq!(v["accounts"].as_array().unwrap().len(), 2);
    assert!(
        !r.body.contains("SECRET") && !r.body.contains("RT-"),
        "list leaks tokens"
    );
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            &format!(r#"{{"id":"{id_a}"}}"#),
        )
        .await;
    assert_eq!(
        (r.status, &v["to"]),
        (200, &serde_json::json!(id_a)),
        "{}",
        r.body
    );
    let live = std::fs::read_to_string(e.home.path().join(".claude/.credentials.json")).unwrap();
    assert!(live.contains("SECRET-A"));
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            r#"{"strategy":"next"}"#,
        )
        .await;
    assert_eq!(
        (r.status, &v["to"]),
        (200, &serde_json::json!(id_b)),
        "{}",
        r.body
    );
}

#[tokio::test]
async fn claude_accounts_item_order_remove() {
    let (e, id_a, id_b) = two_accounts().await;
    let (r, v) = e
        .call(
            "PUT",
            "/api/claude-accounts/item",
            &format!(r#"{{"id":"{id_a}","alias":"work","threshold":80}}"#),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(
        (&v["alias"], &v["threshold"]),
        (&serde_json::json!("work"), &serde_json::json!(80))
    );
    let (r, _) = e
        .call(
            "PUT",
            "/api/claude-accounts/item",
            &format!(r#"{{"id":"{id_a}","threshold":20}}"#),
        )
        .await;
    assert_eq!(code(&r), (400, "claude_account_invalid".into()));
    let (r, _) = e
        .call(
            "PUT",
            "/api/claude-accounts/item",
            r#"{"id":"nope","alias":"x"}"#,
        )
        .await;
    assert_eq!(code(&r), (404, "claude_account_not_found".into()));
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/order",
            &format!(r#"{{"ids":["{id_b}","{id_a}"]}}"#),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let (_, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert_eq!(v["accounts"][0]["id"], id_b.as_str());
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/remove",
            &format!(r#"{{"id":"{id_a}"}}"#),
        )
        .await;
    assert_eq!((r.status, &v), (200, &serde_json::json!({"ok": true})));
    let (_, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert_eq!(v["accounts"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn claude_accounts_errors() {
    let e = ca_env();
    let (r, _) = e.call("POST", "/api/claude-accounts/add", "{}").await;
    assert_eq!(code(&r), (409, "claude_not_logged_in".into()));
    let (r, _) = e
        .call("POST", "/api/claude-accounts/switch", r#"{"id":"x"}"#)
        .await;
    assert_eq!(r.status, 404);
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            r#"{"strategy":"sideways"}"#,
        )
        .await;
    assert_eq!(r.status, 400);
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            r#"{"strategy":"next"}"#,
        )
        .await;
    assert_eq!(code(&r), (409, "claude_no_candidate".into()));
    let (r, _) = e.call("POST", "/api/claude-accounts/switch", "{bad").await;
    assert_eq!(code(&r), (400, "invalid_json".into()));
}

#[tokio::test]
async fn claude_accounts_unavailable_without_data_dir() {
    let srv = Server::new(Config::default(), Deps::default());
    let r = support::get(&srv, "/api/claude-accounts").await;
    assert_eq!(code(&r), (503, "claude_accounts_unavailable".into()));
    assert_eq!(
        r.body,
        "{\"code\":\"claude_accounts_unavailable\",\"message\":\"claude accounts unavailable\"}\n"
    );
}

/// REFACTOR3_FE_FIX_SRS FR-FFX-22: 목록이 계정 행 칸의 범위를 싣는다.
#[tokio::test]
async fn claude_accounts_list_ranges() {
    let e = ca_env();
    let (_, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert!(v["ranges"]["threshold"].is_object(), "{v}");
}

fn sl_body(email: &str, pct: i64) -> String {
    let acc = if email.is_empty() {
        String::new()
    } else {
        format!(
            r#","account":{{"email":"{email}","organizationUuid":"org-{}"}}"#,
            &email[..1]
        )
    };
    format!(
        r#"{{"toolId":"p1","usage":{{"rateLimits":{{"five_hour":{{"usedPct":{pct},"resetsAt":4000000000}}}}}}{acc}}}"#
    )
}

/// FR-CAC-78: 계정을 실은 statusLine 은 계정별로 두고, 등록되지 않은 계정은 가린 이름으로 싣는다.
#[tokio::test]
async fn claude_status_line_per_account() {
    let (e, id_a, _) = two_accounts().await;
    for body in [sl_body("a@x.com", 42), sl_body("zed@y.com", 7)] {
        let r = support::post_json(&e.srv, "/api/tools/usage", &body).await;
        assert_eq!(r.status, 200, "{}", r.body);
    }
    let (r, v) = e.call("GET", "/api/claude-accounts", "").await;
    let a = v["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id_a.as_str())
        .unwrap()
        .clone();
    assert_eq!(
        a["statusLine"]["windows"]["fiveHour"]["pct"], 42,
        "{}",
        r.body
    );
    assert!(a["statusLine"]["observedAt"].is_number());
    let others = v["otherStatusLines"].as_array().unwrap();
    assert_eq!(others.len(), 1);
    assert_eq!(others[0]["name"], "ze***@");
    assert!(!r.body.contains("zed@y.com"));
    let acc = dm_webserver_domain_claudeacct::Account {
        email: "a@x.com".into(),
        org_uuid: "org-a".into(),
        ..Default::default()
    };
    let (u, at) = e.srv.ca.as_ref().unwrap().sl.get(&acc).unwrap();
    let five = u.five_hour.unwrap();
    assert_eq!((five.pct, five.resets_at), (42.0, 4_000_000_000));
    assert!(at > 0);
}

#[tokio::test]
async fn claude_accounts_switch_by_and_history() {
    let (e, id_a, id_b) = two_accounts().await;
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            &format!(r#"{{"id":"{id_a}","by":"auto"}}"#),
        )
        .await;
    assert_eq!(code(&r), (400, "claude_account_invalid".into()));
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            &format!(r#"{{"id":"{id_a}","by":"dmctl"}}"#),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/switch",
            r#"{"strategy":"next"}"#,
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let (r, v) = e.call("GET", "/api/claude-accounts/history", "").await;
    let ents = v["entries"].as_array().unwrap();
    assert_eq!(ents.len(), 2, "{}", r.body);
    assert_eq!(
        (&ents[0]["trigger"], &ents[0]["by"], &ents[0]["to"]),
        (
            &serde_json::json!("next"),
            &serde_json::json!("ui"),
            &serde_json::json!(id_b)
        )
    );
    assert_eq!(
        (&ents[1]["trigger"], &ents[1]["by"], &ents[1]["to"]),
        (
            &serde_json::json!("manual"),
            &serde_json::json!("dmctl"),
            &serde_json::json!(id_a)
        )
    );
    assert!(
        ents[1]
            .get("headroomFrom")
            .is_none_or(serde_json::Value::is_null)
    );
    assert!(!r.body.contains("a@x.com") && !r.body.contains("SECRET"));
    let (_, v) = e
        .call("GET", "/api/claude-accounts/history?limit=1", "")
        .await;
    assert_eq!(v["entries"].as_array().unwrap().len(), 1);
    for q in ["0", "1001", "x"] {
        let (r, _) = e
            .call(
                "GET",
                &format!("/api/claude-accounts/history?limit={q}"),
                "",
            )
            .await;
        assert_eq!(code(&r), (400, "claude_account_invalid".into()), "{q}");
    }
}

#[tokio::test]
async fn claude_accounts_autoswitch_get_put() {
    let e = ca_env();
    let (r, v) = e.call("GET", "/api/claude-accounts/autoswitch", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(v["settings"]["enabled"], false);
    assert_eq!(v["settings"]["threshold"], 90);
    assert_eq!(v["settings"]["strategy"], "best");
    assert_eq!(v["state"]["status"], "off");
    assert_eq!(v["state"]["quarantined"], serde_json::json!([]));
    let (r, v) = e
        .call(
            "PUT",
            "/api/claude-accounts/autoswitch",
            r#"{"enabled":true,"threshold":85}"#,
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(
        (&v["settings"]["threshold"], &v["state"]["status"]),
        (&serde_json::json!(85), &serde_json::json!("on"))
    );
    let saved =
        std::fs::read_to_string(e.data.path().join("claude-accounts/autoswitch.json")).unwrap();
    assert!(saved.contains(r#""threshold": 85"#), "{saved}");
    let (_, v) = e.call("GET", "/api/claude-accounts", "").await;
    assert_eq!(
        v["autoswitch"],
        serde_json::json!({"enabled": true, "status": "on"})
    );
    let (r, _) = e
        .call(
            "PUT",
            "/api/claude-accounts/autoswitch",
            r#"{"threshold":10}"#,
        )
        .await;
    assert_eq!(code(&r), (400, "claude_account_invalid".into()));
    let (r, _) = e
        .call("PUT", "/api/claude-accounts/autoswitch", r#"{"nope":1}"#)
        .await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn claude_accounts_autoswitch_cswap_conflict() {
    let e = ca_env_procs(Arc::new(Mutex::new(vec![
        "/Users/u/.local/bin/cswap auto".to_owned(),
    ])));
    let (r, _) = e
        .call(
            "PUT",
            "/api/claude-accounts/autoswitch",
            r#"{"enabled":true}"#,
        )
        .await;
    assert_eq!(code(&r), (409, "claude_cswap_running".into()));
}

fn jq(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\")
}

#[tokio::test]
async fn claude_accounts_mappings_and_launch() {
    let e = ca_env();
    let id = e.add_one().await;
    let repo = tempfile::tempdir().unwrap();
    let repo_p = std::fs::canonicalize(repo.path()).unwrap();
    let sub = repo_p.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let (r, v) = e
        .call(
            "PUT",
            "/api/claude-accounts/mappings",
            &format!(r#"{{"folder":"{}","accountId":"{id}"}}"#, jq(&repo_p)),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(v["folders"].as_object().unwrap().len(), 1);
    // resolve 는 프로필을 맞추지 않는다.
    let (r, v) = e
        .call(
            "GET",
            &format!(
                "/api/claude-accounts/resolve?cwd={}",
                qe(&sub.to_string_lossy())
            ),
            "",
        )
        .await;
    assert_eq!(
        (r.status, &v["source"], &v["accountId"]),
        (200, &serde_json::json!("folder"), &serde_json::json!(id)),
        "{}",
        r.body
    );
    let cfg_dir = v["configDir"].as_str().unwrap().to_owned();
    assert!(!Path::new(&cfg_dir).exists(), "resolve 가 프로필을 맞췄다");
    // launch 는 프로필을 맞춘다.
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/launch",
            &format!(r#"{{"cwd":"{}"}}"#, jq(&sub)),
        )
        .await;
    assert_eq!(
        (r.status, &v["configDir"]),
        (200, &serde_json::json!(cfg_dir)),
        "{}",
        r.body
    );
    assert!(Path::new(&cfg_dir).join(".credentials.json").exists());
    assert!(!r.body.contains("SECRET-A") && !r.body.contains("RT-A"));
    // 연결 밖은 none.
    let other = tempfile::tempdir().unwrap();
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/launch",
            &format!(r#"{{"cwd":"{}"}}"#, jq(other.path())),
        )
        .await;
    assert_eq!((r.status, &v["source"]), (200, &serde_json::json!("none")));
    assert!(v.get("configDir").is_none());
    // 해제.
    let (r, v) = e
        .call(
            "PUT",
            "/api/claude-accounts/mappings",
            &format!(r#"{{"folder":"{}","accountId":""}}"#, jq(&repo_p)),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(v["folders"].as_object().unwrap().len(), 0);
}

/// FR-CAC-81a: 살아 있지 않은 도구의 탭 지정은 목록을 알 때 지운다.
#[tokio::test]
async fn claude_accounts_tab_pin_pruned_for_dead_tool() {
    let e = ca_env();
    let id = e.add_one().await;
    let (r, _) = e
        .call(
            "PUT",
            "/api/claude-accounts/mappings",
            &format!(r#"{{"toolId":"gone","accountId":"{id}"}}"#),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let (r, v) = e.call("GET", "/api/claude-accounts/mappings", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        v["tabs"].as_object().map_or(0, |m| m.len()),
        0,
        "{}",
        r.body
    );
}

#[tokio::test]
async fn claude_accounts_mapping_errors() {
    let e = ca_env();
    let id = e.add_one().await;
    let cases = [
        (
            "PUT",
            "/api/claude-accounts/mappings".to_owned(),
            format!(r#"{{"folder":"rel","accountId":"{id}"}}"#),
            400,
        ),
        (
            "PUT",
            "/api/claude-accounts/mappings".to_owned(),
            format!(r#"{{"accountId":"{id}"}}"#),
            400,
        ),
        (
            "PUT",
            "/api/claude-accounts/mappings".to_owned(),
            format!(r#"{{"folder":"/x","toolId":"t","accountId":"{id}"}}"#),
            400,
        ),
        (
            "PUT",
            "/api/claude-accounts/mappings".to_owned(),
            r#"{"toolId":"t","accountId":"nope"}"#.to_owned(),
            404,
        ),
        (
            "POST",
            "/api/claude-accounts/launch".to_owned(),
            r#"{"cwd":"rel"}"#.to_owned(),
            400,
        ),
        (
            "GET",
            "/api/claude-accounts/resolve?cwd=rel".to_owned(),
            String::new(),
            400,
        ),
    ];
    for (m, p, body, want) in cases {
        let (r, _) = e.call(m, &p, &body).await;
        assert_eq!(r.status, want, "{m} {p} {body}: {}", r.body);
    }
}

/// TC-CAC-30 (API): 보관 목록·삭제 (FR-CAC-34a).
#[tokio::test]
async fn claude_accounts_unclaimed_api() {
    let e = ca_env();
    let dir = e.data.path().join("claude-accounts/unclaimed");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("100-aaaaaaaaaaaa.json"),
        r#"{"claudeAiOauth":{"accessToken":"SECRET-U"}}"#,
    )
    .unwrap();
    let (r, v) = e.call("GET", "/api/claude-accounts/unclaimed", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(v["entries"].as_array().unwrap().len(), 1, "{}", r.body);
    assert_eq!(v["entries"][0]["fingerprint"], "aaaaaaaaaaaa");
    assert!(!r.body.contains("SECRET-U"));
    let (r, _) = e
        .call(
            "POST",
            "/api/claude-accounts/unclaimed/remove",
            r#"{"name":"../accounts.json"}"#,
        )
        .await;
    assert_eq!(code(&r), (400, "claude_account_invalid".into()));
    let (r, v) = e
        .call(
            "POST",
            "/api/claude-accounts/unclaimed/remove",
            r#"{"name":"100-aaaaaaaaaaaa.json"}"#,
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(v["entries"].as_array().map_or(0, Vec::len), 0);
}

/// FR-RDF-2: Claude Code 락을 다른 쪽이 쥐어 전환이 기다리는 동안에도, 작업 스레드 1개짜리
/// 런타임에서 다른 요청이 락 대기보다 훨씬 짧게 답한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn claude_accounts_switch_lock_wait_does_not_block_other_requests() {
    const HOLD: std::time::Duration = std::time::Duration::from_millis(1500);
    const FAST: std::time::Duration = std::time::Duration::from_millis(500);
    let (e, id_a, _) = two_accounts().await;
    let held = e.home.path().join(".claude/.oauth_refresh.lock");
    std::fs::create_dir(&held).unwrap();
    let releaser = {
        let held = held.clone();
        std::thread::spawn(move || {
            std::thread::sleep(HOLD);
            std::fs::remove_dir(&held).unwrap();
        })
    };
    let srv = e.srv.clone();
    let body = format!(r#"{{"id":"{id_a}"}}"#);
    let switch = tokio::spawn(async move {
        let hdr = [("Content-Type", "application/json")];
        call(
            &srv,
            "POST",
            "/api/claude-accounts/switch",
            &hdr,
            &body,
            support::LOCAL,
        )
        .await
    });
    std::thread::sleep(std::time::Duration::from_millis(300));
    let srv = e.srv.clone();
    let t0 = std::time::Instant::now();
    let health =
        tokio::spawn(
            async move { call(&srv, "GET", "/api/health", &[], "", support::LOCAL).await },
        )
        .await
        .unwrap();
    let took = t0.elapsed();
    assert_eq!(health.status, 200, "{}", health.body);
    assert!(
        took < FAST,
        "health took {took:?} while switch waited on lock"
    );
    let r = switch.await.unwrap();
    assert_eq!(r.status, 200, "{}", r.body);
    releaser.join().unwrap();
}
