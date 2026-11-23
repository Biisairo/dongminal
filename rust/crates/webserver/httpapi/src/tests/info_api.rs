//! `/api/health`·`/api/whoami`·`/api/update` (Go `health_endpoint_test.go`·`handlers_whoami_test.go`·
//! `handlers_update_test.go`).
//!
//! 옮기지 않은 것: SSE 연결이 확인을 거는 두 시험(`TestSSEConnect*`)은 5.5.2 가 `tests/commands.rs`
//! 로 이미 옮겼다. `daemonPairAt`(실제 데몬 짝) 대신 `FakeHub` 를 쓴다 — 보는 것은 응답 모양이다.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use dm_shared_toolhub::{DaemonInfo, ToolInfo};
use dm_shared_updatecheck::Snapshot;
use dm_shared_workspace::TabEntry;
use dm_webserver_seam_toolaccess::{ClientToolResolver, Error as SeamError};

use super::fakes::{FakeHub, FakeUpdates, FakeWork};
use super::support::*;
use crate::req::Req;
use crate::{Deps, Server};

fn srv(deps: Deps) -> (tempfile::TempDir, Arc<Server>) {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), deps);
    (d, s)
}

// ── /api/health ──

fn hub_with(ids: &[&str], info: DaemonInfo) -> Arc<FakeHub> {
    let h = FakeHub {
        daemon: info,
        ..FakeHub::default()
    };
    for id in ids {
        h.seed(id, id);
    }
    Arc::new(h)
}

#[tokio::test]
async fn health_shape() {
    let (_d, s) = srv(Deps {
        tools: Some(hub_with(&["1"], DaemonInfo::default())),
        work: Some(Arc::new(FakeWork::with("{}", 7))),
        ..Deps::default()
    });
    let r = get(&s, "/api/health").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    for k in ["version", "uptime", "daemon", "workspace", "tools"] {
        assert!(v.get(k).is_some(), "{k}");
    }
    assert_eq!(v["tools"], 1);
    for k in ["connected", "protocol", "build", "mismatch"] {
        assert!(v["daemon"].get(k).is_some(), "{k}");
    }
    assert_eq!(v["daemon"]["connected"], true);
    assert_eq!(v["daemon"]["mismatch"], false);
    assert_eq!(v["workspace"]["rev"], 7);
    assert!(v["workspace"].get("lastPersistErr").is_some());
    // Go 구조체 필드 순서 그대로다.
    assert_eq!(
        r.body,
        "{\"version\":\"\",\"uptime\":0,\"daemon\":{\"connected\":true,\"protocol\":0,\"build\":\"\",\"mismatch\":false},\"workspace\":{\"rev\":7,\"lastPersistErr\":\"\",\"lastLoadErr\":\"\"},\"tools\":1}\n"
    );
}

#[tokio::test]
async fn health_mismatch() {
    for (name, ours, theirs, want) in [
        ("같다", "v1", "v1", false),
        ("다르다", "v1", "v2", true),
        ("데몬이 판을 말하지 않는다", "v1", "", false),
        ("우리 판을 모른다", "", "v2", false),
    ] {
        let d = tempfile::tempdir().unwrap();
        let s = Server::new(
            crate::Config {
                data_dir: d.path().to_path_buf(),
                version: ours.to_owned(),
                ..crate::Config::default()
            },
            Deps {
                tools: Some(hub_with(
                    &[],
                    DaemonInfo {
                        protocol: 3,
                        build: theirs.to_owned(),
                    },
                )),
                ..Deps::default()
            },
        );
        let v = get(&s, "/api/health").await.json();
        assert_eq!(v["daemon"]["mismatch"], want, "{name}");
        assert_eq!(v["daemon"]["protocol"], 3, "{name}");
        assert_eq!(v["version"], ours, "{name}");
    }
}

#[tokio::test]
async fn health_always_ok() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/health").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["tools"], 0);
}

#[tokio::test]
async fn health_carries_no_secrets() {
    let (_d, s) = srv(Deps {
        tools: Some(hub_with(&["1"], DaemonInfo::default())),
        work: Some(Arc::new(FakeWork::with("{}", 1))),
        ..Deps::default()
    });
    let raw = get(&s, "/api/health").await.body.to_lowercase();
    for bad in ["/users/", "/home/", "c:\\", "token", "password", "secret"] {
        assert!(!raw.contains(bad), "{bad}: {raw}");
    }
}

// ── /api/whoami ──

struct FakeResolver {
    tool_id: String,
    shell_pid: i64,
    err: Option<String>,
    remote: Mutex<Vec<String>>,
}

impl FakeResolver {
    fn ok(id: &str, pid: i64) -> Arc<FakeResolver> {
        Arc::new(FakeResolver {
            tool_id: id.to_owned(),
            shell_pid: pid,
            err: None,
            remote: Mutex::new(Vec::new()),
        })
    }
}

