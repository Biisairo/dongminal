//! Go 기준선 `dongminal/internal/ctl/decidx` 의 Rust 포팅.
//!
//! SRS 에 흩어진 **결정**을 색인한다 (M5 `G8-1`, ADR-lite). 원문은 SRS 에 그대로 두고
//! 색인(`docs/internal/decisions.md`)만 만든다.

use std::collections::{BTreeSet, HashSet};
use std::fmt::Write;
use std::io::{self, Read};
use std::path::Path;
use std::sync::LazyLock;

use dm_gocompat::oserr::path_error;
use regex::Regex;

/// 결정 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub why: String,
    /// SRS 파일 이름.
    pub source: String,
    pub status: String,
}

/// 결정 번호의 꼴이다. 끝의 소문자 하나는 **정정 판**이다 (`D-8b`·`D-WRD-9a`).
const ID_PAT: &str = r"(D-[A-Z0-9]+(?:-[0-9]+)?[a-z]?)";
/// Go RE2 의 `\s` 는 ASCII 공백 넷과 스페이스다(`\v` 는 아니다). Rust `\s` 는 유니코드라 풀어 쓴다.
const WS: &str = r"[\t\n\f\r ]";

fn re(p: &str) -> Regex {
    // 패턴은 이 파일의 상수에서만 만든다 — 실패하면 시험이 잡는다.
    Regex::new(p).unwrap_or_else(|e| panic!("decidx 패턴: {e}"))
}

/// 표 행: `| **D-CFG-1** | 제목 | 근거 |`.
static ROW_RE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^\|{WS}*\*{{0,2}}{ID_PAT}\*{{0,2}}{WS}*\|(.*)$")));
/// 굵은 머리: `**D-CAF-1: 제목**` · `**D-CAF-1** 제목` · `- **D-1. 제목**` (FR-DSY-10).
static HEAD_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^(?:[-*+]{WS}+)?\*\*{ID_PAT}(?:[.:：]|\*|{WS})(.*)$"
    ))
});
/// 굵은 span 안쪽: `- **D-X 제목.** 그 뒤의 근거` 에서 제목만 든다.
static SPAN_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^(?:[-*+]{WS}+)?\*\*{ID_PAT}(?:[.:：]?{WS}+([^*]*?){WS}*)?\*\*"
    ))
});
/// 취소선으로 철회 표기한 것.
static STRUCK_RE: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"~~{WS}*\*{{0,2}}{ID_PAT}")));

/// `dir` 아래 `*_SRS.md` 전부에서 결정을 모은다. 디렉터리를 읽을 수 없으면 Go
/// `filepath.Glob` 처럼 빈 결과다.
pub fn collect(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut paths = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.ends_with("_SRS.md") {
                paths.push((
                    dir.join(name).to_string_lossy().into_owned(),
                    name.to_owned(),
                ));
            }
        }
    }
    paths.sort();

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (path, name) in paths {
        let data = read_file(&path)?;
        let text = String::from_utf8_lossy(&data);
        let struck: BTreeSet<&str> = STRUCK_RE
            .captures_iter(&text)
            .filter_map(|c| c.get(1).map(|m| m.as_str()))
            .collect();
        for line in text.split('\n') {
            let Some(mut e) = parse_line(line) else {
                continue;
            };
            e.source = name.clone();
            // 같은 ID 가 여러 문서에 있다 — 출처로 갈라 준다.
            if !seen.insert(format!("{name}/{}", e.id)) {
                continue;
            }
            if struck.contains(e.id.as_str()) {
                e.status = "철회".to_owned();
            }
            out.push(e);
        }
    }
    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| id_cmp(&a.id, &b.id)));
    Ok(out)
}

fn adopted(id: &str, title: String) -> Entry {
    Entry {
        id: id.to_owned(),
        title,
        status: "채택".to_owned(),
        ..Default::default()
    }
}

fn group<'a>(c: &regex::Captures<'a>, i: usize) -> &'a str {
    c.get(i).map_or("", |m| m.as_str())
}

/// 한 줄에서 결정을 읽는다.
fn parse_line(line: &str) -> Option<Entry> {
    let t = line.trim();
    if t.starts_with("|---") || t.starts_with("| ---") {
        return None;
    }
    if let Some(m) = ROW_RE.captures(t) {
        let cells = split_cells(group(&m, 2));
        let mut e = adopted(group(&m, 1), cells.first().cloned().unwrap_or_default());
        if let Some(w) = cells.get(1) {
            e.why = w.clone();
        }
        if e.title.is_empty() {
            return None;
        }
        return Some(e);
    }
    if let Some(m) = SPAN_RE.captures(t)
        && !group(&m, 2).is_empty()
    {
        let mut title = balance_bold(group(&m, 2).trim());
        if !ends_sentence(&title) {
            title.push('…');
        }
        return Some(adopted(group(&m, 1), title));
    }
    if let Some(m) = HEAD_RE.captures(t) {
        let trimmed = group(&m, 2).trim_matches(|c| matches!(c, '*' | ':' | ' ' | '　'));
        let mut title = balance_bold(trimmed.trim());
        if title.is_empty() {
            return None;
        }
        // 자유 서술형 결정은 여러 줄로 이어진다 — 잘렸다는 사실이 보이게 한다.
        if !ends_sentence(&title) {
            title.push('…');
        }
        return Some(adopted(group(&m, 1), title));
    }
    None
}

