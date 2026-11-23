//! dirlock·claudecfg·backup·live·store·history·waker 시험.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use dm_gocompat::json::RawMessage;
use tokio_util::sync::CancellationToken;

use super::{MemSecrets, cred, cred_json, perm_is};
use crate::dirlock::{acquire_dir_lock, acquire_dir_lock_with, lock_claude};
use crate::error::{Error, Sentinel};
use crate::fsutil::chtimes;
use crate::history::append_history;
use crate::store::ACCOUNTS_FILE;
use crate::waker::Waker;
use crate::*;

// FR-CAC-30 ②: proper-lockfile 호환 디렉터리 락.
#[test]
fn dir_lock_exclusive_and_release() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path().join("x.lock");
    let l = acquire_dir_lock(&d, Duration::from_secs(60), Duration::from_secs(1)).unwrap();
    assert!(fs::metadata(&d).unwrap().is_dir());
    let e = acquire_dir_lock(&d, Duration::from_secs(60), Duration::from_millis(300)).unwrap_err();
    assert!(e.is(Sentinel::ClaudeLockTimeout));
    assert_eq!(
        e.to_string(),
        "Claude Code 가 자격증명을 갱신하는 중입니다. 잠시 뒤 다시 시도하세요"
    );
    drop(l);
    assert!(!d.exists());
}

#[test]
fn dir_lock_takes_over_stale() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path().join("x.lock");
    fs::create_dir(&d).unwrap();
    chtimes(&d, SystemTime::now() - Duration::from_secs(120)).unwrap();
    let l = acquire_dir_lock(&d, Duration::from_secs(60), Duration::from_secs(2)).unwrap();
    drop(l);
}

#[test]
fn dir_lock_does_not_steal_fresh() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path().join("x.lock");
    fs::create_dir(&d).unwrap();
    let e = acquire_dir_lock(&d, Duration::from_secs(60), Duration::from_millis(400)).unwrap_err();
    assert!(e.is(Sentinel::ClaudeLockTimeout));
}

#[test]
fn dir_lock_touches() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path().join("x.lock");
    let _l = acquire_dir_lock_with(
        &d,
        Duration::from_secs(60),
        Duration::from_secs(1),
        Duration::from_millis(50),
    )
    .unwrap();
    chtimes(&d, SystemTime::now() - Duration::from_secs(3600)).unwrap();
    let fresh = || {
        let m = fs::metadata(&d).unwrap().modified().unwrap();
        SystemTime::now().duration_since(m).unwrap_or_default() < Duration::from_secs(60)
    };
    for _ in 0..100 {
        if fresh() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("잡은 쪽이 mtime 을 갱신해야 한다");
}

#[test]
fn lock_claude_takes_three_and_releases() {
    let t = tempfile::tempdir().unwrap();
    let p = ClaudePaths::default_for(t.path());
    let l = lock_claude(&p, Duration::from_secs(1)).unwrap();
    let [a, b] = p.cred_lock_dirs();
    assert!(a.is_dir() && b.is_dir() && p.config_lock_dir().is_dir());
    drop(l);
    assert!(!a.exists() && !b.exists() && !p.config_lock_dir().exists());
}

const OAUTH_ACCT_A: &str = r#"{"emailAddress":"a@x.com","organizationUuid":"org-a","accountUuid":"acc-a","organizationName":"Org A","extra":1}"#;

#[test]
fn read_oauth_account_fields() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join(".claude.json");
    fs::write(
        &p,
        format!(r#"{{"theme":"dark","oauthAccount":{OAUTH_ACCT_A}}}"#),
    )
    .unwrap();
    let a = read_oauth_account(&p).unwrap().unwrap();
    assert_eq!(
        (
            a.email_address.as_str(),
            a.organization_uuid.as_str(),
            a.account_uuid.as_str(),
            a.organization_name.as_str()
        ),
        ("a@x.com", "org-a", "acc-a", "Org A")
    );
    assert_eq!(a.raw.0, OAUTH_ACCT_A.as_bytes());
}

