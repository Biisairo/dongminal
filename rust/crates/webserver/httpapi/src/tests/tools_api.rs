//! 상태·도구·워크스페이스·지표 종단 (Go `handlers_api_test.go`·`state_raw_test.go`·
//! `workspace_ifmatch_test.go`·`handlers_tools_kill_test.go`·`handlers_stats_test.go`·
//! `sandbox_handlers_test.go` 의 도구·워크스페이스 부분).

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime};

use otter_shared_toolhub::{DEFAULT_COLS, Placement};
use otter_shared_workspace::WindowInfo;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_sysstat::Snapshot;
use otter_webserver_hub::{CmdSub, CommandBroker, CommandHub};

use super::fakes::*;
use super::support::*;
use crate::tools_api::{MAX_BUSY_IDS, TOOL_KILL_GRACE, fmt_duration};
use crate::{Deps, Server};

fn srv(deps: Deps) -> (tempfile::TempDir, Arc<Server>) {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), deps);
    (dir, s)
}

fn hub_deps(h: &Arc<FakeHub>) -> Deps {
    Deps {
        tools: Some(h.clone()),
        ..Deps::default()
    }
}

fn subscribed() -> (Arc<dyn CommandBroker>, Arc<CmdSub>) {
    let hub: Arc<dyn CommandBroker> = CommandHub::new();
    let sub = hub.add().unwrap();
    (hub, sub)
}

fn drain(sub: &CmdSub) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(b) = sub.try_recv() {
        out.push(String::from_utf8_lossy(&b).into_owned());
    }
    out
}

/// 게이트가 변경 요청에 JSON 형식을 요구한다 (Go 시험의 `mustNewRequest` 와 같다).
async fn req(
    s: &Arc<Server>,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Resp {
    let mut h = vec![("Content-Type", "application/json")];
    h.extend_from_slice(headers);
    call(s, method, target, &h, body, LOCAL).await
}

// ── busy ──

#[tokio::test]
async fn tool_busy_unknown_is_false() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let r = get(&s, "/api/tools/missing/busy").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.trim(), r#"{"busy":false}"#);
}

#[tokio::test]
async fn tool_busy_reports_hub() {
    let h = Arc::new(FakeHub::default());
    h.seed("p1", "toolhub.Tool 1");
    h.busy.lock().unwrap().insert("p1".into(), true);
    let (_d, s) = srv(hub_deps(&h));
    let r = get(&s, "/api/tools/p1/busy").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.trim(), r#"{"busy":true}"#);
}

#[tokio::test]
async fn tool_busy_without_hub_is_false() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/tools/x/busy").await;
    assert_eq!((r.status, r.body.trim()), (200, r#"{"busy":false}"#));
}

#[tokio::test]
async fn tools_busy_many() {
    let h = Arc::new(FakeHub::default());
    h.busy.lock().unwrap().insert("b".into(), true);
    let (_d, s) = srv(hub_deps(&h));
    let r = get(&s, "/api/tools/busy?ids=b,,a").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.trim(), r#"{"busy":{"a":false,"b":true}}"#);
    let r = get(&s, "/api/tools/busy").await;
    assert_eq!(r.body.trim(), r#"{"busy":{}}"#);
}

#[tokio::test]
async fn tools_busy_too_many_ids_is_400() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let ids: Vec<String> = (0..=MAX_BUSY_IDS).map(|i| i.to_string()).collect();
    let r = get(&s, &format!("/api/tools/busy?ids={}", ids.join(","))).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body.trim(), "ids 는 256개까지입니다");
}

#[tokio::test]
async fn tools_busy_unknown_is_503() {
    let h = Arc::new(FakeHub {
        busy_many_fails: true,
        ..FakeHub::default()
    });
    let (_d, s) = srv(hub_deps(&h));
    let r = get(&s, "/api/tools/busy?ids=a").await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body.trim(), "도구 상태를 알 수 없습니다");
}

// ── delete·kill ──

