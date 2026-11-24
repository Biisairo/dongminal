//! 한 묶음 안의 변화 병합 (FR-ELR-57, VS Code `watcher.ts` `coalesceEvents`).

use std::collections::HashMap;
use std::fmt;

use otter_gocompat::filepath;

/// 병합한 뒤의 변화 종류.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Added = 1,
    Updated,
    Deleted,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Added => "added",
            Kind::Updated => "updated",
            Kind::Deleted => "deleted",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 경로 하나의 변화.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub kind: Kind,
}

impl Change {
    pub fn new(path: impl Into<String>, kind: Kind) -> Self {
        Change {
            path: path.into(),
            kind,
        }
    }
}

/// 같은 경로의 변화를 합친다. case_sensitive 가 거짓이면 소문자로 견준다. 철자만 다른
/// ADDED·DELETED 는 대소문자만 바꾼 rename 이므로 둘 다 남긴다.
pub fn coalesce(input: &[Change], case_sensitive: bool) -> Vec<Change> {
    let key = |p: &str| {
        if case_sensitive {
            p.to_owned()
        } else {
            p.to_lowercase()
        }
    };
    // order 의 칸은 None 이면 지워진 것이다.
    let mut order: Vec<Option<Change>> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for c in input {
        let k = key(&c.path);
        let Some(&i) = by_key.get(&k) else {
            by_key.insert(k, order.len());
            order.push(Some(c.clone()));
            continue;
        };
        let Some(prev) = order[i].as_mut() else {
            continue;
        };
        if prev.path != c.path && matches!(c.kind, Kind::Added | Kind::Deleted) {
            order.push(Some(c.clone()));
            continue;
        }
        match (prev.kind, c.kind) {
            (Kind::Added, Kind::Deleted) => {
                by_key.remove(&k);
                order[i] = None;
            }
            (Kind::Deleted, Kind::Added) => prev.kind = Kind::Updated,
            (Kind::Added, Kind::Updated) => {}
            _ => prev.kind = c.kind,
        }
    }
    let (mut deletes, rest): (Vec<Change>, Vec<Change>) = order
        .into_iter()
        .flatten()
        .partition(|c| c.kind == Kind::Deleted);
    deletes.sort_by_key(|c| c.path.len());
    let mut kept: Vec<Change> = Vec::new();
    for d in deletes {
        if kept
            .iter()
            .any(|k| is_parent(&k.path, &d.path, case_sensitive))
        {
            continue;
        }
        kept.push(d);
    }
    kept.extend(rest);
    kept
}

fn is_parent(parent: &str, child: &str, case_sensitive: bool) -> bool {
    let (parent, child) = if case_sensitive {
        (parent.to_owned(), child.to_owned())
    } else {
        (parent.to_lowercase(), child.to_lowercase())
    };
    let sep = filepath::SEPARATOR;
    let prefix = format!("{}{sep}", parent.strip_suffix(sep).unwrap_or(&parent));
    child.starts_with(&prefix)
}

#[cfg(test)]
mod tests {
    use super::Kind::*;
    use super::*;

    fn ch(p: &str, k: Kind) -> Change {
        Change::new(p, k)
    }

    #[test]
    fn rules() {
        assert!(coalesce(&[ch("/r/a", Added), ch("/r/a", Deleted)], true).is_empty());
        assert_eq!(
            coalesce(&[ch("/r/a", Deleted), ch("/r/a", Added)], true),
            [ch("/r/a", Updated)]
        );
        assert_eq!(
            coalesce(&[ch("/r/a", Added), ch("/r/a", Updated)], true),
            [ch("/r/a", Added)]
        );
        assert_eq!(
            coalesce(&[ch("/r/a", Updated), ch("/r/a", Deleted)], true),
            [ch("/r/a", Deleted)]
        );
        assert_eq!(
            coalesce(&[ch("/r/a", Updated), ch("/r/a", Updated)], true),
            [ch("/r/a", Updated)]
        );
        // 지워진 뒤 다시 오면 새 항목이다.
        assert_eq!(
            coalesce(
                &[ch("/r/a", Added), ch("/r/a", Deleted), ch("/r/a", Updated)],
                true
            ),
            [ch("/r/a", Updated)]
        );
    }

    #[test]
    fn child_delete_dropped_when_parent_deleted() {
        let p = filepath::from_slash;
        let got = coalesce(
            &[
                ch(&p("/r/d/x"), Deleted),
                ch(&p("/r/d"), Deleted),
                ch(&p("/r/d/y/z"), Deleted),
                ch(&p("/r/e"), Deleted),
            ],
            true,
        );
        assert_eq!(got, [ch(&p("/r/d"), Deleted), ch(&p("/r/e"), Deleted)]);
        assert_eq!(
            coalesce(&[ch("/r/d", Deleted), ch("/r/dd", Deleted)], true).len(),
            2
        );
    }

    #[test]
    fn case_rules() {
        assert_eq!(
            coalesce(&[ch("/r/A.txt", Deleted), ch("/r/a.txt", Added)], false),
            [ch("/r/A.txt", Deleted), ch("/r/a.txt", Added)]
        );
        let got = coalesce(&[ch("/r/A.txt", Updated), ch("/r/a.txt", Updated)], false);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, Updated);
        assert_eq!(
            coalesce(&[ch("/r/A.txt", Updated), ch("/r/a.txt", Updated)], true).len(),
            2
        );
    }

    #[test]
    fn non_delete_after_deletes() {
        assert_eq!(
            coalesce(&[ch("/r/b", Updated), ch("/r/a", Deleted)], true),
            [ch("/r/a", Deleted), ch("/r/b", Updated)]
        );
    }

    #[test]
    fn kind_string() {
        assert_eq!(
            (Added.as_str(), Updated.as_str(), Deleted.as_str()),
            ("added", "updated", "deleted")
        );
    }
}
