//! 보고 소켓 — 보고 반영·push·교체 제어·리스너 인계 (report_test.go · control_test.go ·
//! handover_posix_test.go).

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use dm_shared_activity as activity;
use dm_shared_agentrec as agentrec;
use dm_shared_handover as handover;
use dm_shared_toolhub::ToolManager;
use serde_json::Value;

use super::{daemon, raw, report_call};
use crate::PanedServer;

const OK: &str = r#"{"ok":true}"#;

fn report(path: &std::path::Path, method: &str, body: &str) -> String {
    report_call(path, &format!(r#"{{"method":"{method}","body":{body}}}"#))
}

#[tokio::test(flavor = "multi_thread")]
async fn report_rejects_unknown_method_and_tool() {
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    let cases = [
        (
            "write",
            r#"{"toolId":"t1"}"#,
            "보고 소켓이 받지 않는 메서드다: write",
        ),
        (
            "recordset",
            r#"{"toolId":"t1"}"#,
            "보고 소켓이 받지 않는 메서드다: recordset",
        ),
        (
            agentrec::METHOD_NOTIFY,
            r#"{"toolId":"nope"}"#,
            "toolhub: tool not found",
        ),
        (agentrec::METHOD_NOTIFY, "{}", "toolId 가 비었다"),
        (
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"nap"}"#,
            "활동 상태가 틀렸다",
        ),
        (
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"idle","agentId":"a1"}"#,
            "활동 상태가 틀렸다",
        ),
    ];
    for (m, body, want) in cases {
        assert_eq!(
            report(&d.report, m, body),
            format!(r#"{{"ok":false,"error":"{want}"}}"#),
            "{m} {body}"
        );
    }
    let broken = report(&d.report, agentrec::METHOD_ACTIVITY, "[1]");
    assert!(
        broken.starts_with(r#"{"ok":false,"error":"json: "#),
        "{broken}"
    );
    assert!(p.activity().is_none() && !p.attention() && p.records().is_empty());
}

/// 서버 없이 받은 보고가 스냅샷에 실린다 (FR-ARD-25 · TC-ARD-22). ended 는 카드와 서브에이전트
/// 활동을 함께 거둔다 (FR-ASV-12).
#[tokio::test(flavor = "multi_thread")]
async fn report_without_server_records_into_snapshot() {
    let Some(agent) = dm_shared_agentadapter::status_line_reporter() else {
        return;
    };
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    let reqs = [
        (
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"working","tool":"Bash\u0007"}"#,
        ),
        (
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"done"}"#,
        ),
        (
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"working","agentId":"a1","agentType":"Explore"}"#,
        ),
        (
            agentrec::METHOD_USAGE,
            r#"{"toolId":"t1","usage":{"effort":"high","rateLimits":{"five_hour":{"usedPct":30}}}}"#,
        ),
        (
            agentrec::METHOD_SUBAGENTS,
            r#"{"toolId":"t1","tasks":[{"id":"a1"}]}"#,
        ),
    ];
    for (m, body) in reqs {
        assert_eq!(report(&d.report, m, body), OK, "{m}");
    }
    let mut c = raw(&d.sock);
    c.hello(&[dm_shared_toolipc::FEATURE_REPORTS]);
    let out: Value =
        serde_json::from_str(&c.call(r#"{"id":1,"method":"records","params":{}}"#)).unwrap();
    let res = &out["result"];
    let tools = res["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1, "{res}");
    let tr = &tools[0];
    assert_eq!(tr["agent"]["activity"]["state"], activity::DONE, "{tr}");
    assert_eq!(tr["agent"]["agentSeen"], true, "{tr}");
    assert_eq!(tr["agent"]["attention"], true, "{tr}");
    let rec = |k: &str| -> Value { tr["records"][k].clone() };
    let u = rec("usage");
    assert_eq!(u["effort"], "high", "{u}");
    assert!(u["observedAt"].as_i64().is_some_and(|v| v != 0), "{u}");
    let s = rec("subagents");
    assert_eq!(s["tasks"].as_array().map(Vec::len), Some(1), "{s}");
    assert!(s["observedAt"].as_i64().is_some_and(|v| v != 0), "{s}");
    assert_eq!(rec("subagentActs")["a1"]["agentType"], "Explore", "{tr}");
    let limits = &res["global"]["limits"];
    assert!(
        !limits[agent]["windows"]["five_hour"]["usedPct"].is_null(),
        "{limits}"
    );

    assert_eq!(
        report(
            &d.report,
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"ended"}"#
        ),
        OK
    );
    assert!(p.activity().is_none(), "ended 뒤 카드가 남았다");
    assert!(
        !p.records().contains_key("subagentActs"),
        "ended 뒤 서브에이전트 활동이 남았다"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn report_notify_sets_attention() {
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    assert_eq!(
        report(
            &d.report,
            agentrec::METHOD_NOTIFY,
            r#"{"toolId":"t1","reason":"permission"}"#
        ),
        OK
    );
    assert!(p.attention());
}

/// 붙은 서버에는 기록이 아니라 보고 자체를 push 한다 (§3.2a). push 는 하나뿐이다.
#[tokio::test(flavor = "multi_thread")]
async fn report_with_server_pushes_report() {
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    let mut c = raw(&d.sock);
    c.hello(&[dm_shared_toolipc::FEATURE_REPORTS]);
    assert_eq!(
        report(
            &d.report,
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"working"}"#
        ),
        OK
    );
    assert_eq!(
        c.recv(),
        r#"{"event":"report","method":"report.activity","body":{"toolId":"t1","state":"working"}}"#
    );
    assert_eq!(
        c.call(r#"{"id":2,"method":"busy","params":{"id":"t1"}}"#),
        r#"{"id":2,"result":{"busy":false}}"#
    );
    assert!(p.activity().is_some(), "데몬이 먼저 기록하지 않았다");
}

/// reports 를 모르는 서버가 붙어 있으면 거절한다 — 기록도 push 도 없다 (TC-ARD-24).
#[tokio::test(flavor = "multi_thread")]
async fn report_old_server_rejects() {
    let d = daemon("b");
    let p = d.srv.inner.pm.adopt_detached("t1");
    let mut c = raw(&d.sock);
    c.hello(&[]);
    assert_eq!(
        report(
            &d.report,
            agentrec::METHOD_ACTIVITY,
            r#"{"toolId":"t1","state":"working"}"#
        ),
        r#"{"ok":false,"error":"붙은 서버가 report push 를 모른다"}"#
    );
    assert_eq!(
        c.call(r#"{"id":2,"method":"busy","params":{"id":"t1"}}"#),
        r#"{"id":2,"result":{"busy":false}}"#
    );
    assert!(p.activity().is_none());
    // hello 는 교체를 아는 데몬의 표지다. 옛 서버가 붙어 있어도 답한다 (FR-DSK-17).
    assert_eq!(report_call(&d.report, r#"{"method":"daemon.hello"}"#), OK);
}

/// 연결을 동시에 받는다. 아무것도 보내지 않고 붙든 연결이 있어도 다른 연결은 답을 받는다.
/// 소켓은 0600 이고 Close 가 치운다 (TC-ARD-20).
#[tokio::test(flavor = "multi_thread")]
async fn report_socket_serves_concurrently() {
    let d = daemon("b");
    let pm = Arc::clone(&d.srv.inner.pm);
    pm.adopt_detached("t1");
    pm.adopt_detached("t2");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&d.report).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let _idle = raw(&d.report);
    let hs: Vec<_> = ["t1", "t2"]
        .into_iter()
        .map(|id| {
            let path = d.report.clone();
            std::thread::spawn(move || {
                report(
                    &path,
                    agentrec::METHOD_NOTIFY,
                    &format!(r#"{{"toolId":"{id}"}}"#),
                )
            })
        })
        .collect();
    for h in hs {
        assert_eq!(h.join().unwrap(), OK);
    }
    assert!(pm.get("t1").unwrap().attention() && pm.get("t2").unwrap().attention());
    d.srv.close();
    assert!(!d.report.exists(), "Close 가 보고 소켓을 치우지 않았다");
}

/// 계정을 실은 사용량 보고는 에이전트 단위 한도 기록에 들어가지 않는다 (FR-CAC-78).
#[tokio::test(flavor = "multi_thread")]
async fn report_usage_with_account_skips_agent_limits() {
    if dm_shared_agentadapter::status_line_reporter().is_none() {
        return;
    }
    let d = daemon("b");
    d.srv.inner.pm.adopt_detached("t1");
    assert_eq!(
        report(
            &d.report,
            agentrec::METHOD_USAGE,
            r#"{"toolId":"t1","usage":{"rateLimits":{"five_hour":{"usedPct":30}}},"account":{"email":"a@x.com","organizationUuid":"org-a"}}"#
        ),
        OK
    );
    let mut c = raw(&d.sock);
    let out: Value =
        serde_json::from_str(&c.call(r#"{"id":1,"method":"records","params":{}}"#)).unwrap();
    let l = &out["result"]["global"]["limits"];
    assert!(l.is_null() || l == &serde_json::json!({}), "limits={l}");
}

fn reload_body() -> String {
    format!(
        r#"{{"method":"daemon.reload","body":{{"exe":"/x/dongminal","handover":{}}}}}"#,
        handover::VERSION
    )
}

/// 교체기의 거절은 사유 코드 그대로 나간다. 교체기는 본문을 그대로 받는다 (FR-DSK-11).
#[tokio::test(flavor = "multi_thread")]
async fn control_reload_refusal_passes_reason() {
    let d = daemon("b");
    let (tx, rx) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    d.srv.set_reloader(Some(Arc::new(move |req| {
        let _ = crate::conn::lock(&tx).send((req.exe.clone(), req.handover));
        Err(format!("{}: 판이 다르다", handover::REASON_PREFLIGHT))
    })));
    assert_eq!(
        report_call(&d.report, &reload_body()),
        r#"{"ok":false,"error":"reload_preflight: 판이 다르다"}"#
    );
    assert_eq!(
        rx.recv().unwrap(),
        ("/x/dongminal".to_owned(), handover::VERSION)
    );
}

/// 성공 답이 먼저 나가고 그다음에 교체한다 (FR-DSK-13 6→7).
#[tokio::test(flavor = "multi_thread")]
async fn control_reload_replies_before_commit() {
    let d = daemon("b");
    let (rel_tx, rel_rx) = mpsc::channel::<()>();
    let (com_tx, com_rx) = mpsc::channel();
    let rel_rx = Arc::new(std::sync::Mutex::new(Some(rel_rx)));
    d.srv.set_reloader(Some(Arc::new(move |_| {
        let rel = crate::conn::lock(&rel_rx).take().unwrap();
        let com = com_tx.clone();
        Ok(Box::new(move || {
            let _ = rel.recv();
            let _ = com.send(());
        }))
    })));
    assert_eq!(report_call(&d.report, &reload_body()), OK);
    drop(rel_tx);
    com_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("답한 뒤 교체를 실행하지 않았다");
}

/// 보고 소켓의 2초 시한은 사전 확인보다 짧다. 교체 요청은 그보다 오래 기다린다 (FR-DSK-12).
#[tokio::test(flavor = "multi_thread")]
async fn control_reload_outlives_report_deadline() {
    let d = daemon("b");
    d.srv.set_reloader(Some(Arc::new(|_| {
        std::thread::sleep(agentrec::IO_TIMEOUT + Duration::from_millis(500));
        Err(format!("{}: 늦은 거절", handover::REASON_PREFLIGHT))
    })));
    assert_eq!(
        report_call(&d.report, &reload_body()),
        r#"{"ok":false,"error":"reload_preflight: 늦은 거절"}"#
    );
}

/// 두 소켓의 리스너를 fd 로 넘기고, 새 쪽이 소켓 파일을 다시 만들지 않고 그대로 받는다
/// (FR-DSK-14·24).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn handover_listeners_survive() {
    use std::os::fd::IntoRawFd;

    use dm_shared_platform::IpcListener;

    let dir = tempfile::Builder::new().prefix("dsk").tempdir().unwrap();
    let sock = dm_shared_platform::current().ipc.endpoint(dir.path());
    let rep = dir.path().join(agentrec::SOCKET_FILE);
    let pid = dir.path().join("paned.pid");
    let old = PanedServer::new(Arc::new(ToolManager::new("", None)), &sock, Some(&pid));
    old.listen().unwrap();
    old.listen_reports(&rep).unwrap();
    let (pf, rf) = old.listener_fds().unwrap();
    let pl = IpcListener::from_inherited_fd(pf.into_raw_fd()).unwrap();
    let rl = IpcListener::from_inherited_fd(rf.into_raw_fd()).unwrap();

    std::fs::remove_file(&pid).unwrap();
    let next = PanedServer::new(Arc::new(ToolManager::new("", None)), &sock, Some(&pid));
    next.listen_inherited(pl, rl, &rep);
    assert!(pid.exists(), "물려받은 뒤 pidfile 이 없다");
    let n = next.clone();
    std::thread::spawn(move || n.accept());
    let n = next.clone();
    std::thread::spawn(move || n.serve_reports());

    let mut c = raw(&sock);
    assert!(
        c.call(r#"{"id":1,"method":"hello","params":{}}"#)
            .starts_with(r#"{"id":1,"result""#)
    );
    assert_eq!(report_call(&rep, r#"{"method":"daemon.hello"}"#), OK);
}

/// 데몬 전체 기록(계정 한도)을 담고 되넣는다 (FR-DSK-14·23).
#[tokio::test(flavor = "multi_thread")]
async fn handover_global_records_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let a = PanedServer::new(
        Arc::new(ToolManager::new("", None)),
        &dir.path().join("a"),
        None,
    );
    a.inner
        .records
        .set("limits", &RawMessage(br#"{"claude":1}"#.to_vec()));
    let b = PanedServer::new(
        Arc::new(ToolManager::new("", None)),
        &dir.path().join("b"),
        None,
    );
    b.import_global(&a.export_global());
    assert_eq!(b.export_global()["limits"].0, br#"{"claude":1}"#);
}
