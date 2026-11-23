//! 식별자 해석 (ORCHESTRATION_V2_SRS 묶음 I). 종류는 형태가 아니라 조회 결과가 정한다 (FR-UNI-10).

use crate::gocase::{to_lower, to_upper};
use crate::parse::Index;
use crate::{Error, Manager};

const ERR_EMPTY_ID: &str = "빈 id";

fn dangling_tab_id(id: &str, pid: &str) -> Error {
    Error::Resolve(format!(
        "tab id {id} 은 toolId={pid} 가리키지만 도구가 존재하지 않음"
    ))
}

fn unresolved_id(id: &str) -> Error {
    Error::Resolve(format!("id 해석 실패: {id} (list_workspace 로 확인)"))
}

/// Go `strings.TrimSpace`.
fn trim_space(s: &str) -> &str {
    s.trim_matches(char::is_whitespace)
}

impl Manager {
    /// 식별자를 살아 있는 toolId 로 바꾼다.
    /// 순서: 살아 있는 toolId → 엔터티 uuid 색인 → 좌표 라벨 색인 → 실패.
    pub fn resolve(&self, id: &str) -> Result<String, Error> {
        let id = trim_space(id);
        if id.is_empty() {
            return Err(Error::Resolve(ERR_EMPTY_ID.into()));
        }
        let ix = self.index();
        if let Some(r) = self.resolve_entity(&ix, id) {
            return r;
        }
        let norm = to_upper(id);
        if let Some(pid) = ix.label_to_id.get(&norm) {
            if !self.live.is_live(pid) {
                return Err(Error::Resolve(format!(
                    "라벨 {norm} 은 toolId={pid} 가리키지만 도구가 존재하지 않음"
                )));
            }
            return Ok(pid.clone());
        }
        Err(unresolved_error(&ix, id))
    }

    /// 좌표 라벨을 받지 않는 해석기다 (FR-IDU-1). 라벨 형태의 입력은 전용 진단으로 갈리고
    /// (FR-IDU-2), 그 밖의 실패 문안은 [`Manager::resolve`] 와 같다 (FR-IDU-3).
    pub fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        let id = trim_space(id);
        if id.is_empty() {
            return Err(Error::Resolve(ERR_EMPTY_ID.into()));
        }
        let ix = self.index();
        if let Some(r) = self.resolve_entity(&ix, id) {
            return r;
        }
        if is_label_form(id) {
            return Err(Error::LabelRejected(id.to_owned()));
        }
        Err(unresolved_error(&ix, id))
    }

    /// 두 해석기가 공유하는 1·2단계다. `None` 이면 이 단계에서 답이 나오지 않았다.
    fn resolve_entity(&self, ix: &Index, id: &str) -> Option<Result<String, Error>> {
        if self.live.is_live(id) {
            return Some(Ok(id.to_owned()));
        }
        let pid = ix.uuid_to_id.get(&to_lower(id))?;
        if !self.live.is_live(pid) {
            return Some(Err(dangling_tab_id(id, pid)));
        }
        Some(Ok(pid.clone()))
    }

    /// 식별자를 브라우저 명령이 읽는 좌표 `W{n}.P{n}.T{n}` 로 바꾼다. 탭 uuid 만 바꾸고
    /// 좌표·toolId·라벨·빈 값은 그대로 돌려준다 (NFR-UID-0).
    pub fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        if id.is_empty() {
            return Ok(String::new());
        }
        let ix = self.index();
        let tool_id = ix.uuid_to_id.get(&to_lower(id)).filter(|p| !p.is_empty());
        let Some(tool_id) = tool_id else {
            // FR-UNI-11 2번: 살아 있는 toolId 는 그대로 통과한다.
            if self.live.is_live(id) {
                return Ok(id.to_owned());
            }
            if is_uuid_form(id) {
                return Err(unresolved_id(id));
            }
            return Ok(id.to_owned());
        };
        if !self.live.is_live(tool_id) {
            return Err(dangling_tab_id(id, tool_id));
        }
        match ix.labels.get(tool_id) {
            Some(label) => Ok(label.clone()),
            None => Err(Error::Resolve(format!(
                "tab id {id} 은 toolId={tool_id} 가리키지만 label 매핑 없음"
            ))),
        }
    }

    /// id 가 지금 색인의 탭 id 인가 (대소문자 무시, FR-DMC-9/10).
    pub fn is_known_tab_id(&self, id: &str) -> bool {
        !id.is_empty() && self.index().uuid_to_id.contains_key(&to_lower(id))
    }
}

/// 사다리를 다 내려온 뒤의 진단이다 (FR-UNI-12).
fn unresolved_error(ix: &Index, id: &str) -> Error {
    if ix.uuid_to_id.values().any(|p| p == id) {
        return Error::Resolve(format!("toolId={id} 존재하지 않음"));
    }
    unresolved_id(id)
}

/// 좌표 라벨의 형태 `(?i)^W\d+\.P\d+\.T\d+$` 다. 진단 문구를 고르는 데에만 쓴다.
fn is_label_form(s: &str) -> bool {
    fn part(s: &str, letter: u8) -> Option<&str> {
        let b = s.as_bytes();
        if b.first()?.to_ascii_uppercase() != letter {
            return None;
        }
        let digits = b[1..].iter().take_while(|c| c.is_ascii_digit()).count();
        (digits > 0).then(|| &s[1 + digits..])
    }
    let Some(rest) = part(s, b'W') else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('.').and_then(|r| part(r, b'P')) else {
        return false;
    };
    matches!(rest.strip_prefix('.').and_then(|r| part(r, b'T')), Some(""))
}

/// 8-4-4-4-12 형태만 본다 (16진수인지는 보지 않는다).
fn is_uuid_form(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
}
