//! 샌드박스 종단 (Go `handlers_sandbox_actions_test.go`·`sandbox_handlers_test.go`).

use std::cell::Cell;
use std::sync::Arc;

use dm_shared_sandbox::{
    self as sandbox, DevConfig, Mount, PROFILE_DEV, ProfileInfo, RUNTIME_MISSING, RUNTIME_OK,
    RUNTIME_STOPPED, RunOutput, RuntimeStatus,
};
use dm_webserver_action::{self as action};
use dm_webserver_apierr as apierr;
use dm_webserver_hub::{CommandBroker, CommandHub};
use http_body_util::BodyExt;

use super::fakes::*;
use super::support::*;
use crate::sandbox_api::{
    SANDBOX_ONLY_DEFAULT_HEADER, config_json, sandbox_start_answer, write_sandbox_runtime,
    write_sandbox_start,
};
use crate::settings_etag::settings_tag;
use crate::{Deps, Server};

const JSON: &[(&str, &str)] = &[("Content-Type", "application/json")];

fn sbx_status(state: &str, goos: &str) -> RuntimeStatus {
    let (start_command, start_tryable) = sandbox::start_command(goos);
    RuntimeStatus {
        state: state.into(),
        os: goos.into(),
        runtime: "docker".into(),
        start_command,
        start_tryable,
        ..RuntimeStatus::default()
    }
}

async fn read(res: dm_shared_httpresp::Response) -> (u16, http::HeaderMap, String) {
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let b = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8_lossy(&b).into_owned())
}

#[test]
fn start_answer_table() {
    let cases = [
        (RUNTIME_STOPPED, "darwin", true, "", 0),
        (RUNTIME_STOPPED, "windows", true, "", 0),
        (RUNTIME_OK, "darwin", true, "", 0),
        (
            RUNTIME_MISSING,
            "darwin",
            false,
            apierr::CODE_RUNTIME_MISSING,
            409,
        ),
        (
            RUNTIME_STOPPED,
            "linux",
            false,
            apierr::CODE_RUNTIME_START_MANUAL,
            409,
        ),
        (
            RUNTIME_STOPPED,
            "wsl",
            false,
            apierr::CODE_RUNTIME_START_MANUAL,
            409,
        ),
        (
            RUNTIME_STOPPED,
            "plan9",
            false,
            apierr::CODE_RUNTIME_START_MANUAL,
            409,
        ),
        (
            RUNTIME_MISSING,
            "linux",
            false,
            apierr::CODE_RUNTIME_MISSING,
            409,
        ),
    ];
    for (state, goos, ok, why, status) in cases {
        let a = sandbox_start_answer(&sbx_status(state, goos));
        assert_eq!(
            (a.ok, a.why.as_str(), a.status),
            (ok, why, status),
            "{state}/{goos}"
        );
        if !a.ok {
            assert!(
                action::may_give(&action::catalog(), action::SANDBOX_RUNTIME_START, &a.why),
                "{} 가 Catalog 에 없다",
                a.why
            );
        }
    }
}

#[tokio::test]
async fn runtime_view_carries_answer_and_facts() {
    let (status, _, body) =
        read(write_sandbox_runtime(&sbx_status(RUNTIME_STOPPED, "linux"))).await;
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["state"], RUNTIME_STOPPED);
    assert_eq!(
        v["actions"][action::SANDBOX_RUNTIME_START],
        serde_json::json!({"ok": false, "why": apierr::CODE_RUNTIME_START_MANUAL})
    );
    for (state, ready, installed) in [
        (RUNTIME_OK, true, true),
        (RUNTIME_STOPPED, false, true),
        (RUNTIME_MISSING, false, false),
    ] {
        let (_, _, body) = read(write_sandbox_runtime(&sbx_status(state, "darwin"))).await;
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            (v["ready"].as_bool(), v["installed"].as_bool()),
            (Some(ready), Some(installed)),
            "{state}"
        );
    }
}

