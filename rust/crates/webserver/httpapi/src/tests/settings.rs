//! Go `handlers_settings_fgtab_test.go`·`settings_save_fail_test.go`·`settings_theme_test.go`·
//! `settings_view_test.go`·`gitwatch_lease_test.go` 와 `handlers_api_test.go` 의 설정 시험, 그리고
//! `handlers_snapshot_test.go` 의 `settings` 조각을 옮긴다.
//!
//! 옮기지 않은 것: 없음. 감시 이벤트의 git 계기 관측(`newFSWatch` 의 `Kick`)은 Go 에도 배선 시험이
//! 없다 — 규칙은 hub 의 kick 시험이 잰다.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use otter_webserver_domain_git_core::Service;
use otter_webserver_domain_git_store::{Store, StoreOptions};
use otter_webserver_hub::CommandBroker;

use super::fakes::{FakeBroker, FakeSettings};
use super::support::{LOCAL, call, get, server};
use crate::agent_render_env::CLAUDE_NO_FLICKER_ENV;
use crate::deps::SettingsStore;
use crate::settings::{FileSettings, parse_fg_tab_names};
use crate::{Deps, Server};

async fn put(s: &Arc<Server>, target: &str, body: &str) -> super::support::Resp {
    call(
        s,
        "PUT",
        target,
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await
}

fn file_settings(dir: &std::path::Path) -> Arc<FileSettings> {
    Arc::new(FileSettings::new(dir.join("settings.json")))
}

// parseFgTabNames 는 SETTINGS_SCHEMA 기본(켬)을 따른다.
#[test]
fn parse_fg_tab_names_defaults() {
    for (blob, want) in [
        (r#"{"fgTabNames":null}"#, true),
        ("{}", true),
        ("", true),
        (r#"{"fgTabNames":false}"#, false),
        (r#"{"fgTabNames":"no"}"#, true),
    ] {
        assert_eq!(parse_fg_tab_names(blob.as_bytes()), want, "{blob:?}");
    }
}

// M3 DoD — 디스크 쓰기가 실패하면 PUT 은 500 이다.
#[tokio::test]
async fn settings_put_reports_write_failure() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("settings.json")).unwrap();
    let s = server(
        d.path(),
        Deps {
            settings: Some(file_settings(d.path())),
            ..Deps::default()
        },
    );
    let r = put(&s, "/api/settings", r#"{"a":1}"#).await;
    assert_eq!(r.status, 500, "쓰지 못했는데 성공이라 답했다");
    assert_eq!(r.header("X-Error-Code"), "save_failed");
    assert_eq!(r.body, "settings save failed\n");
}

#[tokio::test]
async fn settings_put_still_ok() {
    let d = tempfile::tempdir().unwrap();
    let s = server(
        d.path(),
        Deps {
            settings: Some(file_settings(d.path())),
            ..Deps::default()
        },
    );
    let r = put(&s, "/api/settings", r#"{"a":1}"#).await;
    assert_eq!((r.status, r.body.as_str()), (200, ""));
    assert_eq!(
        std::fs::read(d.path().join("settings.json")).unwrap(),
        br#"{"a":1}"#
    );
}

// TC-CH2B-2·4: 설정 저장은 SSE 로 방송하지 않고 `settings` 토픽으로 낸다.
#[tokio::test]
async fn settings_put_publishes_topic_not_sse() {
    let d = tempfile::tempdir().unwrap();
    let cb = Arc::new(FakeBroker::default());
    let s = server(
        d.path(),
        Deps {
            settings: Some(file_settings(d.path())),
            commands: Some(cb.clone() as Arc<dyn CommandBroker>),
            ..Deps::default()
        },
    );
    let o = super::full_topics::tap(&s, "settings").await;
    super::full_topics::heard(&o, 1).await;
    let r = put(&s, "/api/settings?clientId=c-1", r#"{"a":1}"#).await;
    assert_eq!(r.status, 200);
    let got = super::full_topics::heard(&o, 1).await;
    assert_eq!(got.last().unwrap()["data"], serde_json::json!({"a":1}));
    assert!(cb.published().is_empty(), "{:?}", cb.published());
}

// TC-QG-11: 나쁜 customTheme 은 400 bad_request 이고 저장되지 않는다. 정상 블롭은 200.
#[tokio::test]
async fn settings_put_rejects_bad_theme() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("settings.json");
    let s = server(
        d.path(),
        Deps {
            settings: Some(file_settings(d.path())),
            ..Deps::default()
        },
    );
    let r = put(
        &s,
        "/api/settings",
        r#"{"customTheme":{"ui":{"bg":"red\"><img src=x onerror=alert(1)>"}}}"#,
    )
    .await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str()),
        (400, "bad_request")
    );
    assert!(r.body.contains("customTheme.ui.bg"), "{:?}", r.body);
    assert!(!p.exists(), "거절했는데 저장했다");

    let ok = r##"{"customTheme":{"mode":"light","ui":{"bg":"#ffffff"},"terminal":{"red":"#ff000080"}}}"##;
    assert_eq!(put(&s, "/api/settings", ok).await.status, 200);
}

// FR-RQG-16: JSON 이 아니면 저장하지 않는다.
#[tokio::test]
async fn settings_put_rejects_non_json() {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), Deps::default());
    let r = put(&s, "/api/settings", "{nope").await;
    assert_eq!(
        (r.status, r.header("X-Error-Code").as_str(), r.body.as_str()),
        (400, "invalid_json", "settings must be JSON\n")
    );
    assert!(!d.path().join("settings.json").exists());
}

