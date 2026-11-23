//! FR-RDF-2: 락 대기·키체인 호출이 tokio 작업 스레드를 막지 않는다.

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use dm_shared_platform::{Secrets, SecretsError};

use crate::dirlock::lock_claude;
use crate::*;

const BLOCK: Duration = Duration::from_millis(1200);
const SETTLE: Duration = Duration::from_millis(200);
const FAST: Duration = Duration::from_millis(400);

/// 작업 스레드 1개짜리 런타임에서 slow 가 도는 동안 다른 task 가 FAST 안에 끝나는지 본다.
async fn assert_not_stalled<T: Send + 'static>(slow: impl Future<Output = T> + Send + 'static) {
    let h = tokio::spawn(slow);
    thread::sleep(SETTLE);
    let t0 = Instant::now();
    tokio::spawn(async {}).await.unwrap();
    let took = t0.elapsed();
    h.await.unwrap();
    assert!(took < FAST, "other task waited {took:?}");
}

fn paths() -> (tempfile::TempDir, ClaudePaths) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    let p = ClaudePaths::default_for(&home);
    (tmp, p)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn dir_lock_wait_does_not_stall_worker() {
    let (_tmp, p) = paths();
    let held: PathBuf = p.cred_lock_dirs()[0].clone();
    std::fs::create_dir(&held).unwrap();
    assert_not_stalled(async move {
        let r = lock_claude(&p, BLOCK);
        assert!(r.is_err());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn store_lock_wait_does_not_stall_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let mut st = Store::open(tmp.path().join("data"));
    st.lock_timeout = BLOCK;
    let held = st.lock().unwrap();
    assert_not_stalled(async move {
        assert!(st.lock().is_err());
    })
    .await;
    drop(held);
}

struct SlowSecrets;

impl Secrets for SlowSecrets {
    fn available(&self) -> bool {
        true
    }
    fn account(&self) -> String {
        "t".into()
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, SecretsError> {
        thread::sleep(BLOCK / 2);
        Err(SecretsError::Other("slow".into()))
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), SecretsError> {
        thread::sleep(BLOCK);
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), SecretsError> {
        thread::sleep(BLOCK);
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn live_read_keychain_does_not_stall_worker() {
    let (_tmp, p) = paths();
    let live = LiveStore {
        paths: p,
        sec: Arc::new(SlowSecrets),
        retry_delay: Duration::from_millis(1),
    };
    assert_not_stalled(async move {
        assert!(live.read().is_err());
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn backup_keychain_does_not_stall_worker() {
    let tmp = tempfile::tempdir().unwrap();
    let b = BackupStore {
        dir: tmp.path().to_path_buf(),
        sec: Arc::new(SlowSecrets),
    };
    assert_not_stalled(async move {
        assert!(b.delete("id1").is_ok());
    })
    .await;
}
