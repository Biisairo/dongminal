//! telegram.json (FR-TGB-2). 일반 설정은 모든 브라우저로 내려가므로 token 을 둘 수 없어 전용
//! 파일(권한 600)에 둔다 (D-TGB-12).

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dm_gocompat::json;
use dm_gocompat::oserr::{go_error_string, path_error};
use dm_shared_dmlog::infof;
use serde::{Deserialize, Serialize};

/// PC 입력 뒤 알림을 소리 없이 보내는 시간(분)의 기본값 (D-TGB-9).
pub const DEFAULT_SILENCE_MIN: i64 = 5;
/// 그 상한. 하루.
pub const MAX_SILENCE_MIN: i64 = 24 * 60;
const FILE_MODE: u32 = 0o600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoreError {
    InvalidSilence,
    SaveFailed,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            StoreError::InvalidSilence => "무음 시간은 0~1440분입니다",
            StoreError::SaveFailed => "Telegram 설정을 저장하지 못했습니다",
        })
    }
}

impl std::error::Error for StoreError {}

/// telegram.json 의 내용. 필드 순서가 파일 형식이다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "telegram.Config")]
pub struct Config {
    pub enabled: bool,
    pub token: String,
    #[serde(rename = "botName")]
    pub bot_name: String,
    /// 허용 계정 (FR-TGB-11). 1:1 대화방의 chat_id 와 같다.
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "silenceMin")]
    pub silence_min: i64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: false,
            token: String::new(),
            bot_name: String::new(),
            user_id: 0,
            silence_min: DEFAULT_SILENCE_MIN,
        }
    }
}

/// 화면으로 가는 값. token 을 싣지 않는다 (FR-TGB-3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct View {
    pub enabled: bool,
    #[serde(rename = "tokenSet")]
    pub token_set: bool,
    #[serde(rename = "botName")]
    pub bot_name: String,
    pub paired: bool,
    #[serde(rename = "silenceMin")]
    pub silence_min: i64,
}

struct Inner {
    path: PathBuf,
    cfg: Config,
}

/// telegram.json. 틀린 값은 저장하지 않고, 쓰기에 실패하면 메모리도 그대로 둔다.
pub struct Store {
    inner: Mutex<Inner>,
}

impl Store {
    /// 파일을 읽는다. 없거나 깨졌으면 꺼진 기본값으로 시작한다.
    pub fn open(path: impl AsRef<Path>) -> Store {
        let path = path.as_ref().to_path_buf();
        let cfg = match std::fs::read(&path) {
            Ok(data) => match json::unmarshal::<Config>(&data) {
                Ok(c) => c,
                Err(e) => {
                    infof!(None, "telegram: 설정이 깨졌다: {e} — 끈 채로 시작한다");
                    Config::default()
                }
            },
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    let e = path_error("open", &path.to_string_lossy(), e);
                    infof!(
                        None,
                        "telegram: 설정을 읽지 못했다: {} — 끈 채로 시작한다",
                        go_error_string(&e)
                    );
                }
                Config::default()
            }
        };
        Store {
            inner: Mutex::new(Inner { path, cfg }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 지금 값의 사본.
    pub fn config(&self) -> Config {
        self.lock().cfg.clone()
    }

    pub fn view(&self) -> View {
        let g = self.lock();
        View {
            enabled: g.cfg.enabled,
            token_set: !g.cfg.token.is_empty(),
            bot_name: g.cfg.bot_name.clone(),
            paired: g.cfg.user_id != 0,
            silence_min: g.cfg.silence_min,
        }
    }

    fn update(&self, f: impl FnOnce(&mut Config)) -> Result<(), StoreError> {
        let mut g = self.lock();
        let mut c = g.cfg.clone();
        f(&mut c);
        let data = json::marshal_indent(&c, "", "  ").map_err(|_| StoreError::SaveFailed)?;
        if let Err(e) = dm_shared_platform::write_file_atomic(&g.path, &data, FILE_MODE) {
            infof!(
                None,
                "telegram: 설정을 쓰지 못했다: {}",
                go_error_string(&e)
            );
            return Err(StoreError::SaveFailed);
        }
        g.cfg = c;
        Ok(())
    }

    /// token 과 봇 이름을 바꾼다. token 이 바뀌면 허용 계정을 지운다 (FR-TGB-5).
    pub fn set_token(&self, token: &str, bot_name: &str) -> Result<(), StoreError> {
        self.update(|c| {
            if c.token != token {
                c.user_id = 0;
            }
            c.token = token.to_owned();
            c.bot_name = bot_name.to_owned();
        })
    }

    pub fn set_enabled(&self, on: bool) -> Result<(), StoreError> {
        self.update(|c| c.enabled = on)
    }

    pub fn set_silence(&self, min: i64) -> Result<(), StoreError> {
        if !(0..=MAX_SILENCE_MIN).contains(&min) {
            return Err(StoreError::InvalidSilence);
        }
        self.update(|c| c.silence_min = min)
    }

    /// 허용 계정을 바꾼다. 0 이면 해제다.
    pub fn set_user(&self, id: i64) -> Result<(), StoreError> {
        self.update(|c| c.user_id = id)
    }

    #[cfg(test)]
    pub(crate) fn set_path(&self, p: PathBuf) {
        self.lock().path = p;
    }
}

#[cfg(test)]
mod tests;