/// 짝이 맞지 않는 굵은 글씨 표시를 닫는다.
fn balance_bold(s: &str) -> String {
    if s.matches("**").count() % 2 == 1 {
        format!("{s}**")
    } else {
        s.to_owned()
    }
}

/// 줄이 문장으로 끝났는지 본다.
fn ends_sentence(s: &str) -> bool {
    let Some(last) = s.chars().last() else {
        return true;
    };
    if matches!(last, '.' | '!' | '?' | ')' | ']' | '»' | '」' | '”' | ':') {
        return true;
    }
    s.ends_with('다') || s.ends_with('음') || s.ends_with('함')
}

fn split_cells(rest: &str) -> Vec<String> {
    let rest = rest.trim();
    let rest = rest.strip_suffix('|').unwrap_or(rest);
    rest.split('|').map(|c| c.trim().to_owned()).collect()
}

/// `D-X-2` 가 `D-X-10` 보다 앞서게 한다.
fn id_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, na) = split_id(a);
    let (pb, nb) = split_id(b);
    pa.cmp(pb).then(na.cmp(&nb))
}

/// Go `strconv.Atoi` 처럼 부호를 받고, 실패하면 `(s, 0)` 이다.
fn split_id(s: &str) -> (&str, i64) {
    let Some(i) = s.rfind('-') else {
        return (s, 0);
    };
    match s[i + 1..].parse::<i64>() {
        Ok(n) => (&s[..i], n),
        Err(_) => (s, 0),
    }
}

/// 저장소 뿌리에서 색인을 다시 만드는 명령이다.
pub const GENERATE: &str =
    "cargo run -q --manifest-path rust/Cargo.toml -p dm-scripts-gen-decisions";

const HEADER: &str = "<!-- 이 파일은 생성물입니다. 직접 고치지 마세요.
     원천: docs/internal/*_SRS.md 의 결정 항목
     생성: dongminal 저장소에서 `cargo run -q --manifest-path rust/Cargo.toml -p dm-scripts-gen-decisions`
     검사: scripts/check-decisions.sh (CI) -->

# 결정 색인 (ADR-lite)

이 저장소는 결정을 **그것을 낳은 요구 옆에** 적습니다 — SRS 안입니다. 옳은
자리이지만 찾는 길이 없었습니다: \"우리가 왜 이렇게 했더라\" 를 물으면 문서
백여 개를 뒤져야 했고, 그래서 같은 결정이 두 번 논의됐습니다.

이 문서가 그 길입니다. **원문을 옮기지 않습니다** — 근거가 요구에서 떨어지면
결정은 맥락 없는 문장이 되기 때문입니다. 여기 있는 것은 제목과 링크뿐이고,
읽을 것은 저쪽입니다.

## 상태

| 값 | 뜻 |
|---|---|
| 채택 | 지금 코드가 이것을 따릅니다 |
| 철회 | 뒤집혔습니다. 원문에 취소선과 대체 항목이 적혀 있습니다 |

";

/// 색인 문서를 만든다.
pub fn render(entries: &[Entry]) -> String {
    let mut b = String::from(HEADER);
    let mut cur: Option<&str> = None;
    for e in entries {
        if cur != Some(e.source.as_str()) {
            cur = Some(e.source.as_str());
            let stem = e.source.strip_suffix(".md").unwrap_or(&e.source);
            let _ = write!(
                b,
                "\n## [`{stem}`](./{})\n\n| ID | 결정 | 근거 | 상태 |\n|---|---|---|---|\n",
                e.source
            );
        }
        let _ = writeln!(
            b,
            "| `{}` | {} | {} | {} |",
            e.id,
            cell(&e.title),
            cell(&e.why),
            e.status
        );
    }
    let sources: HashSet<&str> = entries.iter().map(|e| e.source.as_str()).collect();
    let _ = write!(
        b,
        "\n---\n\n결정 **{}건** · 문서 **{}개**.\n",
        entries.len(),
        sources.len()
    );
    b
}

/// 표 칸에 들어갈 수 없는 글자를 피한다. 너무 길면(140자 초과) 자른다.
fn cell(s: &str) -> String {
    const MAX: usize = 140;
    let s = s.replace('|', r"\|").replace('\n', " ");
    if s.chars().count() > MAX {
        let mut t: String = s.chars().take(MAX).collect();
        t.push('…');
        return t;
    }
    s
}

/// Go `os.ReadFile`: 실패는 `open <경로>: …`·`read <경로>: …` 다.
fn read_file(path: &str) -> io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path).map_err(|e| path_error("open", path, e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| path_error("read", path, e))?;
    Ok(buf)
}

#[cfg(test)]
mod tests;
