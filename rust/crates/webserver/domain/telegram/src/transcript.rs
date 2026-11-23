//! transcript 읽기 (FR-TGB-53). main 의 응답 글만 고른다 — 도구 호출·결과·생각·사이드체인·
//! 시스템 줄·첨부는 버린다.

use std::io::{Read, Seek, SeekFrom};

use dm_gocompat::json::{self, RawMessage};
use serde::Deserialize;

/// 끝에서 읽는 상한 (NFR-TGB-5).
const LAST_SCAN_MAX: u64 = 512 << 10;

#[derive(Deserialize, Default)]
#[serde(default)]
struct TMessage {
    content: Option<RawMessage>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "isSidechain")]
    is_sidechain: bool,
    message: TMessage,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TBlock {
    #[serde(rename = "type")]
    kind: String,
    text: String,
}

/// transcript 한 줄의 마지막 응답 글. 없으면 빈 글이다.
fn reply_text(line: &[u8]) -> String {
    let Ok(l) = json::unmarshal::<TLine>(line) else {
        return String::new();
    };
    if l.kind != "assistant" || l.is_sidechain {
        return String::new();
    }
    let content = l.message.content.map(|c| c.0).unwrap_or_default();
    let Ok(blocks) = json::unmarshal::<Vec<TBlock>>(&content) else {
        return String::new();
    };
    let mut last = String::new();
    for b in blocks {
        let s = b.text.trim();
        if b.kind == "text" && !s.is_empty() {
            last = s.to_owned();
        }
    }
    last
}

/// 마지막 응답 글. 끝 512KB 만 본다.
pub fn last_reply(path: &str) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let Ok(meta) = f.metadata() else {
        return String::new();
    };
    let from = meta.len().saturating_sub(LAST_SCAN_MAX);
    if f.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let mut last = String::new();
    for line in buf.split(|&c| c == b'\n') {
        let s = reply_text(line);
        if !s.is_empty() {
            last = s;
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    // 줄 모양은 2026-11-12 실측(Claude Code 2.1.322)의 키 구조를 따른다. 내용은 지어낸 것이다.
    const SAMPLE: &[&str] = &[
        r#"{"type":"permission-mode","permissionMode":"default","sessionId":"s"}"#,
        r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"고쳐줘"}}"#,
        r#"{"type":"api-request-blob","message":{"content":[{"type":"text","text":"SYSTEM PROMPT user@example.com"}]}}"#,
        r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"thinking","thinking":"SECRET THINKING"}]}}"#,
        r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"파일을 **읽겠습니다**."}]}}"#,
        r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test\nnpm run lint","description":"x"}}]}}"#,
        r#"{"type":"user","isSidechain":false,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"TOOL OUTPUT SECRET"}]},"toolUseResult":{"stdout":"TOOL OUTPUT SECRET"}}"#,
        r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/src/app.ts"}}]}}"#,
        r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t3","name":"Agent","input":{"description":"코드 조사","prompt":"PROMPT SECRET"}}]}}"#,
        r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"SIDECHAIN SECRET"}]}}"#,
        r#"{"type":"attachment","attachment":{"content":"ATTACH SECRET"}}"#,
        r#"{"type":"cost-state","totalCostUSD":1}"#,
    ];

    #[test]
    fn last_reply_picks_main_text() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let body = SAMPLE.join("\n")
            + "\n"
            + r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"끝났습니다."}]}}"#
            + "\n";
        std::fs::write(&p, &body).unwrap();
        let ps = p.to_str().unwrap();
        assert_eq!(last_reply(ps), "끝났습니다.");
        std::fs::write(&p, body.clone() + &SAMPLE[5..].join("\n") + "\n").unwrap();
        assert_eq!(last_reply(ps), "끝났습니다.");
        assert_eq!(
            last_reply(dir.path().join("없음.jsonl").to_str().unwrap()),
            ""
        );
    }

    #[test]
    fn last_reply_reads_only_tail() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let head = r#"{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"앞"}]}}"#;
        let pad = format!(r#"{{"type":"user","x":"{}"}}"#, "z".repeat(600 << 10));
        std::fs::write(&p, format!("{head}\n{pad}\n")).unwrap();
        assert_eq!(last_reply(p.to_str().unwrap()), "");
    }
}