impl ClientToolResolver for FakeResolver {
    fn resolve_client_pane(&self, remote_addr: &str) -> Result<(String, i64), SeamError> {
        self.remote.lock().unwrap().push(remote_addr.to_owned());
        match &self.err {
            Some(e) => Err(e.clone().into()),
            None => Ok((self.tool_id.clone(), self.shell_pid)),
        }
    }
}

fn sized_hub(id: &str, cols: i64, rows: i64) -> Arc<FakeHub> {
    let h = FakeHub::default();
    h.tools.lock().unwrap().push(ToolInfo {
        id: id.to_owned(),
        name: "Shell #1".to_owned(),
        cols,
        rows,
        ..ToolInfo::default()
    });
    Arc::new(h)
}

fn work_with(entries: Vec<TabEntry>) -> Arc<FakeWork> {
    Arc::new(FakeWork {
        tab_entries: entries,
        ..FakeWork::default()
    })
}

#[tokio::test]
async fn whoami_happy_path() {
    let who = FakeResolver::ok("p1", 12345);
    let (_d, s) = srv(Deps {
        tools: Some(sized_hub("p1", 80, 24)),
        work: Some(work_with(vec![TabEntry {
            tool_id: "p1".to_owned(),
            label: "W1.P1.T1".to_owned(),
            window_name: "Main".to_owned(),
            tab_name: "Shell".to_owned(),
            is_active: true,
            window_uuid: "su1".to_owned(),
            pane_uuid: "ru1".to_owned(),
            tab_uuid: "tu1".to_owned(),
            short_code: "tu1short".to_owned(),
        }])),
        who_am_i: Some(who.clone()),
        ..Deps::default()
    });
    let r = get(&s, "/api/whoami").await;
    assert_eq!(r.status, 200, "{}", r.body);
    // Go `map[string]any` 는 키의 바이트 순이다.
    assert_eq!(
        r.body,
        "{\"focused\":true,\"label\":\"W1.P1.T1\",\"paneUuid\":\"ru1\",\"shellPid\":12345,\"short\":\"tu1short\",\"sizeCols\":80,\"sizeRows\":24,\"tab\":\"Shell\",\"toolId\":\"p1\",\"uuid\":\"tu1\",\"window\":\"Main\",\"windowUuid\":\"su1\"}\n"
    );
    assert_eq!(who.remote.lock().unwrap().as_slice(), [LOCAL]);
}

#[tokio::test]
async fn whoami_resolve_fails() {
    let (_d, s) = srv(Deps {
        tools: Some(Arc::new(FakeHub::default())),
        work: Some(Arc::new(FakeWork::default())),
        who_am_i: Some(Arc::new(FakeResolver {
            tool_id: String::new(),
            shell_pid: 0,
            err: Some("clientPID=999 가 어느 tool 에도 속하지 않음".to_owned()),
            remote: Mutex::new(Vec::new()),
        })),
        ..Deps::default()
    });
    let r = get(&s, "/api/whoami").await;
    assert_eq!(r.status, 404);
    assert_eq!(
        r.json()["error"],
        "clientPID=999 가 어느 tool 에도 속하지 않음"
    );
}

#[tokio::test]
async fn whoami_no_entry() {
    let hub = Arc::new(FakeHub::default());
    hub.seed("p1", "Shell #1");
    let (_d, s) = srv(Deps {
        tools: Some(hub),
        work: Some(Arc::new(FakeWork::default())),
        who_am_i: Some(FakeResolver::ok("p1", 1234)),
        ..Deps::default()
    });
    let r = get(&s, "/api/whoami").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["toolId"], "p1");
    assert_eq!(v["shellPid"], 1234);
    assert_eq!(v["label"], "");
    assert_eq!(v["uuid"], "");
}

#[tokio::test]
async fn whoami_method_not_get() {
    let (_d, s) = srv(Deps {
        who_am_i: Some(FakeResolver::ok("p1", 0)),
        ..Deps::default()
    });
    assert_ne!(post_json(&s, "/api/whoami", "").await.status, 200);
}

#[tokio::test]
async fn whoami_nil_resolver() {
    let (_d, s) = srv(Deps {
        tools: Some(Arc::new(FakeHub::default())),
        work: Some(Arc::new(FakeWork::default())),
        ..Deps::default()
    });
    let r = get(&s, "/api/whoami").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.body, "whoami unavailable\n");
    assert_eq!(r.header("X-Error-Code"), "internal_error");
}

#[tokio::test]
async fn whoami_tool_id_query() {
    let hub = Arc::new(FakeHub::default());
    hub.seed("p1", "Shell #1");
    let (_d, s) = srv(Deps {
        tools: Some(hub),
        ..Deps::default()
    });
    let r = get(&s, "/api/whoami?toolId=p1").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["toolId"], "p1");
    assert_eq!(r.json()["shellPid"], 0);
    let r = get(&s, "/api/whoami?toolId=nope").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.body, "{\"error\":\"tool not found: nope\"}\n");
}

