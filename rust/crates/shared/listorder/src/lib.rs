//! Go 기준선 `dongminal/internal/shared/listorder` 의 Rust 포팅.
//!
//! "끌어다 놓기" 한 번을 목록에 반영한다 (FR-DRC-11).

/// target 을 목록에서 못 찾았을 때의 정책이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missing {
    /// 목록을 그대로 둔다 (FR-EDT-27).
    Keep,
    /// 맨 끝으로 옮긴다.
    ToEnd,
}

/// `src` 를 `target` 의 앞(`before`) 또는 뒤로 옮긴 새 목록이다.
///
/// 빈 target 은 언제나 "맨 끝"이다 — `missing` 정책보다 앞선다.
/// src 가 목록에 없거나 src == target 이면 원본과 같은 목록이다.
pub fn move_item<S: AsRef<str> + Clone>(
    cur: &[S],
    src: &str,
    target: &str,
    before: bool,
    missing: Missing,
) -> Vec<S> {
    let Some(si) = index_of(cur, src) else {
        return cur.to_vec();
    };
    if src == target {
        return cur.to_vec();
    }
    let moved = cur[si].clone();
    let mut out: Vec<S> = Vec::with_capacity(cur.len());
    out.extend_from_slice(&cur[..si]);
    out.extend_from_slice(&cur[si + 1..]);

    let Some(mut ti) = index_of(&out, target) else {
        if target.is_empty() || missing == Missing::ToEnd {
            out.push(moved);
            return out;
        }
        return cur.to_vec();
    };
    if !before {
        ti += 1;
    }
    out.insert(ti, moved);
    out
}

fn index_of<S: AsRef<str>>(list: &[S], want: &str) -> Option<usize> {
    list.iter().position(|p| p.as_ref() == want)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mv(cur: &[&str], src: &str, target: &str, before: bool, m: Missing) -> Vec<String> {
        let cur: Vec<String> = cur.iter().map(|s| s.to_string()).collect();
        move_item(&cur, src, target, before, m)
    }

    #[test]
    fn before_and_after() {
        assert_eq!(mv(&["a", "b", "c", "d"], "d", "b", true, Missing::Keep), ["a", "d", "b", "c"]);
        assert_eq!(mv(&["a", "b", "c", "d"], "a", "c", false, Missing::Keep), ["b", "c", "a", "d"]);
        assert_eq!(mv(&["a", "b", "c"], "a", "c", false, Missing::Keep), ["b", "c", "a"]);
    }

    #[test]
    fn noop_cases() {
        assert_eq!(mv(&["a", "b"], "x", "a", true, Missing::ToEnd), ["a", "b"]);
        assert_eq!(mv(&["a", "b"], "a", "a", true, Missing::ToEnd), ["a", "b"]);
    }

    #[test]
    fn empty_target_is_end_regardless_of_policy() {
        assert_eq!(mv(&["a", "b", "c"], "a", "", true, Missing::Keep), ["b", "c", "a"]);
    }

    #[test]
    fn missing_target_policy() {
        assert_eq!(mv(&["a", "b", "c"], "a", "zz", true, Missing::Keep), ["a", "b", "c"]);
        assert_eq!(mv(&["a", "b", "c"], "a", "zz", true, Missing::ToEnd), ["b", "c", "a"]);
    }
}
