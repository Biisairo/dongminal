//! 두 목록의 read-modify-write (FR-EDT-22·35). 두 목록은 workspace.json 최상위에 산다 (FR-EDT-19).

use otter_gocompat::json;
use serde_json::{Map, Value};

use crate::{Error, Lists, Store};

const GIT_KEY: &str = "git";
const PINNED_KEY: &str = "pinned";
const EDITORS_KEY: &str = "editors";
const LIST_KEY: &str = "list";
const SCHEMA_KEY: &str = "schemaVersion";
const SCHEMA_VER: u64 = 2;
/// 낙관적 동시성 경합 시 한 번 다시 읽어 재시도한다 (FR-EDT-22).
const SAVE_TRIES: usize = 2;

type Doc = Map<String, Value>;

impl Store {
    /// 두 목록을 한 번의 read-modify-write 로 바꾼다. 다른 키는 건드리지 않는다. 경합이면 한 번
    /// 다시 읽어 재시도하고, 성공하면 workspace_changed 를 한 번 브로드캐스트한다. 바뀐 것이
    /// 없으면 저장하지 않는다 (FR-EDT-27·38a).
    pub fn mutate(&self, f: impl Fn(Lists) -> Lists) -> Result<Lists, Error> {
        let work = self.work()?;
        let mut last = None;
        for _ in 0..SAVE_TRIES {
            let (raw, rev) = work.snapshot();
            let (mut doc, cur) = parse(&raw)?;
            let next = f(cur.clone());
            if cur == next {
                return Ok(next);
            }
            write(&mut doc, &next);
            let blob = json::marshal(&doc).map_err(Error::Marshal)?;
            match work.save(&blob, &rev.to_string()) {
                Ok(new_rev) => {
                    if let Some(c) = &self.commands {
                        c.broadcast(&otter_webserver_envelope::workspace_changed(new_rev));
                    }
                    return Ok(next);
                }
                Err(e) if e.is_stale() => last = Some(e),
                Err(e) => return Err(Error::Workspace(e)),
            }
        }
        Err(last.map_or(Error::Unavailable, Error::Workspace))
    }
}

/// 블롭을 map 으로 풀어 문서와 두 목록을 준다. 나머지 키는 그대로 지나간다. JSON `null` 은 빈
/// 문서다 (FR-EDT-30). 빈 문서에는 schemaVersion 을 심는다 (FR-EM-2a).
pub(crate) fn parse(raw: &[u8]) -> Result<(Doc, Lists), Error> {
    let mut doc = Doc::new();
    if !raw.is_empty() {
        doc = json::unmarshal::<Option<Doc>>(raw)
            .map_err(Error::Parse)?
            .unwrap_or_default();
    }
    if doc.is_empty() {
        doc.insert(SCHEMA_KEY.to_owned(), Value::from(SCHEMA_VER));
    }
    let lists = Lists {
        pinned: str_list(&doc, GIT_KEY, PINNED_KEY),
        editors: str_list(&doc, EDITORS_KEY, LIST_KEY),
    };
    Ok((doc, lists))
}

/// doc[outer][inner] 의 문자열 배열이다. 배열이 아니거나 항목이 문자열이 아니면 조용히 버린다
/// — 손상된 워크스페이스가 종단 전체를 죽이지 않는다 (FR-EDT-30).
fn str_list(doc: &Doc, outer: &str, inner: &str) -> Vec<String> {
    let arr = doc
        .get(outer)
        .and_then(Value::as_object)
        .and_then(|m| m.get(inner))
        .and_then(Value::as_array);
    arr.into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn str_array(v: &[String]) -> Value {
    Value::Array(v.iter().cloned().map(Value::String).collect())
}

/// 두 목록을 문서에 되쓴다. 각 상위 객체의 다른 키는 보존한다. editors 키는 목록이 비었고 원래도
/// 없었다면 만들지 않는다.
fn write(doc: &mut Doc, next: &Lists) {
    let mut g = match doc.get(GIT_KEY) {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    g.insert(PINNED_KEY.to_owned(), str_array(&next.pinned));
    doc.insert(GIT_KEY.to_owned(), Value::Object(g));

    if next.editors.is_empty() && !doc.contains_key(EDITORS_KEY) {
        return;
    }
    let mut e = match doc.get(EDITORS_KEY) {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    e.insert(LIST_KEY.to_owned(), str_array(&next.editors));
    doc.insert(EDITORS_KEY.to_owned(), Value::Object(e));
}