#[tokio::test]
async fn delete_tool_is_200_even_if_missing() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let r = req(&s, "DELETE", "/api/tools/1", &[], "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, "");
    assert_eq!(*h.deleted.lock().unwrap(), vec!["1".to_owned()]);
}

async fn kill(s: &Arc<Server>, body: &str) -> Resp {
    post_json(s, "/api/tools/kill", body).await
}

#[tokio::test]
async fn kill_rejects_missing_tool_id() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    for body in ["", "{}", r#"{"toolId":""}"#, "nope"] {
        let r = kill(&s, body).await;
        assert_eq!(r.status, 400, "body={body:?}");
        assert_eq!(
            r.header(otter_shared_httpresp::CODE_HEADER),
            apierr::CODE_MISSING_ARG
        );
    }
}

#[tokio::test]
async fn kill_unknown_tool_is_404() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let r = kill(&s, r#"{"toolId":"nope"}"#).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.body.trim(), "toolId=nope 존재하지 않음");
    assert_eq!(
        r.header(otter_shared_httpresp::CODE_HEADER),
        apierr::CODE_TOOL_NOT_FOUND
    );
}

#[tokio::test]
async fn kill_without_hub_is_404() {
    let (_d, s) = srv(Deps::default());
    assert_eq!(kill(&s, r#"{"toolId":"nope"}"#).await.status, 404);
}

#[tokio::test]
async fn kill_terminates_with_grace() {
    let h = Arc::new(FakeHub::default());
    h.seed("t1", "Shell");
    let (_d, s) = srv(hub_deps(&h));
    let r = kill(&s, r#"{"toolId":"t1"}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.trim(), r#"{"ok":true}"#);
    assert_eq!(
        *h.terminated.lock().unwrap(),
        vec![("t1".to_owned(), TOOL_KILL_GRACE)]
    );
    assert_eq!(TOOL_KILL_GRACE, Duration::from_secs(3));
    // 두 번째 종료는 없는 도구다.
    assert_eq!(kill(&s, r#"{"toolId":"t1"}"#).await.status, 404);
}

// ── create ──

#[tokio::test]
async fn create_without_hub_is_500() {
    let (_d, s) = srv(Deps::default());
    let r = post_json(&s, "/api/tools", "").await;
    assert_eq!(r.status, 500);
    assert_eq!(
        r.header(otter_shared_httpresp::CODE_HEADER),
        apierr::CODE_TOOLS_UNREADY
    );
}

#[tokio::test]
async fn create_success() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let r = post_json(&s, "/api/tools?cols=80&rows=24", "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.trim(), r#"{"id":"fake1","name":"Fake fake1"}"#);
    let (cwd, c, rw, _) = h.last.lock().unwrap().clone().unwrap();
    assert_eq!((cwd.as_str(), c, rw), ("", 80, 24));
}

#[tokio::test]
async fn create_oversized_cols_falls_back() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    assert_eq!(
        post_json(&s, "/api/tools?cols=8000&rows=24", "")
            .await
            .status,
        200
    );
    let (_, c, rw, _) = h.last.lock().unwrap().clone().unwrap();
    assert_eq!((c, rw), (DEFAULT_COLS, 24));
}

#[tokio::test]
async fn create_cwd_tool_ref_resolves_live_cwd() {
    let h = Arc::new(FakeHub::default());
    h.seed("ref", "Ref");
    h.cwds
        .lock()
        .unwrap()
        .insert("ref".into(), "/parent/dir".into());
    let (_d, s) = srv(hub_deps(&h));
    assert_eq!(
        post_json(&s, "/api/tools?cwdTool=ref", "").await.status,
        200
    );
    assert_eq!(h.last.lock().unwrap().clone().unwrap().0, "/parent/dir");
}

#[tokio::test]
async fn create_explicit_cwd_wins() {
    let h = Arc::new(FakeHub::default());
    h.seed("ref", "Ref");
    h.cwds
        .lock()
        .unwrap()
        .insert("ref".into(), "/parent/dir".into());
    let (d, s) = srv(hub_deps(&h));
    let explicit = d.path().to_string_lossy().into_owned();
    // 임시 경로에는 쿼리에서 이스케이프할 글자가 없다.
    let target = format!("/api/tools?cwd={explicit}&cwdTool=ref");
    assert_eq!(post_json(&s, &target, "").await.status, 200);
    assert_eq!(h.last.lock().unwrap().clone().unwrap().0, explicit);
}

#[tokio::test]
async fn create_missing_or_file_cwd_is_400() {
    let h = Arc::new(FakeHub::default());
    let (d, s) = srv(hub_deps(&h));
    let file = d.path().join("f.txt");
    std::fs::write(&file, "x").unwrap();
    for p in [d.path().join("does-not-exist"), file] {
        let p = p.to_string_lossy().into_owned();
        let target = format!("/api/tools?cwd={p}");
        let r = post_json(&s, &target, "").await;
        assert_eq!(r.status, 400, "{p}");
        assert_eq!(r.body.trim(), format!("cwd is not a directory: {p}"));
        assert_eq!(
            r.header(otter_shared_httpresp::CODE_HEADER),
            apierr::CODE_TOOL_CWD_MISSING
        );
    }
    assert_eq!(
        h.created.load(Ordering::SeqCst),
        0,
        "400 인데 도구를 만들었다"
    );
}

#[tokio::test]
async fn create_missing_cwd_with_sandbox_is_left_to_placer() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    let r = post_json(&s, "/api/tools?cwd=/no/such/dir&sandbox=scratch", "").await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn create_unknown_cwd_tool_falls_back() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    assert_eq!(
        post_json(&s, "/api/tools?cwdTool=missing", "").await.status,
        200
    );
    assert_eq!(h.last.lock().unwrap().clone().unwrap().0, "");
}

#[tokio::test]
async fn create_carries_sandbox_context_and_render_env() {
    let h = Arc::new(FakeHub::default());
    let st = Arc::new(FakeSettings::default());
    *st.blob.lock().unwrap() = br#"{"claudeFullscreen":false,"claudeScrollSpeed":9}"#.to_vec();
    let (_d, s) = srv(Deps {
        tools: Some(h.clone()),
        settings: Some(st),
        ..Deps::default()
    });
    let r = post_json(
        &s,
        "/api/tools?window=w-42&sandbox=scratch&sandboxWork=copy",
        "",
    )
    .await;
    assert_eq!(r.status, 200);
    let place = h.last.lock().unwrap().clone().unwrap().3;
    assert_eq!(
        place,
        Placement {
            window_uuid: "w-42".into(),
            profile: "scratch".into(),
            work: "copy".into(),
            extra_env: vec!["CLAUDE_CODE_SCROLL_SPEED=9".into()],
            ..Placement::default()
        }
    );
}

#[tokio::test]
async fn create_without_sandbox_stays_host_with_default_env() {
    let h = Arc::new(FakeHub::default());
    let (_d, s) = srv(hub_deps(&h));
    assert_eq!(post_json(&s, "/api/tools", "").await.status, 200);
    let place = h.last.lock().unwrap().clone().unwrap().3;
    assert_eq!(place.profile, "");
    assert_eq!(
        place.extra_env,
        crate::agent_render_env::agent_render_env(&[])
    );
}

#[tokio::test]
async fn create_cap_is_429_with_reason() {
    let h = Arc::new(FakeHub {
        cap: true,
        ..FakeHub::default()
    });
    let (_d, s) = srv(hub_deps(&h));
    let r = post_json(&s, "/api/tools", "").await;
    assert_eq!(r.status, 429);
    assert_eq!(r.body.trim(), "도구 상한(2)에 닿았습니다");
}

#[tokio::test]
async fn create_failure_hides_cause() {
    let h = Arc::new(FakeHub {
        create_err: Some("open /dev/ptmx: /secret/path".into()),
        ..FakeHub::default()
    });
    let (_d, s) = srv(hub_deps(&h));
    let r = post_json(&s, "/api/tools", "").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.body.trim(), "도구를 만들지 못했습니다");
}

// ── state ──

#[tokio::test]
async fn state_without_hub_is_500() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/state").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.body.trim(), "tools unavailable");
}

#[tokio::test]
async fn state_happy_path() {
    let h = Arc::new(FakeHub::default());
    h.seed("1", "Shell #1");
    let w = Arc::new(FakeWork::with(
        r#"{"schemaVersion": 2, "windows":[{"id":"s1"}]}"#,
        7,
    ));
    let (_d, s) = srv(Deps {
        tools: Some(h),
        work: Some(w),
        ..Deps::default()
    });
    let r = get(&s, "/api/state").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("ETag"), "7");
    let v = r.json();
    assert_eq!(v["toolsKnown"], true);
    assert_eq!(v["tools"].as_array().unwrap().len(), 1);
    assert_eq!(v["workspace"]["windows"].as_array().unwrap().len(), 1);
    // 설정 저장소를 주지 않으면 `new` 가 기본 저장소를 세운다 — 빈 blob 은 켬이다.
    assert_eq!(v["fgTabNames"], true);
}

