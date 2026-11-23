mod backup;
mod config;
mod dispatch;
mod doctor;
mod fake_http;
mod golden;
mod health;
mod homelayout;
mod logcap;
mod migrate;
mod options;
mod proc;
mod rollback;
mod service;
mod shellwait;
mod staleness;
mod start;
mod uninstall;
mod update;
mod window;

use std::collections::HashMap;
use std::path::Path;

use crate::env::Env;

pub(crate) fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).to_owned()).collect()
}

/// 서버를 띄우려 하면 곧바로 드러나게 한다 — 이 검사들의 어느 입력도 서버를 띄워서는 안 된다.
fn no_serve(_: &crate::ServeTarget<'_>) -> i32 {
    panic!("serve 가 불렸다")
}

pub(crate) fn dispatch(a: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = crate::dispatch(&args(a), &no_serve, &mut out, &mut err);
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

/// 검사용 환경. 적지 않은 변수는 빈 문자열이다 — Go 검사의 `isolateEnv` 와 같은 전제다.
pub(crate) struct Vars(HashMap<String, String>);

impl Vars {
    pub(crate) fn new(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        )
    }

    /// `DONGMINAL_HOME` 만 home 으로 둔 환경. 사용자 홈은 home 의 부모다.
    pub(crate) fn home(home: &Path) -> Self {
        let user = home.parent().unwrap().to_str().unwrap();
        Self::new(&[
            (dm_shared_dmenv::ENV_HOME, home.to_str().unwrap()),
            (USER_HOME_VAR, user),
        ])
    }

    pub(crate) fn set(&mut self, k: &str, v: &str) {
        self.0.insert(k.to_owned(), v.to_owned());
    }

    pub(crate) fn get(&self, k: &str) -> String {
        self.0.get(k).cloned().unwrap_or_default()
    }
}

#[cfg(windows)]
pub(crate) const USER_HOME_VAR: &str = "USERPROFILE";
#[cfg(not(windows))]
pub(crate) const USER_HOME_VAR: &str = "HOME";

pub(crate) fn with_env<R>(vars: &Vars, f: impl FnOnce(&Env<'_>) -> R) -> R {
    let get = |k: &str| vars.get(k);
    f(&Env::from_fn(&get))
}

pub(crate) fn write_server_json(home: &Path, body: &str) {
    std::fs::write(home.join("server.json"), body).unwrap();
}

pub(crate) fn write_settings_json(home: &Path, body: &str) {
    std::fs::write(home.join("settings.json"), body).unwrap();
}

/// 임시 홈. 사용자 홈과 분리하려고 한 단계 아래에 둔다.
pub(crate) fn temp_home() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("dmhome");
    std::fs::create_dir(&home).unwrap();
    (dir, home)
}