#[test]
fn caller_tool_id_prefers_resolver() {
    let d = tempfile::tempdir().unwrap();
    let r = Req::for_test(http::Method::POST, "/api/tools/usage", "");
    let s = server(d.path(), Deps::default());
    assert_eq!(s.caller_tool_id(&r, "claimed"), "claimed");
    let s = server(
        d.path(),
        Deps {
            who_am_i: Some(FakeResolver::ok("p9", 1)),
            ..Deps::default()
        },
    );
    assert_eq!(s.caller_tool_id(&r, "claimed"), "p9");
    let s = server(
        d.path(),
        Deps {
            who_am_i: Some(FakeResolver::ok("", 1)),
            ..Deps::default()
        },
    );
    assert_eq!(s.caller_tool_id(&r, "claimed"), "claimed");
}

// ── /api/update ──

fn updates(snap: Snapshot) -> Arc<FakeUpdates> {
    Arc::new(FakeUpdates {
        snap: Mutex::new(snap),
        ..FakeUpdates::default()
    })
}

async fn put_update(s: &Arc<Server>, body: &str) -> Resp {
    call(
        s,
        "PUT",
        "/api/update",
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await
}

#[tokio::test]
async fn update_get_returns_snapshot() {
    let f = updates(Snapshot {
        enabled: true,
        current: "v1.0.0".to_owned(),
        latest: "v1.2.0".to_owned(),
        newer: true,
        link: "https://example/rel".to_owned(),
        checked_at: "2026-09-16T00:00:00Z".to_owned(),
        failed: false,
    });
    let (_d, s) = srv(Deps {
        updates: Some(f),
        ..Deps::default()
    });
    let r = get(&s, "/api/update").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        "{\"enabled\":true,\"current\":\"v1.0.0\",\"latest\":\"v1.2.0\",\"newer\":true,\"link\":\"https://example/rel\",\"checkedAt\":\"2026-09-16T00:00:00Z\",\"failed\":false}\n"
    );
}

#[tokio::test]
async fn update_get_never_triggers() {
    let f = updates(Snapshot::default());
    let (_d, s) = srv(Deps {
        updates: Some(f.clone()),
        ..Deps::default()
    });
    for _ in 0..100 {
        get(&s, "/api/update").await;
    }
    assert_eq!(f.triggers.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn update_put_sets_toggle() {
    let f = updates(Snapshot {
        enabled: true,
        ..Snapshot::default()
    });
    let (_d, s) = srv(Deps {
        updates: Some(f.clone()),
        ..Deps::default()
    });
    let r = put_update(&s, r#"{"enabled":false}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(f.sets.load(Ordering::SeqCst), 1);
    assert_eq!(r.json()["enabled"], false);
}

#[tokio::test]
async fn update_put_rejects_missing_field() {
    let f = updates(Snapshot::default());
    let (_d, s) = srv(Deps {
        updates: Some(f.clone()),
        ..Deps::default()
    });
    for body in [
        "{}",
        "{bad",
        r#"{"enabled":"yes"}"#,
        "null",
        r#"{"enabled":null}"#,
        "",
    ] {
        let r = put_update(&s, body).await;
        assert_eq!(r.status, 400, "{body}");
        assert_eq!(r.body, "enabled 가 true/false 여야 합니다\n", "{body}");
    }
    assert_eq!(f.sets.load(Ordering::SeqCst), 0);
}

/// Go JSON 은 필드 이름의 대소문자를 가리지 않는다 (go1.27.2 실측).
#[tokio::test]
async fn update_put_field_case_insensitive() {
    let f = updates(Snapshot::default());
    let (_d, s) = srv(Deps {
        updates: Some(f.clone()),
        ..Deps::default()
    });
    let r = put_update(&s, r#"{"Enabled":true}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.json()["enabled"], true);
}

#[tokio::test]
async fn update_put_save_error() {
    let f = Arc::new(FakeUpdates {
        set_err: Some("disk full".to_owned()),
        ..FakeUpdates::default()
    });
    let (_d, s) = srv(Deps {
        updates: Some(f),
        ..Deps::default()
    });
    let r = put_update(&s, r#"{"enabled":true}"#).await;
    assert_eq!(r.status, 500);
    assert_eq!(r.body, "설정을 저장하지 못했습니다: disk full\n");
}

#[tokio::test]
async fn update_unavailable_without_service() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/update").await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, "update check unavailable\n");
    assert_eq!(r.header("X-Error-Code"), "update_unavailable");
    assert_eq!(put_update(&s, r#"{"enabled":true}"#).await.status, 503);
    assert_eq!(get(&s, "/api/ping").await.status, 200);
}

#[tokio::test]
async fn snapshot_carries_update_part() {
    let f = updates(Snapshot {
        current: "v1".to_owned(),
        ..Snapshot::default()
    });
    let (_d, s) = srv(Deps {
        updates: Some(f),
        ..Deps::default()
    });
    let r = get(&s, "/api/snapshot?parts=update").await;
    assert_eq!(
        r.body,
        "{\"update\":{\"enabled\":false,\"current\":\"v1\",\"newer\":false,\"failed\":false}}\n"
    );
    let (_d2, s2) = srv(Deps::default());
    assert_eq!(get(&s2, "/api/snapshot?parts=update").await.body, "{}\n");
}