#[tokio::test]
async fn state_tools_unknown() {
    let h = Arc::new(FakeHub {
        unknown: true,
        ..FakeHub::default()
    });
    let w = Arc::new(FakeWork::with(
        r#"{"schemaVersion": 2, "windows":[{"id":"s1"}]}"#,
        11,
    ));
    let (_d, s) = srv(Deps {
        tools: Some(h),
        work: Some(w),
        ..Deps::default()
    });
    let r = get(&s, "/api/state").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["toolsKnown"], false);
    assert!(v["tools"].is_null());
    assert_eq!(v["workspace"]["windows"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn state_workspace_passed_through_and_setting_carried() {
    let raw = r#"{"windows":[],"activeWindow":"w1","schemaVersion":2}"#;
    let st = Arc::new(FakeSettings::default());
    *st.blob.lock().unwrap() = br#"{"fgTabNames":false}"#.to_vec();
    let (_d, s) = srv(Deps {
        tools: Some(Arc::new(FakeHub::default())),
        work: Some(Arc::new(FakeWork::with(raw, 3))),
        settings: Some(st.clone()),
        ..Deps::default()
    });
    let r = get(&s, "/api/state").await;
    assert_eq!(
        r.body.trim(),
        format!(r#"{{"tools":[],"toolsKnown":true,"workspace":{raw},"fgTabNames":false}}"#)
    );
    st.blob.lock().unwrap().clear();
    assert_eq!(get(&s, "/api/state").await.json()["fgTabNames"], true);
}

#[tokio::test]
async fn state_broken_or_empty_workspace_is_null() {
    for raw in ["", r#"{"windows":"#] {
        let (_d, s) = srv(Deps {
            tools: Some(Arc::new(FakeHub::default())),
            work: Some(Arc::new(FakeWork::with(raw, 0))),
            ..Deps::default()
        });
        let v = get(&s, "/api/state").await.json();
        assert!(v["workspace"].is_null(), "raw {raw:?}");
    }
}

#[tokio::test]
async fn method_mismatch_is_404() {
    let (_d, s) = srv(Deps::default());
    for (m, p) in [
        ("POST", "/api/state"),
        ("PUT", "/api/state"),
        ("DELETE", "/api/workspace"),
    ] {
        assert_eq!(req(&s, m, p, &[], "").await.status, 404, "{m} {p}");
    }
}

// ── workspace ──

#[tokio::test]
async fn workspace_get() {
    let w = Arc::new(FakeWork::with(r#"{"schemaVersion": 2, "windows":[]}"#, 3));
    let (_d, s) = srv(Deps {
        work: Some(w),
        ..Deps::default()
    });
    let r = get(&s, "/api/workspace").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("ETag"), "3");
    assert_eq!(r.header("Content-Type"), "application/json");
    assert_eq!(r.body, r#"{"schemaVersion": 2, "windows":[]}"#);
}

#[tokio::test]
async fn workspace_get_without_store_is_null() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/workspace").await;
    assert_eq!(
        (r.status, r.body.as_str(), r.header("ETag")),
        (200, "null", "0".into())
    );
}

const OK_WS: &str = r#"{"schemaVersion":2,"windows":[]}"#;

async fn put_ws(s: &Arc<Server>, body: &str, if_match: &str) -> Resp {
    req(s, "PUT", "/api/workspace", &[("If-Match", if_match)], body).await
}

#[tokio::test]
async fn workspace_put_without_store_is_500() {
    let (_d, s) = srv(Deps::default());
    let r = put_ws(&s, "{}", "0").await;
    assert_eq!(r.status, 500);
    assert_eq!(
        r.header(otter_shared_httpresp::CODE_HEADER),
        apierr::CODE_WORK_UNREADY
    );
}

#[tokio::test]
async fn workspace_put_requires_if_match() {
    let w = Arc::new(FakeWork::default());
    let (_d, s) = srv(Deps {
        work: Some(w.clone()),
        ..Deps::default()
    });
    let r = put_ws(&s, OK_WS, "").await;
    assert_eq!(r.status, 428);
    assert_eq!(r.body.trim(), "If-Match required");
    assert_eq!(r.header("ETag"), "0");
    assert_eq!(w.saves.load(Ordering::SeqCst), 0, "거절했는데 저장됐다");
}

#[tokio::test]
async fn workspace_put_broadcasts_and_reports_rev() {
    let w = Arc::new(FakeWork::default());
    let (cmds, sub) = subscribed();
    let (_d, s) = srv(Deps {
        work: Some(w.clone()),
        commands: Some(cmds),
        ..Deps::default()
    });
    let r = put_ws(&s, OK_WS, "0").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, "");
    assert_eq!(r.header("ETag"), "1");
    // TC-CH2B-4: 워크스페이스 변화는 SSE 가 아니라 `workspace` 토픽으로 간다.
    assert!(drain(&sub).is_empty());
    // 같은 본문은 rev 를 올리지 않는다 (FR-OPT-5-1).
    let r = put_ws(&s, OK_WS, "1").await;
    assert_eq!((r.status, r.header("ETag")), (200, "1".into()));
    assert!(drain(&sub).is_empty());
}

#[tokio::test]
async fn workspace_put_stale_is_409() {
    let w = Arc::new(FakeWork::default());
    let (_d, s) = srv(Deps {
        work: Some(w),
        ..Deps::default()
    });
    let r = put_ws(&s, OK_WS, "9999").await;
    assert_eq!(r.status, 409);
    assert_eq!(
        r.header(otter_shared_httpresp::CODE_HEADER),
        apierr::CODE_STALE_REV
    );

    let w = Arc::new(FakeWork {
        stale: true,
        rev: 5.into(),
        ..FakeWork::default()
    });
    let (_d, s) = srv(Deps {
        work: Some(w),
        ..Deps::default()
    });
    let r = put_ws(&s, "{}", "0").await;
    assert_eq!((r.status, r.header("ETag")), (409, "5".into()));
}

#[tokio::test]
async fn workspace_put_reaps_with_live_windows() {
    let w = Arc::new(FakeWork {
        windows: Some(vec![WindowInfo {
            uuid: "w-live".into(),
            sandbox: "scratch".into(),
        }]),
        ..FakeWork::default()
    });
    let reaper = Arc::new(FakeReaper::default());
    let (_d, s) = srv(Deps {
        work: Some(w),
        sandbox: Some(reaper.clone()),
        ..Deps::default()
    });
    assert_eq!(put_ws(&s, OK_WS, "0").await.status, 200);
    assert_eq!(
        *reaper.calls.lock().unwrap(),
        vec![vec!["w-live".to_owned()]]
    );
}

#[tokio::test]
async fn workspace_put_unreadable_workspace_skips_reap() {
    let w = Arc::new(FakeWork::default());
    let reaper = Arc::new(FakeReaper::default());
    let (_d, s) = srv(Deps {
        work: Some(w),
        sandbox: Some(reaper.clone()),
        ..Deps::default()
    });
    assert_eq!(put_ws(&s, OK_WS, "0").await.status, 200);
    assert!(reaper.calls.lock().unwrap().is_empty());
}

// ── stats ──

fn stats_srv(snap: Snapshot) -> (tempfile::TempDir, Arc<Server>, Arc<FakeStats>) {
    let fs = Arc::new(FakeStats {
        snap,
        ..FakeStats::default()
    });
    let (d, s) = srv(Deps {
        stats: Some(fs.clone()),
        ..Deps::default()
    });
    (d, s, fs)
}

fn keys(v: &serde_json::Value) -> Vec<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

#[tokio::test]
async fn stats_all_valid() {
    let boot = SystemTime::now() - Duration::from_secs(3 * 3600);
    let (_d, s, _) = stats_srv(Snapshot {
        cpu: 27.7,
        cpu_valid: true,
        mem_total: 34359738368,
        mem_used: 6624083968,
        mem_valid: true,
        mem_total_valid: true,
        disk_pct: 42.1,
        disk_valid: true,
        boot_time: Some(boot),
    });
    let r = get(&s, "/api/stats").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(
        keys(&v),
        [
            "cpu",
            "diskPct",
            "hostname",
            "memTotal",
            "memUsed",
            "srvUptime",
            "sysUptime"
        ]
    );
    assert!(
        r.body.contains(r#""cpu":27.7,"diskPct":42.1,"#),
        "{}",
        r.body
    );
    assert!(
        r.body
            .contains(r#""memTotal":34359738368,"memUsed":6624083968,"#)
    );
    assert_eq!(v["sysUptime"], "3h 0m");
    assert_eq!(v["srvUptime"], "0m");
}

#[tokio::test]
async fn stats_omits_invalid_keys() {
    let (_d, s, _) = stats_srv(Snapshot {
        disk_pct: 10.0,
        disk_valid: true,
        ..Snapshot::default()
    });
    assert_eq!(
        keys(&get(&s, "/api/stats").await.json()),
        ["diskPct", "hostname", "srvUptime"]
    );
}

#[tokio::test]
async fn stats_cold_start_and_mem_total_only() {
    let (_d, s, _) = stats_srv(Snapshot {
        mem_total: 100,
        mem_used: 20,
        mem_valid: true,
        ..Snapshot::default()
    });
    assert_eq!(
        keys(&get(&s, "/api/stats").await.json()),
        ["hostname", "memTotal", "memUsed", "srvUptime"]
    );
    let (_d, s, _) = stats_srv(Snapshot {
        mem_total: 100,
        mem_total_valid: true,
        ..Snapshot::default()
    });
    let v = get(&s, "/api/stats").await.json();
    assert_eq!(keys(&v), ["hostname", "memTotal", "srvUptime"]);
    assert_eq!(v["memTotal"], 100);
}

#[tokio::test]
async fn stats_without_provider_and_once_per_request() {
    let (_d, s) = srv(Deps::default());
    let v = get(&s, "/api/stats?jobs=1").await.json();
    assert_eq!(keys(&v), ["hostname", "srvUptime"]);
    assert_eq!(v["hostname"], otter_shared_platform::hostname().unwrap());

    let (_d, s, fs) = stats_srv(Snapshot::default());
    for _ in 0..5 {
        get(&s, "/api/stats").await;
    }
    assert_eq!(fs.calls.load(Ordering::SeqCst), 5);
}

#[test]
fn fmt_duration_table() {
    const M: i128 = 60 * 1_000_000_000;
    let cases = [
        (0, "0m"),
        (59 * M, "59m"),
        (60 * M, "1h 0m"),
        (61 * M, "1h 1m"),
        (24 * 60 * M - 1, "23h 59m"),
        (24 * 60 * M, "1d 0h"),
        ((49 * 60 + 30) * M, "2d 1h"),
        (-M / 2, "0m"),
        (-5 * M, "-5m"),
    ];
    for (d, want) in cases {
        assert_eq!(fmt_duration(d), want, "{d}");
    }
}
