//! service_test·configdirs_test·unclaimed_test·mappings_test·profile_test (TC-CAC-5·6·7·8).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use serde_json::Value;
use tempfile::TempDir;

use super::{FakeProfile, MemSecrets, cred_json, perm_is};
use crate::error::Sentinel;
use crate::mappings::FOLD_CASE;
use crate::paths::profile_hash;
use crate::profile::SharedLinker;
use crate::*;

pub(crate) struct Env {
    _tmp: TempDir,
    pub(crate) data: PathBuf,
    pub(crate) sec: Arc<MemSecrets>,
    pub(crate) prof: Arc<FakeProfile>,
    pub(crate) svc: Service,
    pub(crate) paths: ClaudePaths,
}

pub(crate) fn new_env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let data = tmp.path().join("data").join("claude-accounts");
    let sec = MemSecrets::new();
    let prof = Arc::new(FakeProfile::default());
    let paths = ClaudePaths::default_for(&home);
    let n = Arc::new(AtomicUsize::new(0));
    let mut svc = Service::new(
        Store::open(&data),
        BackupStore {
            dir: data.clone(),
            sec: sec.clone(),
        },
        LiveStore {
            paths: paths.clone(),
            sec: sec.clone(),
            retry_delay: Duration::from_millis(1),
        },
        paths.clone(),
        &data,
        prof.clone(),
        Arc::new(|| time::OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap()),
        Arc::new(move || format!("id{}", n.fetch_add(1, Ordering::SeqCst) + 1)),
    );
    svc.lock_timeout = Duration::from_secs(1);
    Env {
        _tmp: tmp,
        data,
        sec,
        prof,
        svc,
        paths,
    }
}

impl Env {
    /// 사용자가 Claude Code 에서 그 계정으로 로그인한 상태를 만든다.
    pub(crate) fn login(&self, email: &str, org: &str, acc: &str, access: &str, refresh: &str) {
        self.sec.put(
            &self.paths.keychain_service,
            "tester",
            &cred_json(access, refresh, ""),
        );
        let cfg = format!(
            r#"{{"theme":"dark","oauthAccount":{{"emailAddress":"{email}","organizationUuid":"{org}","accountUuid":"{acc}","organizationName":"{org}-name"}}}}"#
        );
        fs::write(&self.paths.global_config, cfg).unwrap();
        self.prof.by_token.lock().unwrap().insert(
            access.into(),
            Identity {
                account_uuid: acc.into(),
                email: email.into(),
                org_uuid: org.into(),
            },
        );
    }

    pub(crate) fn live(&self) -> Credential {
        self.svc.live.read().unwrap().unwrap()
    }

    fn live_email(&self) -> String {
        read_oauth_account(&self.paths.global_config)
            .unwrap()
            .unwrap()
            .email_address
    }

    fn set_live(&self, access: &str, refresh: &str, extra: &str) {
        self.sec.put(
            &self.paths.keychain_service,
            "tester",
            &cred_json(access, refresh, extra),
        );
    }
}

pub(crate) async fn two_accounts() -> Env {
    let e = new_env();
    e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a");
    e.svc.add_current().await.unwrap();
    e.login("b@x.com", "org-b", "acc-b", "at-b", "rt-b");
    e.svc.add_current().await.unwrap();
    e
}

fn backup_at(e: &Env, id: &str) -> String {
    e.svc
        .backup
        .read(id)
        .unwrap()
        .map(|c| c.access_token())
        .unwrap_or_default()
}