#[test]
fn read_oauth_account_missing() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join(".claude.json");
    assert_eq!(read_oauth_account(&p).unwrap(), None);
    fs::write(&p, r#"{"theme":"dark"}"#).unwrap();
    assert_eq!(read_oauth_account(&p).unwrap(), None);
    fs::write(&p, r#"{"oauthAccount":null}"#).unwrap();
    assert_eq!(read_oauth_account(&p).unwrap(), None);
    fs::write(&p, "{bad").unwrap();
    assert_eq!(
        read_oauth_account(&p).unwrap_err().to_string(),
        "Claude 설정 파일을 읽을 수 없습니다"
    );
}

#[test]
fn splice_oauth_account_only_changes_that_key() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join(".claude.json");
    fs::write(
        &p,
        r#"{"theme":"dark","projects":{"/x":{"a":1}},"oauthAccount":{"emailAddress":"old@x.com"}}"#,
    )
    .unwrap();
    let prev = splice_oauth_account(&p, Some(&RawMessage(OAUTH_ACCT_A.into()))).unwrap();
    assert_eq!(prev.0, br#"{"emailAddress":"old@x.com"}"#);
    let b = fs::read_to_string(&p).unwrap();
    // Go json.MarshalIndent(map, "", "  ") 의 바이트.
    assert_eq!(
        b,
        "{\n  \"oauthAccount\": {\n    \"emailAddress\": \"a@x.com\",\n    \"organizationUuid\": \"org-a\",\n    \"accountUuid\": \"acc-a\",\n    \"organizationName\": \"Org A\",\n    \"extra\": 1\n  },\n  \"projects\": {\n    \"/x\": {\n      \"a\": 1\n    }\n  },\n  \"theme\": \"dark\"\n}"
    );
    assert!(perm_is(&p, 0o600));
    // 직전 값은 파일에 있던 원문(들여쓰기 그대로)이다.
    let prev = splice_oauth_account(&p, None).unwrap();
    assert!(
        String::from_utf8(prev.0)
            .unwrap()
            .starts_with("{\n    \"emailAddress\": \"a@x.com\",")
    );
    assert_eq!(read_oauth_account(&p).unwrap(), None);
}

#[test]
fn splice_oauth_account_corrupt_fails() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join(".claude.json");
    fs::write(&p, "{bad").unwrap();
    assert!(splice_oauth_account(&p, Some(&RawMessage(OAUTH_ACCT_A.into()))).is_err());
    assert_eq!(fs::read_to_string(&p).unwrap(), "{bad");
}

fn backup(dir: &Path, sec: &Arc<MemSecrets>) -> BackupStore {
    BackupStore {
        dir: dir.to_path_buf(),
        sec: sec.clone(),
    }
}

#[test]
fn backup_keychain_round_trip_and_prev() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let b = backup(t.path(), &sec);
    b.write("id1", &cred("a1", "r1", "")).unwrap();
    b.write("id1", &cred("a2", "r2", "")).unwrap();
    assert_eq!(b.read("id1").unwrap().unwrap().access_token(), "a2");
    assert_eq!(b.read_prev("id1").unwrap().unwrap().access_token(), "a1");
    assert!(sec.has("dongminal-claude-accounts", "account-id1"));
    assert!(sec.has("dongminal-claude-accounts", "account-id1.prev"));
    assert!(!t.path().join("credentials").join("id1.json").exists());
}

#[test]
fn backup_file_when_no_keychain() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    *sec.off.lock().unwrap() = true;
    let b = backup(t.path(), &sec);
    b.write("x", &cred("a", "r", "")).unwrap();
    let p = t.path().join("credentials").join("x.json");
    assert!(perm_is(&p, 0o600));
    assert!(perm_is(&t.path().join("credentials"), 0o700));
    assert_eq!(fs::read(&p).unwrap(), cred("a", "r", "").marshal().unwrap());
    assert_eq!(b.read("x").unwrap().unwrap().access_token(), "a");
}

