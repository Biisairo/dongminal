//! 진행 중 작업의 출구 (GIT_ACTIONS_SRS §3.1 / FR-GIT-252). 종류는 `query::OP_*` 를 그대로 쓴다.

use otter_gocompat::strconv::quote;
use otter_webserver_domain_git_core::WriteSpec;
use otter_webserver_domain_git_query as query;

use crate::error::{Error, WriteKind};

pub const OP_CONTINUE: &str = "continue";
pub const OP_ABORT: &str = "abort";
pub const OP_SKIP: &str = "skip";

/// 종류별로 git 이 실제로 받는 하위 명령과 플래그다. merge 에는 skip 이 없다.
/// bisect 의 출구는 reset 하나뿐이다 (FR-GDT-18·20).
fn operation_verbs(kind: &str) -> Option<&'static [(&'static str, [&'static str; 2])]> {
    Some(match kind {
        query::OP_MERGE => &[
            (OP_CONTINUE, ["merge", "--continue"]),
            (OP_ABORT, ["merge", "--abort"]),
        ],
        query::OP_REBASE => &[
            (OP_CONTINUE, ["rebase", "--continue"]),
            (OP_ABORT, ["rebase", "--abort"]),
            (OP_SKIP, ["rebase", "--skip"]),
        ],
        query::OP_CHERRY_PICK => &[
            (OP_CONTINUE, ["cherry-pick", "--continue"]),
            (OP_ABORT, ["cherry-pick", "--abort"]),
            (OP_SKIP, ["cherry-pick", "--skip"]),
        ],
        query::OP_REVERT => &[
            (OP_CONTINUE, ["revert", "--continue"]),
            (OP_ABORT, ["revert", "--abort"]),
            (OP_SKIP, ["revert", "--skip"]),
        ],
        query::OP_AM => &[
            (OP_CONTINUE, ["am", "--continue"]),
            (OP_ABORT, ["am", "--abort"]),
            (OP_SKIP, ["am", "--skip"]),
        ],
        query::OP_BISECT => &[(OP_ABORT, ["bisect", "reset"])],
        _ => return None,
    })
}

const OPERATION_KINDS: [&str; 6] = [
    query::OP_MERGE,
    query::OP_REBASE,
    query::OP_CHERRY_PICK,
    query::OP_REVERT,
    query::OP_AM,
    query::OP_BISECT,
];

/// 출구를 가진 종류 전부다. 정렬돼 있다.
pub fn operation_kinds() -> Vec<String> {
    let mut out: Vec<String> = OPERATION_KINDS.iter().map(|s| (*s).to_owned()).collect();
    out.sort();
    out
}

/// 그 종류가 실제로 줄 수 있는 출구다. 순서: 계속 → 건너뛰기 → 중단 (O14).
pub fn operation_actions(kind: &str) -> Vec<String> {
    let Some(verbs) = operation_verbs(kind) else {
        return Vec::new();
    };
    [OP_CONTINUE, OP_SKIP, OP_ABORT]
        .into_iter()
        .filter(|a| verbs.iter().any(|(v, _)| v == a))
        .map(str::to_owned)
        .collect()
}

/// 조합을 argv 로 옮긴다. 실행하지 않는다.
pub fn operation_args(kind: &str, action: &str) -> Result<Vec<String>, Error> {
    let Some(verbs) = operation_verbs(kind) else {
        return Err(Error::new(
            WriteKind::Operation,
            format!("진행 중 작업이 아니다: {}", quote(kind)),
        ));
    };
    match verbs.iter().find(|(v, _)| *v == action) {
        Some((_, argv)) => Ok(argv.iter().map(|s| (*s).to_owned()).collect()),
        None => Err(Error::new(
            WriteKind::Operation,
            format!("{} 에 {} 는 없다", quote(kind), quote(action)),
        )),
    }
}

/// 진행 중 작업의 출구 하나다 (FR-GIT-252). 중단만 파괴적이다.
pub fn operation_spec(kind: &str, action: &str) -> Result<WriteSpec, Error> {
    let argv = operation_args(kind, action)?;
    Ok(WriteSpec {
        argv,
        destructive: action == OP_ABORT,
        stdin: String::new(),
    })
}
