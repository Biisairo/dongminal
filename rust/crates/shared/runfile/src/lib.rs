//! Go 기준선 `otterminal/internal/shared/runfile` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! `runs.json` 을 **읽기만** 한다. Run 의 어휘·상태 전이·펜싱은 `webserver/domain/run` 의 것이다.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

/// Run 레코드 파일의 이름이다. `domain/run` 의 Store 와 같은 값이어야 한다.
pub const FILE_NAME: &str = "runs.json";

/// "열린 Run" 의 와이어 값이다.
pub const STATE_OPEN: &str = "open";

// 헤드리스 판정에 필요한 필드만 든다. 나머지 필드는 무시된다.
#[derive(Deserialize, Default)]
#[serde(default, rename = "runfile.fileBody")]
struct FileBody {
    runs: Option<Vec<Record>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "runfile.record")]
struct Record {
    state: String,
    members: Option<Vec<Member>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "runfile.member")]
struct Member {
    #[serde(rename = "toolId")]
    tool_id: String,
    #[serde(rename = "tabId")]
    tab_id: String,
    headless: bool,
}

impl Member {
    // `run.Member.HeadlessTool` 과 같은 판정이다.
    fn headless_tool(&self) -> bool {
        self.headless && self.tab_id.is_empty() && !self.tool_id.is_empty()
    }
}

/// `runs.json` 을 직접 읽어 **디스크에서 열린** Run 에 속한 headless 멤버의 도구 id 를
/// 돌려준다 (FR-HLM-3). 실패는 빈 집합이다.
pub fn headless_tool_ids(dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(blob) = std::fs::read(dir.join(FILE_NAME)) else {
        return out;
    };
    let Ok(body) = otter_gocompat::json::unmarshal::<FileBody>(&blob) else {
        return out;
    };
    for rec in body.runs.unwrap_or_default() {
        if rec.state != STATE_OPEN {
            continue;
        }
        for m in rec.members.unwrap_or_default() {
            if m.headless_tool() {
                out.insert(m.tool_id);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(body: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), body).unwrap();
        dir
    }

    #[test]
    fn open_headless_only() {
        let dir = write(
            r#"{"schemaVersion":1,"runs":[
	  {"id":"r1","state":"open","members":[
	    {"id":"m1","toolId":"t-open-headless","headless":true},
	    {"id":"m2","toolId":"t-open-tabbed","tabId":"tab","headless":true},
	    {"id":"m3","toolId":"t-open-tui"}
	  ]},
	  {"id":"r2","state":"closed","members":[{"id":"m4","toolId":"t-closed","headless":true}]},
	  {"id":"r3","state":"aborted","members":[{"id":"m5","toolId":"t-aborted","headless":true}]}
	]}"#,
        );
        let got = headless_tool_ids(dir.path());
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got.contains("t-open-headless"));
    }

    #[test]
    fn failures_are_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(headless_tool_ids(dir.path()).is_empty());
        assert!(headless_tool_ids(write("{not json").path()).is_empty());
        // 타입 오류도 실패다 — Go 는 부분 값을 쓰지 않는다.
        assert!(
            headless_tool_ids(
                write(r#"{"runs":[{"state":"open","members":[{"toolId":"t","headless":"yes"}]}]}"#)
                    .path()
            )
            .is_empty()
        );
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = write(
            r#"{"schemaVersion":9,"extra":1,"runs":[{"state":"open","future":{"x":1},"members":[{"toolId":"t","headless":true,"worktree":{"path":"/w"}}]}]}"#,
        );
        assert_eq!(headless_tool_ids(dir.path()).len(), 1);
    }

    // Go v1 은 필드 이름을 대소문자 무시로도 맞춘다. null 은 0 값이다.
    #[test]
    fn case_insensitive_and_null() {
        let dir = write(
            r#"{"RUNS":[{"State":"open","members":[{"TOOLID":"t","headless":true,"tabId":null}]},{"state":"open","members":null}]}"#,
        );
        assert_eq!(headless_tool_ids(dir.path()).len(), 1);
    }
}