#[test]
fn backup_keychain_failure_falls_back_to_file() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let b = backup(t.path(), &sec);
    sec.put(
        "dongminal-claude-accounts",
        "account-x",
        &cred_json("stale", "r", ""),
    );
    *sec.fail_set.lock().unwrap() = true;
    b.write("x", &cred("new", "r", "")).unwrap();
    assert!(!sec.has("dongminal-claude-accounts", "account-x"));
    assert_eq!(b.read("x").unwrap().unwrap().access_token(), "new");
}

#[test]
fn backup_delete() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let b = backup(t.path(), &sec);
    b.write("x", &cred("a", "r", "")).unwrap();
    b.write("x", &cred("a", "r", "")).unwrap();
    b.delete("x").unwrap();
    assert_eq!(b.read("x").unwrap(), None);
    assert_eq!(b.read_prev("x").unwrap(), None);
    assert_eq!(sec.len(), 0);
}

#[test]
fn backup_rejects_bad_id() {
    let t = tempfile::tempdir().unwrap();
    let b = backup(t.path(), &MemSecrets::new());
    for e in [
        b.write("../x", &cred("a", "r", "")).unwrap_err(),
        b.read("").unwrap_err(),
        b.delete("a/b").unwrap_err(),
    ] {
        assert!(e.is(Sentinel::InvalidId));
        assert_eq!(e.to_string(), "계정 ID 형식이 틀렸습니다");
    }
}

// TC-CAC-2: 활성 저장소 읽기 순서와 쓰기 규칙 (FR-CAC-5·6).
fn new_live(dir: &Path, sec: &Arc<MemSecrets>) -> LiveStore {
    LiveStore {
        paths: ClaudePaths::default_for(dir),
        sec: sec.clone(),
        retry_delay: Duration::from_millis(1),
    }
}

#[test]
fn live_read_keychain_first() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let l = new_live(t.path(), &sec);
    sec.put(
        &l.paths.keychain_service,
        "tester",
        &cred_json("kc", "r", ""),
    );
    fs::create_dir_all(&l.paths.config_home).unwrap();
    fs::write(&l.paths.credentials, cred_json("file", "r", "")).unwrap();
    assert_eq!(l.read().unwrap().unwrap().access_token(), "kc");
}

#[test]
fn live_read_falls_back_to_file() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let l = new_live(t.path(), &sec);
    fs::create_dir_all(&l.paths.config_home).unwrap();
    fs::write(&l.paths.credentials, cred_json("file", "r", "")).unwrap();
    assert_eq!(l.read().unwrap().unwrap().access_token(), "file");
    *sec.off.lock().unwrap() = true;
    assert_eq!(l.read().unwrap().unwrap().access_token(), "file");
}

#[test]
fn live_read_nothing() {
    let t = tempfile::tempdir().unwrap();
    assert_eq!(new_live(t.path(), &MemSecrets::new()).read().unwrap(), None);
}

#[test]
fn live_read_keychain_error_without_file() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    *sec.fail_get.lock().unwrap() = true;
    let e = new_live(t.path(), &sec).read().unwrap_err();
    assert!(e.is(Sentinel::KeychainUnavailable));
    assert_eq!(e.to_string(), "키체인을 읽을 수 없습니다: keychain broken");
}

#[test]
fn live_write_keychain_touches_existing_file() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let l = new_live(t.path(), &sec);
    fs::create_dir_all(&l.paths.config_home).unwrap();
    fs::write(&l.paths.credentials, cred_json("old", "r", "")).unwrap();
    l.write(&cred("new", "r2", "")).unwrap();
    let v = sec.get_raw(&l.paths.keychain_service);
    assert_eq!(
        Credential::parse(v.as_bytes()).unwrap().access_token(),
        "new"
    );
    assert_eq!(fs::read(&l.paths.credentials).unwrap(), v.as_bytes());
    assert!(perm_is(&l.paths.credentials, 0o600));
}

