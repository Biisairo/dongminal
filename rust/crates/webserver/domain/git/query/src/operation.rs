//! 진행 중 작업 판정 (FR-GIT-252 · FR-GDT-19).

use std::path::Path;

use serde::Serialize;

use crate::preflight::{
    BISECT_LOG_FILE, CHERRY_PICK_HEAD_FILE, MERGE_HEAD_FILE, REBASE_APPLY_DIR, REBASE_APPLYING,
    REBASE_MERGE_DIR, REVERT_HEAD_FILE, any_exists,
};
use crate::status::is_zero;

pub const OP_NONE: &str = "";
pub const OP_MERGE: &str = "merge";
pub const OP_REBASE: &str = "rebase";
pub const OP_CHERRY_PICK: &str = "cherry-pick";
pub const OP_REVERT: &str = "revert";
pub const OP_AM: &str = "am";
pub const OP_BISECT: &str = "bisect";

const REBASE_MERGE_MSG_NUM: &str = "msgnum";
const REBASE_MERGE_END: &str = "end";
const REBASE_APPLY_NEXT: &str = "next";
const REBASE_APPLY_LAST: &str = "last";

/// 판정 순서가 곧 우선순위다 — am 은 rebase-apply/applying 이 있을 때다.
fn operation_markers() -> Vec<(&'static str, Vec<String>)> {
    vec![
        (
            OP_AM,
            vec![otter_gocompat::filepath::join(&[
                REBASE_APPLY_DIR,
                REBASE_APPLYING,
            ])],
        ),
        (
            OP_REBASE,
            vec![REBASE_MERGE_DIR.into(), REBASE_APPLY_DIR.into()],
        ),
        (OP_CHERRY_PICK, vec![CHERRY_PICK_HEAD_FILE.into()]),
        (OP_REVERT, vec![REVERT_HEAD_FILE.into()]),
        (OP_MERGE, vec![MERGE_HEAD_FILE.into()]),
        (OP_BISECT, vec![BISECT_LOG_FILE.into()]),
    ]
}

pub(crate) fn markers_of(kind: &str) -> Vec<String> {
    operation_markers()
        .into_iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, n)| n)
        .unwrap_or_default()
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Operation {
    pub kind: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub total: i64,
}

impl Operation {
    pub fn in_progress(&self) -> bool {
        self.kind != OP_NONE
    }
}

/// gitDir 의 표식 파일로 진행 중 작업을 판정한다.
pub fn detect_operation(git_dir: &str) -> Operation {
    for (kind, names) in operation_markers() {
        if !any_exists(git_dir, &names) {
            continue;
        }
        let mut op = Operation {
            kind: kind.to_owned(),
            ..Operation::default()
        };
        if kind == OP_REBASE || kind == OP_AM {
            (op.at, op.total) = rebase_progress(git_dir);
        }
        return op;
    }
    Operation::default()
}

fn rebase_progress(git_dir: &str) -> (i64, i64) {
    for (dir, at, total) in [
        (REBASE_MERGE_DIR, REBASE_MERGE_MSG_NUM, REBASE_MERGE_END),
        (REBASE_APPLY_DIR, REBASE_APPLY_NEXT, REBASE_APPLY_LAST),
    ] {
        let t = read_num(&Path::new(git_dir).join(dir).join(total));
        if t > 0 {
            return (read_num(&Path::new(git_dir).join(dir).join(at)), t);
        }
    }
    (0, 0)
}

fn read_num(p: &Path) -> i64 {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| crate::status::atoi(s.trim()))
        .filter(|n| *n >= 0)
        .unwrap_or(0)
}
