//! 알림 모양 (FR-TGB-51·52·52a·54·58). Telegram HTML 로 보낸다.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use dm_gocompat::json;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::bridge::Location;

/// 내용 원문의 상한 (FR-TGB-54). UTF-16 단위로 센다 (D-ATF-6).
pub(crate) const CONTENT_MAX: usize = 3500;
/// Telegram 글의 상한 — 엔티티를 푼 뒤의 UTF-16 단위 (D-ATF-6).
pub(crate) const MESSAGE_MAX: usize = 4096;
pub(crate) const CUT_MARK: &str = "…(PC 에서 보기)";
/// 버튼 데이터의 상한(바이트).
const CALLBACK_MAX: usize = 64;
pub(crate) const READ_PREFIX: &str = "r:";
const CELL_SEP: &str = " · ";
/// 접힌 문단에서 위치와 내용을 나누는 줄 (FR-TGB-52).
pub(crate) const DIVIDER: &str = "──────────";

/// Go `html.EscapeString`.
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&#39;"),
            '"' => out.push_str("&#34;"),
            _ => out.push(c),
        }
    }
    out
}

/// [`esc`] 의 역. 알림 본문은 이 모듈이 만든 HTML 이라 그 다섯 엔티티만 나온다.
fn unesc(s: &str) -> String {
    const ENTS: &[(&str, char)] = &[
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&amp;", '&'),
        ("&#39;", '\''),
        ("&#34;", '"'),
    ];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        match ENTS.iter().find(|(e, _)| rest.starts_with(e)) {
            Some((e, c)) => {
                out.push(*c);
                rest = &rest[e.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 기기·윈도우·탭을 한 줄씩 쓴다. 윈도우를 모르면 그 줄을 뺀다 (FR-TGB-52·56).
pub(crate) fn location_lines(l: &Location) -> String {
    let line = |label: &str, name: &str| format!("<code>{label} :</code> <b>{}</b>", esc(name));
    let mut lines = vec![line("Server", &l.device)];
    if !l.window.is_empty() {
        lines.push(line("Window", &l.window));
    }
    lines.push(line("Tab   ", &l.tab));
    lines.join("\n")
}

/// s 의 앞부분 중 limit UTF-16 단위 안에 드는 바이트 길이와 그 단위 수. 글자를 쪼개지 않는다.
fn units_prefix(s: &str, limit: usize) -> (usize, usize) {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let n = c.len_utf16();
        if units + n > limit {
            return (i, units);
        }
        units += n;
    }
    (s.len(), units)
}

/// limit UTF-16 단위를 넘으면 앞부분만 남기고 CUT_MARK 를 붙인다.
pub(crate) fn cut_units(s: &str, limit: usize) -> String {
    let (end, _) = units_prefix(s, limit);
    if end < s.len() {
        format!("{}{CUT_MARK}", &s[..end])
    } else {
        s.to_owned()
    }
}

/// 알림 하나의 내용에 남은 UTF-16 단위. 처음 넘친 자리에 CUT_MARK 를 붙이고 그 뒤는 버린다.
pub(crate) struct Budget {
    left: usize,
    full: bool,
}

impl Budget {
    pub(crate) fn new(left: usize) -> Self {
        Budget { left, full: false }
    }

    pub(crate) fn take(&mut self, s: &str) -> String {
        if self.full {
            return String::new();
        }
        let (end, n) = units_prefix(s, self.left);
        if end < s.len() {
            self.full = true;
            return format!("{}{CUT_MARK}", &s[..end]);
        }
        self.left -= n;
        s.to_owned()
    }

    /// sb 에 take(s) 를 쓰고, 아직 더 실을 수 있는가를 돌려준다.
    fn put(&mut self, sb: &mut String, s: &str) -> bool {
        sb.push_str(&self.take(s));
        !self.full
    }
}

static RE_HTML_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]*>").expect("상수 정규식"));

/// HTML 본문에서 태그를 걷고 이스케이프를 푼 글 — 사용자가 보는 글자 그대로다.
pub(crate) fn plain_text(s: &str) -> String {
    unesc(&RE_HTML_TAG.replace_all(s, ""))
}

/// Telegram 이 세는 길이 — 태그를 걷고 이스케이프를 푼 글의 UTF-16 단위다 (D-ATF-6).
fn text_units(s: &str) -> usize {
    plain_text(s).chars().map(char::len_utf16).sum()
}

/// 알림의 종류 (FR-TGB-51).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AlarmKind {
    pub emoji: &'static str,
    pub label: &'static str,
    pub tool: String,
}

impl AlarmKind {
    pub(crate) const fn new(emoji: &'static str, label: &'static str) -> Self {
        AlarmKind {
            emoji,
            label,
            tool: String::new(),
        }
    }
}

/// 알림의 내용. 남은 단위 안에서 HTML 로 옮긴다.
#[derive(Clone, Debug)]
pub(crate) enum Body {
    None,
    /// 평문.
    Plain(String),
    /// Markdown 응답.
    Reply(String),
    /// 권한 요청의 요약.
    Code(String),
    /// AskUserQuestion 의 입력.
    Question(Vec<u8>),
}

impl Body {
    fn render(&self, b: &mut Budget) -> Option<String> {
        Some(match self {
            Body::None => return None,
            Body::Plain(s) => plain_html(s, b),
            Body::Reply(s) => md_to_html(&b.take(s)),
            Body::Code(s) => code_html(s, b),
            Body::Question(i) => question_html(i, b),
        })
    }
}

/// 알림 전체. 사용자·에이전트 유래 글(도구·위치 이름, 내용)은 HTML 로 옮기기 전에 limit 단위로
/// 잘라 태그가 깨지지 않는다. MESSAGE_MAX 를 넘으면 limit 을 반으로 줄여 다시 만든다 (FR-ATF-40).
pub(crate) fn fit_alarm(k: &AlarmKind, loc: &Location, body: &Body) -> String {
    let mut limit = CONTENT_MAX;
    loop {
        let mut kk = k.clone();
        kk.tool = cut_units(&k.tool, limit);
        let l = Location {
            device: cut_units(&loc.device, limit),
            window: cut_units(&loc.window, limit),
            tab: cut_units(&loc.tab, limit),
        };
        let body_html = body.render(&mut Budget::new(limit)).unwrap_or_default();
        let text = alarm_text(&kk, &l, &body_html);
        if limit == 0 || text_units(&text) <= MESSAGE_MAX {
            return text;
        }
        limit /= 2;
    }
}

/// 위치는 접힌 문단의 머리이고, 내용이 있으면 구분선 아래에 둔다 (FR-TGB-51·52).
pub(crate) fn alarm_text(k: &AlarmKind, loc: &Location, body_html: &str) -> String {
    let mut head = format!("{} <b>{}</b>", k.emoji, k.label);
    if !k.tool.is_empty() {
        head.push_str(" · ");
        head.push_str(&esc(&k.tool));
    }
    let mut quote = location_lines(loc);
    if !body_html.is_empty() {
        quote.push_str("\n\n");
        quote.push_str(DIVIDER);
        quote.push_str("\n\n");
        quote.push_str(body_html);
    }
    format!("{head}\n<blockquote expandable>{quote}</blockquote>")
}

/// `[✓ 읽음]` 버튼. 데이터가 상한을 넘으면 None 이다 (FR-TGB-58).
pub(crate) fn read_keyboard(tool_id: &str) -> Option<Value> {
    let data = format!("{READ_PREFIX}{tool_id}");
    if data.len() > CALLBACK_MAX {
        return None;
    }
    Some(serde_json::json!({"inline_keyboard": [[{"text": "읽음", "callback_data": data}]]}))
}

fn plain_html(s: &str, b: &mut Budget) -> String {
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    esc(&b.take(s))
}

fn code_html(s: &str, b: &mut Budget) -> String {
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    let cut = b.take(s);
    code_lines(&cut.split('\n').collect::<Vec<_>>())
}

/// 여러 줄 코드를 줄마다 `<code>` 로 감싼다. 접힌 문단 안의 `<pre>` 는 상자를 끊으므로 쓰지
/// 않는다 (FR-TGB-52b). 빈 줄은 그대로 둔다.
fn code_lines(lines: &[&str]) -> String {
    lines
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else {
                format!("<code>{}</code>", esc(l))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 권한 요청의 도구 입력 요약. 원문이 없으면 detail 이다.
pub(crate) fn perm_summary(input: &[u8], detail: &str) -> String {
    if input.is_empty() {
        return detail.to_owned();
    }
    let Ok(m) = json::unmarshal::<Option<BTreeMap<String, Value>>>(input) else {
        return detail.to_owned();
    };
    let m = m.unwrap_or_default();
    for k in [
        "command",
        "file_path",
        "notebook_path",
        "path",
        "url",
        "pattern",
    ] {
        if let Some(Value::String(v)) = m.get(k)
            && !v.is_empty()
        {
            return v.clone();
        }
    }
    String::from_utf8_lossy(input).into_owned()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct QOption {
    label: String,
    description: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Question {
    question: String,
    header: String,
    options: Vec<QOption>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Questions {
    questions: Vec<Question>,
}

/// AskUserQuestion 의 질문과 선택지. 읽지 못하면 빈 글이다 (FR-TGB-52). 줄 나눔도 b 에서 센다.
pub(crate) fn question_html(input: &[u8], b: &mut Budget) -> String {
    let Ok(Some(qs)) = json::unmarshal::<Option<Questions>>(input) else {
        return String::new();
    };
    let mut sb = String::new();
    for (i, q) in qs.questions.iter().enumerate() {
        if i > 0 && !b.put(&mut sb, "\n\n") {
            break;
        }
        let mut title = q.question.clone();
        if !q.header.is_empty() {
            title = format!("[{}] {title}", q.header);
        }
        sb.push_str("<b>");
        sb.push_str(&esc(&b.take(&title)));
        sb.push_str("</b>");
        for (j, o) in q.options.iter().enumerate() {
            if !b.put(&mut sb, "\n") {
                break;
            }
            let mut line = format!("{}. {}", j + 1, o.label);
            if !o.description.is_empty() {
                line.push_str(" — ");
                line.push_str(&o.description);
            }
            sb.push_str(&esc(&b.take(&line)));
        }
    }
    sb
}

// Go RE2 의 `\s` 는 [\t\n\f\r ] 다.
static RE_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#{1,6}[\t\n\x0C\r ]+(.*)$").expect("상수 정규식"));
static RE_BULLET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([\t\n\x0C\r ]*)[-*+][\t\n\x0C\r ]+(.*)$").expect("상수 정규식")
});
static RE_RULE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\t\n\x0C\r ]*(-{3,}|\*{3,}|_{3,})[\t\n\x0C\r ]*$").expect("상수 정규식")
});
static RE_TABLE_SP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\t\n\x0C\r ]*\|?[\t\n\x0C\r :|-]+\|?[\t\n\x0C\r ]*$").expect("상수 정규식")
});
static RE_BOLD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*([^*\n]+)\*\*").expect("상수 정규식"));