#[test]
fn live_write_keychain_does_not_create_file() {
    let t = tempfile::tempdir().unwrap();
    let l = new_live(t.path(), &MemSecrets::new());
    l.write(&cred("new", "r", "")).unwrap();
    assert!(!l.paths.credentials.exists());
}

#[test]
fn live_write_keychain_failure_falls_back_to_file() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    let l = new_live(t.path(), &sec);
    sec.put(
        &l.paths.keychain_service,
        "tester",
        &cred_json("stale", "r", ""),
    );
    *sec.fail_set.lock().unwrap() = true;
    l.write(&cred("new", "r", "")).unwrap();
    let f = Credential::parse(&fs::read(&l.paths.credentials).unwrap()).unwrap();
    assert_eq!(f.access_token(), "new");
    assert!(!sec.has(&l.paths.keychain_service, "tester"));
}

#[test]
fn live_write_no_keychain() {
    let t = tempfile::tempdir().unwrap();
    let sec = MemSecrets::new();
    *sec.off.lock().unwrap() = true;
    let l = new_live(t.path(), &sec);
    l.write(&cred("new", "r", "")).unwrap();
    assert!(l.paths.config_home.join(".credentials.json").exists());
    assert!(perm_is(&l.paths.config_home, 0o700));
}

#[test]
fn store_update_persists() {
    let t = tempfile::tempdir().unwrap();
    let dir = t.path().join("acc");
    let s = Store::open(&dir);
    s.update(|st| {
        st.accounts.push(Account {
            id: "a".into(),
            email: "a@x.com".into(),
            color: "acct-1".into(),
            ..Default::default()
        });
        st.active_id = "a".into();
        Ok(())
    })
    .unwrap();
    let st = Store::open(&dir).load().unwrap();
    assert!(st.active_id == "a" && st.accounts.len() == 1 && st.schema_version == 1);
    assert!(perm_is(&dir.join(ACCOUNTS_FILE), 0o600));
    assert!(perm_is(&dir, 0o700));
    // 관측 바이트: Go json.MarshalIndent(State).
    assert_eq!(
        fs::read_to_string(dir.join(ACCOUNTS_FILE)).unwrap(),
        "{\n  \"schemaVersion\": 1,\n  \"activeId\": \"a\",\n  \"accounts\": [\n    {\n      \"id\": \"a\",\n      \"email\": \"a@x.com\",\n      \"accountUuid\": \"\",\n      \"organizationUuid\": \"\",\n      \"organizationName\": \"\",\n      \"addedAt\": \"0001-01-01T00:00:00Z\",\n      \"color\": \"acct-1\",\n      \"disabled\": false,\n      \"priority\": 0\n    }\n  ]\n}"
    );
}

#[test]
fn store_update_error_keeps_file() {
    let t = tempfile::tempdir().unwrap();
    let s = Store::open(t.path());
    s.update(|st| {
        st.active_id = "keep".into();
        Ok(())
    })
    .unwrap();
    let e = s
        .update(|st| {
            st.active_id = "lost".into();
            Err(Error::new("boom"))
        })
        .unwrap_err();
    assert_eq!(e.to_string(), "boom");
    assert_eq!(s.load().unwrap().active_id, "keep");
}

#[test]
fn store_load_empty_and_corrupt() {
    let t = tempfile::tempdir().unwrap();
    let st = Store::open(t.path()).load().unwrap();
    assert!(st.accounts.is_empty() && st.schema_version == 1);
    fs::write(t.path().join(ACCOUNTS_FILE), "{bad").unwrap();
    let e = Store::open(t.path()).load().unwrap_err();
    assert!(e.to_string().starts_with("accounts.json: "), "{e}");
    fs::write(
        t.path().join(ACCOUNTS_FILE),
        r#"{"accounts":[{"priority":"x"}]}"#,
    )
    .unwrap();
    assert_eq!(
        Store::open(t.path()).load().unwrap_err().to_string(),
        "accounts.json: json: cannot unmarshal string into Go struct field State.accounts.0.priority of type int"
    );
}

