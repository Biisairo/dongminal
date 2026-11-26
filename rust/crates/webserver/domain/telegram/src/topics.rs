//! 채팅 방과 Telegram 토픽의 짝 (ISSUE_TREE_CHAT_SRS FR-TGT-4). `telegram.json` 옆 파일(권한 600)에 두어 서버를
//! 다시 시작해도 이어 쓴다. 쓰기에 실패하면 메모리도 그대로 둔다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use otter_gocompat::json;
use otter_gocompat::oserr::go_error_string;
use otter_shared_otterlog::infof;
use serde::{Deserialize, Serialize};

pub(crate) const TOPICS_FILE: &str = "telegram-topics.json";
const FILE_MODE: u32 = 0o600;

/// 설정 파일 옆의 짝 파일 경로.
pub(crate) fn topics_path(settings: &Path) -> PathBuf {
    settings.with_file_name(TOPICS_FILE)
}

/// 방 하나의 토픽. 고정 글은 내용이 바뀔 때만 고친다(FR-TGT-5).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Topic {
    #[serde(rename = "threadId")]
    pub(crate) thread_id: i64,
    #[serde(rename = "pinId")]
    pub(crate) pin_id: i64,
    pub(crate) name: String,
    #[serde(rename = "pinText")]
    pub(crate) pin_text: String,
}

struct Inner {
    path: PathBuf,
    map: BTreeMap<String, Topic>,
}

/// 방 id → 토픽.
pub(crate) struct TopicMap {
    inner: Mutex<Inner>,
}

impl TopicMap {
    /// 파일을 읽는다. 없거나 깨졌으면 빈 짝으로 시작한다.
    pub(crate) fn open(path: &Path) -> TopicMap {
        let map = match std::fs::read(path) {
            Ok(data) => json::unmarshal::<BTreeMap<String, Topic>>(&data).unwrap_or_else(|e| {
                infof!(None, "telegram: 토픽 짝이 깨졌다: {e} — 빈 짝으로 시작한다");
                BTreeMap::new()
            }),
            Err(_) => BTreeMap::new(),
        };
        TopicMap {
            inner: Mutex::new(Inner {
                path: path.to_path_buf(),
                map,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn get(&self, room: &str) -> Option<Topic> {
        self.lock().map.get(room).cloned()
    }

    /// 짝이 있는 방 id 들(차례대로).
    pub(crate) fn rooms(&self) -> Vec<String> {
        self.lock().map.keys().cloned().collect()
    }

    /// 토픽 thread id 의 방. 단추·토픽 글 받기(T-5)가 쓴다.
    #[allow(dead_code)]
    pub(crate) fn by_thread(&self, thread: i64) -> Option<String> {
        self.lock()
            .map
            .iter()
            .find(|(_, t)| t.thread_id == thread)
            .map(|(r, _)| r.clone())
    }

    pub(crate) fn set(&self, room: &str, t: Topic) -> std::io::Result<()> {
        self.update(|m| {
            m.insert(room.to_owned(), t);
        })
    }

    pub(crate) fn remove(&self, room: &str) -> std::io::Result<()> {
        self.update(|m| {
            m.remove(room);
        })
    }

    fn update(&self, f: impl FnOnce(&mut BTreeMap<String, Topic>)) -> std::io::Result<()> {
        let mut g = self.lock();
        let mut m = g.map.clone();
        f(&mut m);
        let data = json::marshal_indent(&m, "", "  ").map_err(std::io::Error::other)?;
        if let Err(e) = otter_shared_platform::write_file_atomic(&g.path, &data, FILE_MODE) {
            infof!(
                None,
                "telegram: 토픽 짝을 쓰지 못했다: {}",
                go_error_string(&e)
            );
            return Err(e);
        }
        g.map = m;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