/// Markdown 을 Telegram HTML 로 옮긴다 (FR-TGB-52a).
pub(crate) fn md_to_html(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fence: Vec<&str> = Vec::new();
    let (mut in_fence, mut in_table) = (false, false);
    for line in md.split('\n') {
        if line.trim().starts_with("```") {
            if in_fence {
                out.push(code_lines(&fence));
                fence.clear();
            }
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            fence.push(line);
            continue;
        }
        let trimmed = line.trim();
        let is_row = trimmed.starts_with('|');
        if is_row && RE_TABLE_SP.is_match(trimmed) {
        } else if is_row {
            let cells = table_cells(trimmed).join(CELL_SEP);
            if in_table {
                out.push(format!("• {cells}"));
            } else {
                out.push(format!("<b>{cells}</b>"));
            }
        } else if RE_RULE.is_match(line) {
        } else {
            out.push(md_line(line));
        }
        in_table = is_row;
    }
    if in_fence {
        out.push(code_lines(&fence));
    }
    squeeze_blank(&out)
}

fn table_cells(row: &str) -> Vec<String> {
    row.trim_matches('|')
        .split('|')
        .map(|p| md_inline(p.trim()))
        .collect()
}

fn md_line(line: &str) -> String {
    if let Some(m) = RE_HEADING.captures(line) {
        return format!("<b>{}</b>", md_inline(&m[1]));
    }
    if let Some(m) = RE_BULLET.captures(line) {
        return format!("{}• {}", &m[1], md_inline(&m[2]));
    }
    if let Some(rest) = line.trim_start_matches(' ').strip_prefix('>') {
        return md_inline(rest.strip_prefix(' ').unwrap_or(rest));
    }
    md_inline(line)
}

/// 한 줄 안의 코드와 굵게. 코드 안은 바꾸지 않는다.
fn md_inline(s: &str) -> String {
    let parts: Vec<&str> = s.split('`').collect();
    let mut sb = String::new();
    for (i, p) in parts.iter().enumerate() {
        if i % 2 == 1 && i < parts.len() - 1 {
            sb.push_str("<code>");
            sb.push_str(&esc(p));
            sb.push_str("</code>");
        } else if i % 2 == 1 {
            sb.push_str(&esc(&format!("`{p}")));
        } else {
            sb.push_str(&RE_BOLD.replace_all(&esc(p), "<b>$1</b>"));
        }
    }
    sb
}

/// 이어진 빈 줄을 하나로 줄이고 앞뒤 빈 줄을 걷는다.
fn squeeze_blank(lines: &[String]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for l in lines {
        let blank = l.trim().is_empty();
        if blank && out.last().is_none_or(|p| p.is_empty()) {
            continue;
        }
        out.push(if blank { "" } else { l });
    }
    while out.last() == Some(&"") {
        out.pop();
    }
    out.join("\n")
}

#[cfg(test)]
pub(crate) mod tests;