#[test]
fn history_append_trim_and_read() {
    let t = tempfile::tempdir().unwrap();
    let h = |at| HistoryEntry {
        at,
        from: "a".into(),
        to: "b".into(),
        trigger: TRIGGER_MANUAL.into(),
        headroom_from: Some(12.5),
        headroom_to: None,
        by: BY_UI.into(),
    };
    append_history(t.path(), &h(1)).unwrap();
    let b = fs::read_to_string(t.path().join("history.jsonl")).unwrap();
    assert_eq!(
        b,
        "{\"at\":1,\"from\":\"a\",\"to\":\"b\",\"trigger\":\"manual\",\"headroomFrom\":12.5,\"headroomTo\":null,\"by\":\"ui\"}\n"
    );
    assert!(perm_is(&t.path().join("history.jsonl"), 0o600));
    fs::write(t.path().join("history.jsonl"), format!("{b}not json\n\n")).unwrap();
    assert_eq!(
        read_history(t.path(), 5).unwrap().len(),
        1,
        "읽지 못한 줄은 건너뛴다"
    );
    for i in 2..=1001 {
        append_history(t.path(), &h(i)).unwrap();
    }
    let all = read_history(t.path(), 5000).unwrap();
    assert_eq!(all.len(), 1000, "1000줄을 넘으면 오래된 것부터 지운다");
    assert_eq!((all[0].at, all[999].at), (1001, 2));
    assert_eq!(
        read_history(t.path(), 2)
            .unwrap()
            .iter()
            .map(|e| e.at)
            .collect::<Vec<_>>(),
        [1001, 1000]
    );
    assert!(read_history(&t.path().join("none"), 5).unwrap().is_empty());
}

// REFACTOR3_DEDUP_GO_SRS FR-RDG-62
#[tokio::test]
async fn waker_wake_retriggers_and_stop_returns() {
    let w = Arc::new(Waker::default());
    w.wake();
    let n = Arc::new(AtomicUsize::new(0));
    let stop = CancellationToken::new();
    let (w2, n2, s2) = (w.clone(), n.clone(), stop.clone());
    let h = tokio::spawn(async move {
        w2.run(s2, Duration::ZERO, |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            async { Duration::from_secs(3600) }
        })
        .await;
    });
    wait_count(&n, 1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(n.load(Ordering::SeqCst), 1, "기다리는 중");
    w.wake();
    wait_count(&n, 2).await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn waker_floor() {
    let n = Arc::new(AtomicUsize::new(0));
    let stop = CancellationToken::new();
    let w = Waker::default();
    let n2 = n.clone();
    let run = w.run(stop.clone(), Duration::from_secs(3600), move |_| {
        n2.fetch_add(1, Ordering::SeqCst);
        async { Duration::ZERO }
    });
    let _ = tokio::time::timeout(Duration::from_millis(100), run).await;
    assert_eq!(
        n.load(Ordering::SeqCst),
        1,
        "하한이 있으면 곧바로 다시 돌지 않는다"
    );

    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let s2 = stop.clone();
    let h = tokio::spawn(async move {
        Waker::default()
            .run(s2, Duration::ZERO, move |_| {
                n2.fetch_add(1, Ordering::SeqCst);
                async { Duration::ZERO }
            })
            .await;
    });
    wait_count(&n, 3).await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), h)
        .await
        .unwrap()
        .unwrap();
}

async fn wait_count(n: &AtomicUsize, want: usize) {
    for _ in 0..500 {
        if n.load(Ordering::SeqCst) >= want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("tick 이 {want} 번 오지 않았다");
}
