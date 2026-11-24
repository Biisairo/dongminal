//! 담당 이슈의 상태로 보류를 판정한다 (SPEC FR-PAR-42).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::runner::Report;

pub const ENV_ISSUES_DIR: &str = "DM_PARITY_ISSUES";
pub const DONE: &str = "done";
const FRONT_MATTER: &str = "---";

/// 이슈 폴더의 `*.md` 머리말에서 `id` → `status` 를 읽는다.
pub fn load_status(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("이슈 폴더 {} 를 읽을 수 없다: {e}", dir.display()))?;
    let mut out = BTreeMap::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "md") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some((id, status)) = parse_front_matter(&text) {
            out.insert(id, status);
        }
    }
    Ok(out)
}

fn parse_front_matter(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    if lines.next()?.trim() != FRONT_MATTER {
        return None;
    }
    let (mut id, mut status) = (None, None);
    for line in lines.take_while(|l| l.trim() != FRONT_MATTER) {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        match k.trim() {
            "id" => id = Some(v),
            "status" => status = Some(v),
            _ => {}
        }
    }
    Some((id?, status?))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Same,
    Differ,
    /// 담당 이슈가 아직 `done` 이 아니어서 차이를 실패로 세지 않는다.
    Pending {
        issue: String,
        status: String,
    },
}

/// 시나리오 오류는 언제나 실패다. 차이는 담당 이슈가 `done` 이 아닐 때만 보류다.
/// 담당 이슈를 이슈 폴더에서 찾지 못하면(오타) 실패다.
pub fn verdict(
    report: &Report,
    owner: Option<&str>,
    statuses: &BTreeMap<String, String>,
) -> Verdict {
    if !report.errors.is_empty() {
        return Verdict::Differ;
    }
    if report.diffs.is_empty() {
        return Verdict::Same;
    }
    match owner.and_then(|o| statuses.get(o).map(|s| (o, s))) {
        Some((issue, status)) if status != DONE => Verdict::Pending {
            issue: issue.to_string(),
            status: status.clone(),
        },
        _ => Verdict::Differ,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::Diff;

    fn report(errors: Vec<String>, diffs: usize) -> Report {
        let d = Diff {
            step: 0,
            step_label: "s".into(),
            name: "stdout".into(),
            line: 1,
            go_line: None,
            rust_line: None,
            go_len: None,
            rust_len: None,
        };
        Report {
            scenario: "x".into(),
            errors,
            diffs: vec![d; diffs],
            roots: Vec::new(),
        }
    }

    fn statuses() -> BTreeMap<String, String> {
        [("6.1", "todo"), ("0.2", "done")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn front_matter_is_parsed() {
        let text = "---\nid: \"6.1\"\ntitle: x: y\nstatus: in-progress\n---\n\nstatus: done\n";
        assert_eq!(
            parse_front_matter(text),
            Some(("6.1".into(), "in-progress".into()))
        );
        assert_eq!(parse_front_matter("# 제목\n"), None);
        assert_eq!(parse_front_matter("---\nid: 1\n---\n"), None);
    }

    #[test]
    fn verdicts() {
        let s = statuses();
        assert_eq!(verdict(&report(vec![], 0), Some("6.1"), &s), Verdict::Same);
        assert_eq!(
            verdict(&report(vec![], 2), Some("6.1"), &s),
            Verdict::Pending {
                issue: "6.1".into(),
                status: "todo".into()
            }
        );
        assert_eq!(
            verdict(&report(vec![], 1), Some("0.2"), &s),
            Verdict::Differ
        );
        assert_eq!(verdict(&report(vec![], 1), None, &s), Verdict::Differ);
        assert_eq!(
            verdict(&report(vec![], 1), Some("9.9.9"), &s),
            Verdict::Differ
        );
        assert_eq!(
            verdict(&report(vec!["e".into()], 0), Some("6.1"), &s),
            Verdict::Differ
        );
    }

    #[test]
    fn load_status_reads_md_files_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("1-a.md"),
            "---\nid: \"1\"\nstatus: split\n---\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("note.txt"),
            "---\nid: 2\nstatus: done\n---\n",
        )
        .unwrap();
        let m = load_status(dir.path()).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["1"], "split");
        assert!(load_status(&dir.path().join("nope")).is_err());
    }
}