#[tokio::test]
async fn add_current_new() {
    let e = new_env();
    e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a");
    let (a, created) = e.svc.add_current().await.unwrap();
    assert!(created);
    assert_eq!(
        (
            a.id.as_str(),
            a.email.as_str(),
            a.org_uuid.as_str(),
            a.account_uuid.as_str(),
            a.org_name.as_str(),
            a.color.as_str()
        ),
        ("id1", "a@x.com", "org-a", "acc-a", "org-a-name", "acct-1")
    );
    assert_eq!(e.svc.store.load().unwrap().active_id, "id1");
    assert_eq!(backup_at(&e, "id1"), "at-a");
    let raw = fs::read(e.data.join("configs").join("id1.json")).unwrap();
    assert_eq!(raw, br#"{"emailAddress":"a@x.com","organizationUuid":"org-a","accountUuid":"acc-a","organizationName":"org-a-name"}"#);
    assert!(perm_is(&e.data.join("configs").join("id1.json"), 0o600));
    let s = fs::read_to_string(e.data.join("accounts.json")).unwrap();
    assert!(s.contains(r#""addedAt": "2023-11-14T22:13:20Z""#), "{s}");
}

#[tokio::test]
async fn add_current_existing_refreshes() {
    let e = new_env();
    e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a");
    e.svc.add_current().await.unwrap();
    e.login("a@x.com", "org-a", "acc-a", "at-a2", "rt-a2");
    let (a, created) = e.svc.add_current().await.unwrap();
    assert!(!created && a.id == "id1");
    assert_eq!(e.svc.store.load().unwrap().accounts.len(), 1);
    assert_eq!(backup_at(&e, "id1"), "at-a2");
}

#[tokio::test]
async fn add_current_same_email_other_org_is_new() {
    let e = new_env();
    e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a");
    e.svc.add_current().await.unwrap();
    e.login("a@x.com", "org-b", "acc-a", "at-b", "rt-b");
    assert!(
        e.svc.add_current().await.unwrap().1,
        "identity is (email, org)"
    );
}

#[tokio::test]
async fn add_current_rejects() {
    let e = new_env();
    let err = e.svc.add_current().await.unwrap_err();
    assert!(err.is(Sentinel::NotLoggedIn));
    assert_eq!(
        err.to_string(),
        "Claude Code 에 로그인한 계정이 없습니다. 먼저 Claude Code 에서 /login 으로 로그인하세요"
    );
    fs::write(
        &e.paths.global_config,
        r#"{"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"o"}}"#,
    )
    .unwrap();
    let err = e.svc.add_current().await.unwrap_err();
    assert!(err.is(Sentinel::LiveEmpty));
    assert_eq!(
        err.to_string(),
        "활성 자격증명이 없습니다. Claude Code 에서 다시 로그인하세요"
    );
    fs::write(
        &e.paths.global_config,
        r#"{"oauthAccount":{"organizationUuid":"o"}}"#,
    )
    .unwrap();
    assert!(
        e.svc
            .add_current()
            .await
            .unwrap_err()
            .is(Sentinel::NotLoggedIn)
    );
}

#[tokio::test]
async fn switch_happy_path() {
    let e = two_accounts().await;
    e.prof.calls.store(0, Ordering::SeqCst);
    let res = e.svc.switch("id1").await.unwrap();
    assert_eq!(
        (res.from.as_str(), res.to.as_str(), res.outgoing.as_str()),
        ("id2", "id1", OUTGOING_SAME)
    );
    assert_eq!(e.live().access_token(), "at-a");
    assert_eq!(e.live_email(), "a@x.com");
    let m: Value = serde_json::from_slice(&fs::read(&e.paths.global_config).unwrap()).unwrap();
    assert_eq!(m["theme"], "dark");
    assert_eq!(e.svc.store.load().unwrap().active_id, "id1");
    assert_eq!(
        e.prof.calls.load(Ordering::SeqCst),
        0,
        "same bytes needs no profile lookup"
    );
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&res).unwrap()).unwrap(),
        r#"{"from":"id2","to":"id1","outgoing":"same"}"#
    );
}

#[tokio::test]
async fn switch_rotated_outgoing_is_backed_up() {
    let e = two_accounts().await;
    e.set_live("at-b2", "rt-b2", "");
    e.prof.by_token.lock().unwrap().insert(
        "at-b2".into(),
        Identity {
            account_uuid: "acc-b".into(),
            email: "b@x.com".into(),
            org_uuid: "org-b".into(),
        },
    );
    assert_eq!(
        e.svc.switch("id1").await.unwrap().outgoing,
        OUTGOING_ROTATED
    );
    assert_eq!(backup_at(&e, "id2"), "at-b2");
}