#[tokio::test]
async fn start_rejects_with_answer() {
    for st in [
        sbx_status(RUNTIME_MISSING, "darwin"),
        sbx_status(RUNTIME_STOPPED, "linux"),
    ] {
        let want = sandbox_start_answer(&st);
        let ran = Cell::new(false);
        let run = |_: &str, _: &[String]| {
            ran.set(true);
            RunOutput::ok("")
        };
        let (status, headers, body) = read(write_sandbox_start(&st, &run)).await;
        assert_eq!(status, want.status);
        assert_eq!(
            headers.get(dm_shared_httpresp::CODE_HEADER).unwrap(),
            want.why.as_str()
        );
        assert_eq!(body.trim(), want.why);
        assert!(!ran.get(), "거절했는데 명령을 실행했다");
    }
}

#[tokio::test]
async fn start_runs_when_allowed() {
    let ran = Cell::new(false);
    let run = |_: &str, _: &[String]| {
        ran.set(true);
        RunOutput::ok("")
    };
    let (status, _, body) = read(write_sandbox_start(
        &sbx_status(RUNTIME_STOPPED, "darwin"),
        &run,
    ))
    .await;
    assert!(status == 200 && ran.get());
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["started"], true);
}

fn srv(deps: Deps) -> (tempfile::TempDir, Arc<Server>) {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), deps);
    (dir, s)
}

fn with_reaper(r: &Arc<FakeReaper>) -> Deps {
    Deps {
        sandbox: Some(r.clone()),
        ..Deps::default()
    }
}

#[tokio::test]
async fn profiles_report_isolation_grade() {
    let r = Arc::new(FakeReaper {
        profiles: vec![
            ProfileInfo {
                name: "scratch".into(),
                isolated: true,
                ..ProfileInfo::default()
            },
            ProfileInfo {
                name: "dev".into(),
                image: "node:22".into(),
                helper: true,
                ..ProfileInfo::default()
            },
        ],
        ..FakeReaper::default()
    });
    let (_d, s) = srv(with_reaper(&r));
    let v = get(&s, "/api/sandbox/profiles").await.json();
    let a = v.as_array().unwrap();
    assert_eq!(a.len(), 2);
    assert_eq!(
        (a[0]["isolated"].as_bool(), a[1]["isolated"].as_bool()),
        (Some(true), Some(false))
    );
}

#[tokio::test]
async fn profiles_empty_without_runtime() {
    let (_d, s) = srv(Deps::default());
    let r = get(&s, "/api/sandbox/profiles").await;
    assert_eq!((r.status, r.body.trim()), (200, "[]"));
    assert_eq!(r.header(SANDBOX_ONLY_DEFAULT_HEADER), "0");
}

#[tokio::test]
async fn profiles_only_default_header() {
    let cases = [
        (vec![sandbox::scratch().info()], "1"),
        (
            vec![
                sandbox::scratch().info(),
                ProfileInfo {
                    name: PROFILE_DEV.into(),
                    ..ProfileInfo::default()
                },
            ],
            "0",
        ),
    ];
    for (list, want) in cases {
        let r = Arc::new(FakeReaper {
            profiles: list,
            ..FakeReaper::default()
        });
        let (_d, s) = srv(with_reaper(&r));
        let res = get(&s, "/api/sandbox/profiles").await;
        assert!(res.json().is_array());
        assert_eq!(res.header(SANDBOX_ONLY_DEFAULT_HEADER), want);
    }
}

#[tokio::test]
async fn config_unready_is_503() {
    let (_d, s) = srv(Deps::default());
    for m in ["GET", "PUT"] {
        let r = call(&s, m, "/api/sandbox/config", JSON, "{}", LOCAL).await;
        assert_eq!(r.status, 503, "{m}");
        assert_eq!(
            r.header(dm_shared_httpresp::CODE_HEADER),
            apierr::CODE_SANDBOX_UNREADY
        );
        assert_eq!(
            r.body.trim(),
            "샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)을 확인하세요"
        );
    }
}

