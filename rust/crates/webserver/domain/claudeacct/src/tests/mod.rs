//! Go 시험을 옮긴 것. 도우미는 Go `fakes_test.go` 와 가짜 HTTP 서버다.

mod auto;
mod creds;
mod engine;
mod files;
mod http;
mod offload;
mod parse;
mod service;
mod smart;
mod view;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dm_shared_platform::{Secrets, SecretsError};

use crate::Credential;

/// `Secrets` 의 메모리 구현이다.
#[derive(Default)]
pub(crate) struct MemSecrets {
    pub(crate) items: Mutex<HashMap<(String, String), String>>,
    pub(crate) off: Mutex<bool>,
    pub(crate) fail_set: Mutex<bool>,
    pub(crate) fail_get: Mutex<bool>,
}

impl MemSecrets {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub(crate) fn has(&self, s: &str, a: &str) -> bool {
        self.items
            .lock()
            .unwrap()
            .contains_key(&(s.into(), a.into()))
    }
    pub(crate) fn put(&self, s: &str, a: &str, v: &str) {
        self.items
            .lock()
            .unwrap()
            .insert((s.into(), a.into()), v.into());
    }
    pub(crate) fn len(&self) -> usize {
        self.items.lock().unwrap().len()
    }
}

impl Secrets for MemSecrets {
    fn available(&self) -> bool {
        !*self.off.lock().unwrap()
    }
    fn account(&self) -> String {
        "tester".into()
    }
    fn get(&self, s: &str, a: &str) -> Result<Option<String>, SecretsError> {
        if *self.off.lock().unwrap() {
            return Err(SecretsError::Other("unavailable".into()));
        }
        if *self.fail_get.lock().unwrap() {
            return Err(SecretsError::Other("keychain broken".into()));
        }
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(&(s.into(), a.into()))
            .cloned())
    }
    fn set(&self, s: &str, a: &str, v: &str) -> Result<(), SecretsError> {
        if *self.off.lock().unwrap() || *self.fail_set.lock().unwrap() {
            return Err(SecretsError::Other("set failed".into()));
        }
        self.put(s, a, v);
        Ok(())
    }
    fn delete(&self, s: &str, a: &str) -> Result<(), SecretsError> {
        self.items.lock().unwrap().remove(&(s.into(), a.into()));
        Ok(())
    }
}

pub(crate) fn cred_json(access: &str, refresh: &str, extra: &str) -> String {
    let mut s = format!(
        r#"{{"claudeAiOauth":{{"accessToken":"{access}","refreshToken":"{refresh}","expiresAt":1700000000000,"refreshTokenExpiresAt":1800000000000,"scopes":["user:inference","user:profile"],"subscriptionType":"max","futureField":7}}"#
    );
    if !extra.is_empty() {
        s.push(',');
        s.push_str(extra);
    }
    s.push('}');
    s
}

pub(crate) fn cred(access: &str, refresh: &str, extra: &str) -> Credential {
    Credential::parse(cred_json(access, refresh, extra).as_bytes()).unwrap()
}

/// 유닉스 권한을 본다. 권한을 보지 않는 환경(Windows)에서는 늘 참이다.
pub(crate) fn perm_is(p: &std::path::Path, want: u32) -> bool {
    if !dm_shared_testpath::perm_checked() {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777 == want
    }
    #[cfg(not(unix))]
    {
        let _ = (p, want);
        true
    }
}

impl MemSecrets {
    pub(crate) fn get_raw(&self, s: &str) -> String {
        self.items
            .lock()
            .unwrap()
            .get(&(s.into(), "tester".into()))
            .cloned()
            .unwrap_or_default()
    }
}

/// `ProfileLookup` 이다. 토큰마다 정체를 돌려준다.
#[derive(Default)]
pub(crate) struct FakeProfile {
    pub(crate) by_token: Mutex<HashMap<String, crate::Identity>>,
    pub(crate) calls: std::sync::atomic::AtomicUsize,
    pub(crate) err: Mutex<Option<String>>,
}

impl crate::ProfileLookup for FakeProfile {
    fn profile<'a>(
        &'a self,
        token: &'a str,
    ) -> futures_util::future::BoxFuture<'a, Result<crate::Identity, crate::Error>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let r = match self.err.lock().unwrap().clone() {
            Some(e) => Err(crate::Error::new(e)),
            None => self
                .by_token
                .lock()
                .unwrap()
                .get(token)
                .cloned()
                .ok_or_else(|| crate::Error::new("unknown token")),
        };
        Box::pin(async move { r })
    }
}
