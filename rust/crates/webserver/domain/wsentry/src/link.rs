//! 연동 4규칙 (FR-EDT-31~34). 전부 순수 함수이며 서로를 호출하지 않는다 (FR-EDT-36) — 부르는
//! 순간 사용자 조작 한 번에 규칙이 두 겹 적용된다. home 은 root 행이 이미 대표한다.

use dm_shared_listorder::{Missing, move_item};

use crate::Lists;

/// 핀을 더하고 같은 경로의 Editor 행을 함께 만든다 (FR-EDT-31·37).
pub fn link_pin_add(cur: Lists, root: &str, home: &str) -> Lists {
    let mut out = cur;
    out.pinned = append_unique(&out.pinned, root);
    if root != home {
        out.editors = append_unique(&out.editors, root);
    }
    out
}

/// 핀을 지우고 같은 경로의 Editor 행을 함께 지운다 (FR-EDT-32). 홈은 건드리지 않는다 (FR-EDT-38).
pub fn link_pin_remove(cur: Lists, path: &str, home: &str) -> Lists {
    let mut out = cur;
    out.pinned = remove_all(&out.pinned, path);
    if path != home {
        out.editors = remove_all(&out.editors, path);
    }
    out
}

/// Editor 행을 더하고, 그 경로가 저장소의 루트일 때만 핀을 함께 만든다 (FR-EDT-33).
pub fn link_editor_add(cur: Lists, path: &str, home: &str, repo_root: bool) -> Lists {
    let mut out = cur;
    if path == home {
        return out;
    }
    out.editors = append_unique(&out.editors, path);
    if repo_root {
        out.pinned = append_unique(&out.pinned, path);
    }
    out
}

/// Editor 행을 지우고 같은 경로의 핀을 함께 지운다 (FR-EDT-34). 홈이면 아무것도 하지 않는다
/// (FR-EDT-38a).
pub fn link_editor_remove(cur: Lists, path: &str, home: &str) -> Lists {
    let mut out = cur;
    if path == home {
        return out;
    }
    out.editors = remove_all(&out.editors, path);
    out.pinned = remove_all(&out.pinned, path);
    out
}

/// 멱등한 추가다 (FR-EDT-25). 정렬하지 않는다.
fn append_unique(cur: &[String], p: &str) -> Vec<String> {
    let mut out = cur.to_vec();
    if !cur.iter().any(|v| v == p) {
        out.push(p.to_owned());
    }
    out
}

/// 문자열 완전 일치로 지운다 (FR-EDT-26).
fn remove_all(cur: &[String], p: &str) -> Vec<String> {
    cur.iter().filter(|v| *v != p).cloned().collect()
}

/// src 를 빼서 target 앞/뒤에 넣는다 (FR-EDT-27). 없는 src·target 은 무변경, 빈 target 만 "맨
/// 끝" 이다 (FR-EDT-111).
pub(crate) fn reorder(cur: &[String], src: &str, target: &str, before: bool) -> Vec<String> {
    move_item(cur, src, target, before, Missing::Keep)
}