#[tokio::test]
async fn config_read_and_write() {
    let mut cfg = sandbox::Config::default();
    cfg.mounts = vec![Mount {
        host: "/h".into(),
        container: "/c".into(),
        read_only: true,
        scratch: false,
    }];
    cfg.dev = Some(DevConfig {
        image: "node:22".into(),
        ports: Vec::new(),
    });
    let r = Arc::new(FakeReaper {
        cfg: Some(cfg.clone()),
        ..FakeReaper::default()
    });
    let cmds: Arc<dyn CommandBroker> = CommandHub::new();
    let sub = cmds.add().unwrap();
    let (_d, s) = srv(Deps {
        sandbox: Some(r.clone()),
        commands: Some(cmds),
        ..Deps::default()
    });
    let g = get(&s, "/api/sandbox/config").await;
    assert_eq!(g.status, 200);
    assert_eq!(
        g.body.trim(),
        r#"{"mounts":[{"Host":"/h","Container":"/c","ReadOnly":true,"Scratch":false}],"dev":{"image":"node:22"}}"#
    );
    let tag = settings_tag(&config_json(&cfg));
    assert_eq!(g.header("ETag"), tag);

    // 낡은 지문은 409 다.
    let stale = call(
        &s,
        "PUT",
        "/api/sandbox/config",
        &[("Content-Type", "application/json"), ("If-Match", "nope")],
        "{}",
        LOCAL,
    )
    .await;
    assert_eq!((stale.status, stale.header("ETag")), (409, tag.clone()));
    assert!(r.saved.lock().unwrap().is_empty());

    let put = call(
        &s,
        "PUT",
        "/api/sandbox/config",
        &[("Content-Type", "application/json"), ("If-Match", &tag)],
        r#"{"dev":{"image":"node:22"}}"#,
        LOCAL,
    )
    .await;
    assert_eq!((put.status, put.body.as_str()), (204, ""));
    assert_eq!(put.header("ETag"), tag);
    assert_eq!(
        *r.saved.lock().unwrap(),
        vec![r#"{"dev":{"image":"node:22"}}"#.to_owned()]
    );
    assert_eq!(
        sub.try_recv()
            .map(|b| String::from_utf8_lossy(&b).into_owned()),
        Some(r#"{"action":"sandbox_changed","args":{}}"#.to_owned())
    );
}

#[tokio::test]
async fn config_rejection_carries_reason() {
    let r = Arc::new(FakeReaper {
        save_err: Some(sandbox::Error::Msg("이미지가 없습니다".into())),
        ..FakeReaper::default()
    });
    let (_d, s) = srv(with_reaper(&r));
    let res = call(&s, "PUT", "/api/sandbox/config", JSON, "{}", LOCAL).await;
    assert_eq!((res.status, res.body.trim()), (400, "이미지가 없습니다"));

    let r = Arc::new(FakeReaper {
        save_err: Some(sandbox::Error::SaveFailed),
        ..FakeReaper::default()
    });
    let (_d, s) = srv(with_reaper(&r));
    let res = call(&s, "PUT", "/api/sandbox/config", JSON, "{}", LOCAL).await;
    assert_eq!(
        (res.status, res.body.trim()),
        (500, "샌드박스 정의를 저장하지 못했습니다")
    );
}

#[tokio::test]
async fn config_read_failure_is_500() {
    let r = Arc::new(FakeReaper {
        cfg_err: Some(sandbox::Error::Msg("/secret/sandbox.json: bad".into())),
        ..FakeReaper::default()
    });
    let (_d, s) = srv(with_reaper(&r));
    let res = get(&s, "/api/sandbox/config").await;
    assert_eq!(
        (res.status, res.body.trim()),
        (500, "샌드박스 정의를 읽지 못했습니다")
    );
}