#[tokio::test]
async fn switch_foreign_outgoing_is_stashed() {
    let e = two_accounts().await;
    e.set_live("at-z", "rt-z", "");
    e.prof.by_token.lock().unwrap().insert(
        "at-z".into(),
        Identity {
            account_uuid: "acc-z".into(),
            email: "z@x.com".into(),
            org_uuid: "org-z".into(),
        },
    );
    assert_eq!(
        e.svc.switch("id1").await.unwrap().outgoing,
        OUTGOING_FOREIGN
    );
    assert_eq!(backup_at(&e, "id2"), "at-b");
    let ents: Vec<_> = fs::read_dir(e.data.join("unclaimed"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(ents.len(), 1);
    let fp = cred_json("at-z", "rt-z", "");
    let fp = Credential::parse(fp.as_bytes()).unwrap().fingerprint();
    assert_eq!(
        ents[0].file_name().to_string_lossy(),
        format!("1700000000-{fp}.json")
    );
    assert!(perm_is(&ents[0].path(), 0o600));
}

#[tokio::test]
async fn switch_unresolved_outgoing_is_stashed() {
    let e = two_accounts().await;
    e.set_live("at-q", "rt-q", "");
    *e.prof.err.lock().unwrap() = Some("network".into());
    assert_eq!(
        e.svc.switch("id1").await.unwrap().outgoing,
        OUTGOING_UNRESOLVED
    );
    assert_eq!(backup_at(&e, "id2"), "at-b");
    assert_eq!(e.svc.unclaimed().unwrap().len(), 1);
}

#[tokio::test]
async fn switch_empty_live_does_not_touch_backup() {
    let e = two_accounts().await;
    use dm_shared_platform::Secrets;
    e.sec.delete(&e.paths.keychain_service, "tester").unwrap();
    assert_eq!(e.svc.switch("id1").await.unwrap().outgoing, OUTGOING_EMPTY);
    assert_eq!(backup_at(&e, "id2"), "at-b");
    assert_eq!(e.live().access_token(), "at-a");
}

#[tokio::test]
async fn switch_known_other_account_token_needs_no_backup() {
    let e = two_accounts().await;
    e.set_live("at-a", "rt-a", "");
    assert_eq!(e.svc.switch("id1").await.unwrap().outgoing, OUTGOING_KNOWN);
}

#[tokio::test]
async fn switch_empty_target_backup_aborts() {
    let e = two_accounts().await;
    e.svc.backup.delete("id1").unwrap();
    let err = e.svc.switch("id1").await.unwrap_err();
    assert!(err.is(Sentinel::EmptyBackup));
    assert_eq!(
        err.to_string(),
        "이 계정의 백업이 비었습니다. 그 계정으로 로그인한 뒤 다시 추가하세요"
    );
    assert_eq!(
        (e.live().access_token(), e.live_email()),
        ("at-b".into(), "b@x.com".into())
    );
}

#[tokio::test]
async fn switch_rolls_back_on_config_failure() {
    let e = two_accounts().await;
    fs::write(&e.paths.global_config, "{bad").unwrap();
    assert!(e.svc.switch("id1").await.is_err());
    assert_eq!(e.live().access_token(), "at-b");
    assert_eq!(e.svc.store.load().unwrap().active_id, "id2");
}

#[tokio::test]
async fn switch_merges_shared_fields() {
    let e = two_accounts().await;
    e.set_live("at-b", "rt-b", r#""mcpOAuth":{"m":1}"#);
    e.svc.switch("id1").await.unwrap();
    let m: Value = serde_json::from_slice(&e.live().marshal().unwrap()).unwrap();
    assert_eq!(m["mcpOAuth"], serde_json::json!({"m":1}));
}

#[tokio::test]
async fn switch_unknown_and_active() {
    let e = two_accounts().await;
    assert!(
        e.svc
            .switch("nope")
            .await
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
    let res = e.svc.switch("id2").await.unwrap();
    assert!(res.no_op);
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&res).unwrap()).unwrap(),
        r#"{"from":"id2","to":"id2","noop":true}"#
    );
}

#[tokio::test]
async fn switch_honours_claude_locks() {
    let mut e = two_accounts().await;
    e.svc.lock_timeout = Duration::from_millis(300);
    let [lock, _] = e.paths.cred_lock_dirs();
    fs::create_dir_all(&lock).unwrap();
    assert!(
        e.svc
            .switch("id1")
            .await
            .unwrap_err()
            .is(Sentinel::ClaudeLockTimeout)
    );
    assert_eq!(e.live().access_token(), "at-b");
    fs::remove_dir(&lock).unwrap();
}

// LiveChanged 는 락 안의 재확인에서만 나는 경쟁이라 직접 만들 수 없다. 문구만 본다.
#[test]
fn sentinel_texts() {
    assert_eq!(
        crate::Error::from(Sentinel::LiveChanged).to_string(),
        "전환 도중 활성 자격증명이 바뀌었습니다. 다시 시도하세요"
    );
    assert_eq!(
        crate::Error::from(Sentinel::NoCandidate).to_string(),
        "전환할 계정이 없습니다"
    );
}

#[tokio::test]
async fn switch_next_skips_disabled() {
    let e = two_accounts().await;
    e.login("c@x.com", "org-c", "acc-c", "at-c", "rt-c");
    e.svc.add_current().await.unwrap();
    e.svc
        .update(
            "id1",
            &Patch {
                disabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    let st = e.svc.store.load().unwrap();
    assert_eq!(st.next_after(|_| true).as_deref(), Some("id2"));
    assert_eq!(st.next_after(|a| a.id != "id2"), None);
}

#[tokio::test]
async fn remove_account() {
    let e = two_accounts().await;
    e.svc.remove("id1").await.unwrap();
    let st = e.svc.store.load().unwrap();
    assert!(st.accounts.len() == 1 && st.accounts[0].id == "id2");
    assert_eq!(e.svc.backup.read("id1").unwrap(), None);
    assert!(!e.data.join("configs").join("id1.json").exists());
    e.svc.remove("id2").await.unwrap();
    assert_eq!(e.live().access_token(), "at-b", "live untouched");
    assert_eq!(e.svc.store.load().unwrap().active_id, "");
    assert!(
        e.svc
            .remove("id9")
            .await
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
}

#[tokio::test]
async fn update_and_reorder() {
    let e = two_accounts().await;
    let a = e
        .svc
        .update(
            "id1",
            &Patch {
                alias: Some("work".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(a.alias, "work");
    let a = e
        .svc
        .update(
            "id1",
            &Patch {
                alias: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(a.alias, "");
    let a = e
        .svc
        .update(
            "id1",
            &Patch {
                threshold: Some(80.0),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(a.threshold, Some(80.0));
    let a = e
        .svc
        .update(
            "id1",
            &Patch {
                threshold: Some(-1.0),
                clear_threshold: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(a.threshold, None);
    assert!(
        e.svc
            .update("nope", &Patch::default())
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
    e.svc.reorder(&["id2".into(), "id1".into()]).unwrap();
    assert_eq!(e.svc.store.load().unwrap().accounts[0].id, "id2");
    for bad in [
        vec!["id2".to_owned()],
        vec!["id2".into(), "id2".into()],
        vec!["id2".into(), "x".into()],
    ] {
        let err = e.svc.reorder(&bad).unwrap_err();
        assert_eq!(
            err.to_string(),
            "값이 범위를 벗어났습니다: 모든 계정을 한 번씩 담아야 합니다"
        );
    }
}

#[tokio::test]
async fn sync_active_from_live() {
    let e = two_accounts().await;
    assert!(!e.svc.sync_active_from_live().unwrap(), "already active");
    e.login("a@x.com", "org-a", "acc-a", "at-a", "rt-a");
    assert!(e.svc.sync_active_from_live().unwrap());
    assert_eq!(e.svc.store.load().unwrap().active_id, "id1");
    e.login("z@x.com", "org-z", "acc-z", "at-z", "rt-z");
    assert!(!e.svc.sync_active_from_live().unwrap(), "unregistered");
}

#[test]
fn config_dirs() {
    let t = tempfile::tempdir().unwrap();
    let mut e = new_env();
    e.svc.dir = t.path().to_path_buf();
    e.svc.claude.config_home = PathBuf::from("/home/u/.claude");
    assert_eq!(e.svc.config_dirs(), [PathBuf::from("/home/u/.claude")]);
    for id in ["b", "a"] {
        fs::create_dir_all(e.svc.profile_dir(id)).unwrap();
    }
    fs::write(t.path().join("profiles").join("x.txt"), "x").unwrap();
    assert_eq!(
        e.svc.config_dirs(),
        [
            PathBuf::from("/home/u/.claude"),
            e.svc.profile_dir("a"),
            e.svc.profile_dir("b")
        ]
    );
}

#[tokio::test]
async fn unclaimed_list_and_remove() {
    let e = two_accounts().await;
    assert!(e.svc.unclaimed().unwrap().is_empty());
    let dir = e.data.join("unclaimed");
    fs::create_dir_all(&dir).unwrap();
    for n in [
        "100-aaaaaaaaaaaa.json",
        "300-bbbbbbbbbbbb.json",
        "200-cccccccccccc.json",
        "junk.txt",
        "1-XYZ.json",
    ] {
        fs::write(
            dir.join(n),
            r#"{"claudeAiOauth":{"accessToken":"sk-secret"}}"#,
        )
        .unwrap();
    }
    let got = e.svc.unclaimed().unwrap();
    let ent = |n: &str, at, f: &str| UnclaimedEntry {
        name: n.into(),
        at,
        fingerprint: f.into(),
    };
    assert_eq!(
        got,
        [
            ent("300-bbbbbbbbbbbb.json", 300, "bbbbbbbbbbbb"),
            ent("200-cccccccccccc.json", 200, "cccccccccccc"),
            ent("100-aaaaaaaaaaaa.json", 100, "aaaaaaaaaaaa"),
        ]
    );
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&got[0]).unwrap()).unwrap(),
        r#"{"name":"300-bbbbbbbbbbbb.json","at":300,"fingerprint":"bbbbbbbbbbbb"}"#
    );
    e.svc.remove_unclaimed("200-cccccccccccc.json").unwrap();
    assert!(!dir.join("200-cccccccccccc.json").exists());
    e.svc.remove_unclaimed("200-cccccccccccc.json").unwrap();
    for bad in [
        "",
        "junk.txt",
        "../accounts.json",
        "1-XYZ.json",
        "100-aaaaaaaaaaaa.json/..",
        "100-aaaaaaaaaaa.json",
    ] {
        let err = e.svc.remove_unclaimed(bad).unwrap_err();
        assert!(err.is(Sentinel::Invalid), "{bad}");
        assert_eq!(
            err.to_string(),
            "값이 범위를 벗어났습니다: 보관 이름 형식이 아닙니다"
        );
    }
}

#[tokio::test]
async fn profile_warnings_record_and_clear() {
    let mut e = two_accounts().await;
    let fail = Arc::new(Mutex::new(true));
    let f2 = fail.clone();
    e.svc.link_shared = Some(Arc::new(move |_: &Path, _: &Path| {
        if *f2.lock().unwrap() {
            vec!["skills".into(), "settings.json".into()]
        } else {
            vec![]
        }
    }));
    let (_, warn) = e.svc.prepare_profile("id1").unwrap();
    assert_eq!(warn.len(), 2);
    assert_eq!(e.svc.profile_warnings("id1"), ["skills", "settings.json"]);
    assert!(e.svc.profile_warnings("id2").is_empty());
    *fail.lock().unwrap() = false;
    e.svc.prepare_profile("id1").unwrap();
    assert!(e.svc.profile_warnings("id1").is_empty());
}

#[tokio::test]
async fn remove_drops_profile_warnings() {
    let mut e = two_accounts().await;
    e.svc.link_shared = Some(Arc::new(|_: &Path, _: &Path| vec!["skills".to_owned()]));
    e.svc.prepare_profile("id1").unwrap();
    e.svc.remove("id1").await.unwrap();
    assert!(e.svc.profile_warnings("id1").is_empty());
}

// --- mappings_test ---

#[test]
fn normalize_folder_cases() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().to_string_lossy().into_owned();
    let real = format!("{root}/real");
    fs::create_dir_all(format!("{real}/sub")).unwrap();
    let link = format!("{root}/link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).unwrap();
    #[cfg(not(unix))]
    return;
    let want = fs::canonicalize(&real)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for inp in [
        real.clone(),
        format!("{real}/"),
        link.clone(),
        format!("{link}/sub/.."),
    ] {
        assert_eq!(normalize_folder(&inp, false).unwrap(), want, "{inp}");
    }
    assert_eq!(
        normalize_folder(&format!("{link}/nope/x/"), false).unwrap(),
        format!("{want}/nope/x")
    );
    for bad in ["rel/dir", ""] {
        let err = normalize_folder(bad, false).unwrap_err();
        assert!(err.is(Sentinel::Invalid));
        assert_eq!(
            err.to_string(),
            "값이 범위를 벗어났습니다: 절대 경로가 필요합니다"
        );
    }
    let lower = normalize_folder(&root, true).unwrap();
    assert_eq!(
        normalize_folder(&format!("{root}/nope/ABC"), true).unwrap(),
        format!("{lower}/nope/abc")
    );
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tokio::test]
async fn resolve_order() {
    let e = two_accounts().await;
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let repo = root.join("repo");
    let deep = repo.join("pkg").join("x");
    fs::create_dir_all(&deep).unwrap();
    let r = e.svc.resolve("t1", &s(&deep)).unwrap();
    assert!(r.source == SOURCE_NONE && r.account_id.is_empty() && r.config_dir.is_empty());
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&r).unwrap()).unwrap(),
        format!(
            r#"{{"source":"none","path":{}}}"#,
            dm_gocompat::strconv::quote(&r.path)
        )
    );
    e.svc.set_folder(&s(root), "id1").unwrap();
    e.svc.set_folder(&s(&repo), "id2").unwrap();
    let r = e.svc.resolve("", &s(&deep)).unwrap();
    assert!(
        r.source == SOURCE_FOLDER
            && r.account_id == "id2"
            && r.config_dir == s(&e.svc.profile_dir("id2"))
    );
    assert_eq!(r.folder, normalize_folder(&s(&repo), FOLD_CASE).unwrap());
    assert_eq!(
        e.svc
            .resolve("", &s(&root.join("repo-other")))
            .unwrap()
            .account_id,
        "id1"
    );
    e.svc.set_tab("t1", "id1").unwrap();
    let r = e.svc.resolve("t1", &s(&deep)).unwrap();
    assert!(r.source == SOURCE_TAB && r.account_id == "id1");
    assert_eq!(e.svc.resolve("t2", &s(&deep)).unwrap().account_id, "id2");
    assert!(
        e.svc
            .resolve("t1", "relative")
            .unwrap_err()
            .is(Sentinel::Invalid)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn resolve_carries_normalized_path() {
    let e = two_accounts().await;
    let t = tempfile::tempdir().unwrap();
    let real = t.path().join("real");
    fs::create_dir_all(&real).unwrap();
    let link = t.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let want = normalize_folder(&s(&real), FOLD_CASE).unwrap();
    let r = e.svc.resolve("", &format!("{}/", s(&link))).unwrap();
    assert!(r.path == want && r.source == SOURCE_NONE);
    e.svc.set_folder(&s(&real), "id1").unwrap();
    e.svc.set_tab("t1", "id2").unwrap();
    let r = e.svc.resolve("", &s(&link)).unwrap();
    assert!(r.path == want && r.folder == want);
    let r = e.svc.resolve("t1", &s(&link)).unwrap();
    assert!(r.path == want && r.source == SOURCE_TAB);
}

#[tokio::test]
async fn resolve_ignores_deleted_account() {
    let e = two_accounts().await;
    let t = tempfile::tempdir().unwrap();
    let repo = t.path().join("repo");
    e.svc.set_folder(&s(t.path()), "id1").unwrap();
    e.svc.set_folder(&s(&repo), "id2").unwrap();
    e.svc.set_tab("t1", "id2").unwrap();
    e.svc
        .store
        .update(|st| {
            st.accounts.truncate(1);
            Ok(())
        })
        .unwrap();
    let r = e.svc.resolve("t1", &s(&repo)).unwrap();
    assert!(r.source == SOURCE_FOLDER && r.account_id == "id1");
}

#[tokio::test]
async fn set_mapping_validation() {
    let e = two_accounts().await;
    let t = tempfile::tempdir().unwrap();
    let dir = s(t.path());
    assert!(
        e.svc
            .set_folder(&dir, "nope")
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
    assert!(
        e.svc
            .set_folder("rel", "id1")
            .unwrap_err()
            .is(Sentinel::Invalid)
    );
    let err = e.svc.set_tab("", "id1").unwrap_err();
    assert_eq!(
        err.to_string(),
        "값이 범위를 벗어났습니다: toolId 가 필요합니다"
    );
    e.svc.set_folder(&dir, "id1").unwrap();
    e.svc.set_tab("t1", "id1").unwrap();
    let key = normalize_folder(&dir, FOLD_CASE).unwrap();
    assert_eq!(
        fs::read_to_string(e.data.join("mappings.json")).unwrap(),
        format!(
            "{{\n  \"folders\": {{\n    {}: {{\n      \"accountId\": \"id1\"\n    }}\n  }},\n  \"tabs\": {{\n    \"t1\": {{\n      \"accountId\": \"id1\"\n    }}\n  }}\n}}",
            dm_gocompat::strconv::quote(&key)
        )
    );
    e.svc.set_folder(&format!("{dir}/"), "").unwrap();
    e.svc.set_tab("t1", "").unwrap();
    let m = e.svc.mappings().unwrap();
    assert!(m.folders.is_empty() && m.tabs.is_empty());
    assert!(perm_is(&e.data.join("mappings.json"), 0o600));
    fs::write(e.data.join("mappings.json"), "{bad").unwrap();
    assert_eq!(
        e.svc.mappings().unwrap(),
        Mappings::default(),
        "읽을 수 없는 파일은 빈 것"
    );
}

#[tokio::test]
async fn prune_tabs() {
    let e = two_accounts().await;
    for id in ["t1", "t2"] {
        e.svc.set_tab(id, "id1").unwrap();
    }
    assert!(e.svc.prune_tabs(|id| id == "t1").unwrap());
    let m = e.svc.mappings().unwrap();
    assert!(m.tabs.contains_key("t1") && m.tabs.len() == 1);
    assert!(!e.svc.prune_tabs(|_| true).unwrap());
}

#[tokio::test]
async fn remove_drops_mappings_and_profile() {
    let e = two_accounts().await;
    let t = tempfile::tempdir().unwrap();
    e.svc.set_folder(&s(t.path()), "id1").unwrap();
    e.svc.set_tab("t1", "id1").unwrap();
    e.svc.set_tab("t2", "id2").unwrap();
    e.svc.prepare_profile("id1").unwrap();
    let pdir = e.svc.profile_dir("id1");
    let svc = ClaudePaths::profile(&pdir).keychain_service;
    assert!(e.sec.has(&svc, "tester"));
    e.svc.remove("id1").await.unwrap();
    let m = e.svc.mappings().unwrap();
    assert!(m.folders.is_empty() && m.tabs.len() == 1 && m.tabs["t2"].account_id == "id2");
    assert!(!pdir.exists());
    assert!(!e.sec.has(&svc, "tester"));
}

// --- profile_test ---

fn json_map(p: &Path) -> serde_json::Map<String, Value> {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}

#[tokio::test]
async fn prepare_profile_credentials() {
    let e = two_accounts().await;
    let (dir, _) = e.svc.prepare_profile("id1").unwrap();
    assert_eq!(dir, e.data.join("profiles").join("id1"));
    assert!(perm_is(&dir, 0o700));
    let pl = e.svc.profile_live("id1");
    assert_eq!(pl.read().unwrap().unwrap().access_token(), "at-a");
    assert_eq!(
        pl.paths.keychain_service,
        format!("Claude Code-credentials-{}", profile_hash(&s(&dir)))
    );
    let newer = Credential::parse(br#"{"claudeAiOauth":{"accessToken":"at-a2","refreshToken":"rt-a2","expiresAt":1900000000000}}"#).unwrap();
    pl.write(&newer).unwrap();
    e.svc.prepare_profile("id1").unwrap();
    assert_eq!(
        pl.read().unwrap().unwrap().access_token(),
        "at-a2",
        "newer profile kept"
    );
    assert_eq!(backup_at(&e, "id1"), "at-a2", "reclaimed on prepare");
    let older = Credential::parse(
        br#"{"claudeAiOauth":{"accessToken":"old","refreshToken":"old","expiresAt":1}}"#,
    )
    .unwrap();
    pl.write(&older).unwrap();
    e.svc.prepare_profile("id1").unwrap();
    assert_eq!(
        pl.read().unwrap().unwrap().access_token(),
        "at-a2",
        "stale profile replaced"
    );
    assert!(
        e.svc
            .prepare_profile("nope")
            .unwrap_err()
            .is(Sentinel::NotFound)
    );
}

#[tokio::test]
async fn prepare_profile_claude_json() {
    let e = two_accounts().await;
    let def = r#"{"theme":"dark","mcpServers":{"m":{"command":"x"}},"projects":{"/p":{"hasTrustDialogAccepted":true}},"oauthAccount":{"emailAddress":"b@x.com"},"userID":"u-default","s1Cache":{"a":1},"cachedGrowthBookFeatures":{},"claudeCodeFirstTokenDate":"d","passesLastSeenRemaining":3,"penguinModeOrgEnabled":true,"managedSettingsNoticeSeenOrg":"o"}"#;
    fs::write(&e.paths.global_config, def).unwrap();
    let dir = e.svc.profile_dir("id1");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(".claude.json"),
        r#"{"userID":"u-profile","s1Cache":{"p":1},"theme":"light","localOnly":1}"#,
    )
    .unwrap();
    e.svc.prepare_profile("id1").unwrap();
    let raw = fs::read_to_string(dir.join(".claude.json")).unwrap();
    // 관측 바이트: Go json.Marshal(map) — 키 정렬, compact.
    assert_eq!(
        raw,
        r#"{"hasCompletedOnboarding":true,"localOnly":1,"mcpServers":{"m":{"command":"x"}},"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"org-a","accountUuid":"acc-a","organizationName":"org-a-name"},"projects":{"/p":{"hasTrustDialogAccepted":true}},"s1Cache":{"p":1},"theme":"dark","userID":"u-profile"}"#
    );
    assert!(perm_is(&dir.join(".claude.json"), 0o600));
    fs::write(&e.paths.global_config, "{broken").unwrap();
    e.svc.prepare_profile("id1").unwrap();
    let m = json_map(&dir.join(".claude.json"));
    assert!(m["theme"] == "dark" && m["localOnly"] == 1);
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_profile_links_shared_items() {
    let e = two_accounts().await;
    let ch = &e.paths.config_home;
    fs::create_dir_all(ch.join("skills")).unwrap();
    fs::write(ch.join("settings.json"), "{}").unwrap();
    let dir = e.svc.profile_dir("id1");
    fs::create_dir_all(&dir).unwrap();
    let other = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(other.path(), dir.join("skills")).unwrap();
    let (_, warn) = e.svc.prepare_profile("id1").unwrap();
    assert!(warn.is_empty(), "{warn:?}");
    for name in ["skills", "settings.json"] {
        assert_eq!(fs::read_link(dir.join(name)).unwrap(), ch.join(name));
    }
    assert!(fs::symlink_metadata(dir.join("commands")).is_err());
}

#[test]
fn link_shared_fallback() {
    let (src, dst) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    fs::write(src.path().join("settings.json"), r#"{"a":1}"#).unwrap();
    fs::create_dir_all(src.path().join("skills")).unwrap();
    let junctions = Arc::new(AtomicUsize::new(0));
    let j2 = junctions.clone();
    let deny = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    let l = SharedLinker {
        symlink: Box::new(move |_, _| Err(deny())),
        junction: Box::new(move |_, _| {
            j2.fetch_add(1, Ordering::SeqCst);
            Err(deny())
        }),
    };
    let warn = l.link(src.path(), dst.path());
    assert_eq!(
        fs::read_to_string(dst.path().join("settings.json")).unwrap(),
        r#"{"a":1}"#
    );
    assert_eq!(
        (junctions.load(Ordering::SeqCst), warn),
        (1, vec!["skills".to_owned()])
    );
    fs::write(src.path().join("settings.json"), r#"{"a":2}"#).unwrap();
    l.link(src.path(), dst.path());
    assert_eq!(
        fs::read_to_string(dst.path().join("settings.json")).unwrap(),
        r#"{"a":2}"#
    );
}

pub(crate) fn write_session(dir: &Path, pid: i32) {
    let sd = dir.join("sessions");
    fs::create_dir_all(&sd).unwrap();
    fs::write(
        sd.join(format!("{pid}.json")),
        format!(r#"{{"pid":{pid},"sessionId":"s"}}"#),
    )
    .unwrap();
}

#[tokio::test]
async fn pinned_running() {
    let mut e = two_accounts().await;
    e.svc.alive = Some(Arc::new(|pid| pid == 42));
    assert!(!e.svc.pinned_running("id1"));
    let dir = e.svc.profile_dir("id1");
    write_session(&dir, 7);
    assert!(!e.svc.pinned_running("id1"));
    write_session(&dir, 42);
    assert!(e.svc.pinned_running("id1"));
    fs::write(dir.join("sessions").join("bad.json"), "{").unwrap();
    assert!(e.svc.pinned_running("id1"));
}

#[tokio::test]
async fn reclaim_profile_token() {
    let e = two_accounts().await;
    e.svc.prepare_profile("id1").unwrap();
    let pl = e.svc.profile_live("id1");
    pl.write(&Credential::parse(br#"{"claudeAiOauth":{"accessToken":"at-a2","refreshToken":"rt-a2","expiresAt":1900000000000}}"#).unwrap()).unwrap();
    let st = e.svc.store.load().unwrap();
    let acc = st.accounts[st.find("id1").unwrap()].clone();
    e.svc.reclaim_profile(&acc);
    assert_eq!(backup_at(&e, "id1"), "at-a2");
    pl.write(&Credential::parse(br#"{"claudeAiOauth":{"accessToken":"at-x","refreshToken":"rt-x","expiresAt":1950000000000}}"#).unwrap()).unwrap();
    let cfg = e.svc.profile_dir("id1").join(".claude.json");
    splice_oauth_account(
        &cfg,
        Some(&RawMessage(
            br#"{"emailAddress":"x@x.com","organizationUuid":"org-x"}"#.to_vec(),
        )),
    )
    .unwrap();
    e.svc.reclaim_profile(&acc);
    assert_eq!(
        backup_at(&e, "id1"),
        "at-a2",
        "foreign profile not reclaimed"
    );
}

#[tokio::test]
async fn switch_reports_pinned_running() {
    let mut e = two_accounts().await;
    e.svc.alive = Some(Arc::new(|pid| pid == 42));
    e.svc.prepare_profile("id2").unwrap();
    write_session(&e.svc.profile_dir("id2"), 42);
    e.svc.profile_live("id2").write(&Credential::parse(br#"{"claudeAiOauth":{"accessToken":"at-b2","refreshToken":"rt-b2","expiresAt":1900000000000}}"#).unwrap()).unwrap();
    let res = e.svc.switch("id1").await.unwrap();
    assert!(res.pinned_running && res.to == "id1");
    assert_eq!(backup_at(&e, "id2"), "at-b2", "reclaimed before switch");
    assert!(!e.svc.switch("id2").await.unwrap().pinned_running);
}