// FR-OPT-8-2 (HTTP-26): 서버가 읽는 가지는 blob 이 바뀔 때만 다시 푼다.
#[test]
fn settings_view_memoized_until_set() {
    let d = tempfile::tempdir().unwrap();
    let st = FileSettings::new(d.path().join("settings.json"));
    st.set(br#"{"claudeFullscreen":false,"orchestration":{"contextWarnRatio":0.4}}"#.to_vec());
    let v1 = st.view();
    assert!(
        Arc::ptr_eq(&v1, &st.view()),
        "바뀌지 않은 blob 을 다시 해석했다"
    );
    assert_eq!(v1.policy.warn_ratio, 0.4);
    assert!(
        !v1.render_env.iter().any(|e| e == CLAUDE_NO_FLICKER_ENV),
        "claudeFullscreen:false 인데 fullscreen 변수가 있다"
    );
    st.set(br#"{"orchestration":{"contextWarnRatio":0.5}}"#.to_vec());
    let v2 = st.view();
    assert!(!Arc::ptr_eq(&v1, &v2));
    assert_eq!(v2.policy.warn_ratio, 0.5, "Set 뒤에도 옛 해석이다");
    assert_eq!(
        v2.render_env.first().map(String::as_str),
        Some(CLAUDE_NO_FLICKER_ENV)
    );
    let mut env = st.render_env();
    env[0] = "X=1".into();
    assert_eq!(
        st.view().render_env[0],
        CLAUDE_NO_FLICKER_ENV,
        "캐시를 그대로 내준다"
    );
}

#[tokio::test]
async fn settings_get() {
    let d = tempfile::tempdir().unwrap();
    let fs = Arc::new(FakeSettings {
        blob: Mutex::new(br#"{"theme":"dark"}"#.to_vec()),
        ..FakeSettings::default()
    });
    let s = server(
        d.path(),
        Deps {
            settings: Some(fs),
            ..Deps::default()
        },
    );
    let r = get(&s, "/api/settings").await;
    assert_eq!((r.status, r.body.as_str()), (200, r#"{"theme":"dark"}"#));
    assert_eq!(r.header("Content-Type"), "application/json");
}

// 설정 저장소를 주지 않으면 `new` 가 데이터 디렉터리의 파일로 세운다 — 비었으면 `{}` 다.
#[tokio::test]
async fn settings_get_empty() {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), Deps::default());
    let r = get(&s, "/api/settings").await;
    assert_eq!((r.status, r.body.as_str()), (200, "{}"));
}

#[tokio::test]
async fn settings_default_store_reads_data_dir() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("settings.json"), br#"{"k":"v"}"#).unwrap();
    let s = server(d.path(), Deps::default());
    assert_eq!(get(&s, "/api/settings").await.body, r#"{"k":"v"}"#);
}

#[tokio::test]
async fn settings_put_saves_once() {
    let d = tempfile::tempdir().unwrap();
    let fs = Arc::new(FakeSettings::default());
    let s = server(
        d.path(),
        Deps {
            settings: Some(fs.clone()),
            ..Deps::default()
        },
    );
    let r = put(&s, "/api/settings", r#"{"theme":"light"}"#).await;
    assert_eq!(r.status, 200);
    assert_eq!(fs.saves.load(Ordering::SeqCst), 1);
    assert_eq!(fs.get(), br#"{"theme":"light"}"#);
}

#[test]
fn settings_store_roundtrip() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("settings.json");
    std::fs::write(&path, br#"{"k":"v"}"#).unwrap();
    let s = FileSettings::new(path.clone());
    assert_eq!(s.get(), br#"{"k":"v"}"#);
    s.set(br#"{"k":"w"}"#.to_vec());
    assert_eq!(s.get(), br#"{"k":"w"}"#);
    s.save().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), br#"{"k":"w"}"#);

    // 빈 저장은 파일을 만들지 않는다.
    let empty = d.path().join("empty.json");
    FileSettings::new(empty.clone()).save().unwrap();
    assert!(!empty.exists(), "빈 저장이 파일을 만들었다");
}

// FR-OPT-4-5: snapshot 의 settings 조각은 종단의 본문 그대로다.
#[tokio::test]
async fn snapshot_settings_part() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("settings.json"), br#"{"a": [1, 2]}"#).unwrap();
    let s = server(d.path(), Deps::default());
    let r = get(&s, "/api/snapshot?parts=settings,bogus").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (200, "{\"settings\":{\"a\":[1,2]}}\n")
    );
}

// ── git 감시 (GIT_PUSH_OBSERVE_SRS · GIT_WATCH_LEASE_SRS) ──

#[test]
fn git_watch_follows_git_store() {
    let d = tempfile::tempdir().unwrap();
    assert!(server(d.path(), Deps::default()).git_watch.is_none());
    let store = Store::new(Arc::new(Service::new()), StoreOptions::default());
    let s = server(
        d.path(),
        Deps {
            git_store: Some(store),
            ..Deps::default()
        },
    );
    assert!(s.git_watch.is_some(), "저장소 계층이 있는데 감시자가 없다");
}

#[tokio::test]
async fn start_git_watch_without_watcher_is_noop() {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), Deps::default());
    s.start_git_watch(tokio_util::sync::CancellationToken::new());
}
