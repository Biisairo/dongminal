//! Go `bridge_test.go`(Markdown·위치)·`render_limit_test.go`(자르기) 의 렌더 검사.

use super::*;

pub(crate) fn check_tags(text: &str) {
    let allowed = [
        "<b>",
        "</b>",
        "<code>",
        "</code>",
        "<blockquote expandable>",
        "</blockquote>",
    ];
    for m in RE_HTML_TAG.find_iter(text) {
        assert!(
            allowed.contains(&m.as_str()),
            "허용 목록 밖의 태그 {}: {text}",
            m.as_str()
        );
    }
    assert_eq!(text.matches("<blockquote").count(), 1, "{text}");
    assert_eq!(text.matches("</blockquote>").count(), 1, "{text}");
    assert!(text.ends_with("</blockquote>"), "{text}");
}

#[test]
fn location_lines_shape() {
    let l = Location {
        device: "d".into(),
        window: "w".into(),
        tab: "t".into(),
    };
    assert_eq!(
        location_lines(&l),
        "<code>Server :</code> <b>d</b>\n<code>Window :</code> <b>w</b>\n<code>Tab    :</code> <b>t</b>"
    );
    let l = Location {
        device: "<d>".into(),
        window: String::new(),
        tab: "t&".into(),
    };
    assert_eq!(
        location_lines(&l),
        "<code>Server :</code> <b>&lt;d&gt;</b>\n<code>Tab    :</code> <b>t&amp;</b>"
    );
}

#[test]
fn markdown_to_html() {
    let cases = [
        ("제목", "## 바뀐 <것>", "<b>바뀐 &lt;것&gt;</b>"),
        ("목록", "- 하나\n  * 둘", "• 하나\n  • 둘"),
        (
            "굵게·코드",
            "**굵게** 와 `a**b**` & c",
            "<b>굵게</b> 와 <code>a**b**</code> &amp; c",
        ),
        (
            "울타리",
            "앞\n```go\nx := 1 < 2\n\n  y()\n```\n뒤",
            "앞\n<code>x := 1 &lt; 2</code>\n\n<code>  y()</code>\n뒤",
        ),
        ("닫히지 않은 울타리", "```\nfoo", "<code>foo</code>"),
        (
            "표",
            "| 이름 | 값 |\n|---|:--:|\n| a | **b** |",
            "<b>이름 · 값</b>\n• a · <b>b</b>",
        ),
        ("인용", "> 주의", "주의"),
        ("가로줄·빈 줄", "a\n---\n\n\n\nb", "a\n\nb"),
        ("홀수 백틱", "a `b", "a `b"),
        ("따옴표", "it's \"q\"", "it&#39;s &#34;q&#34;"),
    ];
    for (name, input, want) in cases {
        let got = md_to_html(input);
        assert_eq!(got, want, "{name}");
        let loc = Location {
            device: "d".into(),
            window: String::new(),
            tab: "t".into(),
        };
        check_tags(&alarm_text(&AlarmKind::new("✅", "완료"), &loc, &got));
    }
}

#[test]
fn cut_units_cases() {
    let cases = [
        ("안", "가나", 2, "가나".to_owned()),
        ("넘침", "가나다", 2, format!("가나{CUT_MARK}")),
        ("이모지 경계", "😀😀😀", 4, format!("😀😀{CUT_MARK}")),
        ("이모지 반쪽", "😀😀", 3, format!("😀{CUT_MARK}")),
        ("0", "a", 0, CUT_MARK.to_owned()),
        ("빈 글", "", 0, String::new()),
    ];
    for (name, input, limit, want) in cases {
        assert_eq!(cut_units(input, limit), want, "{name}");
    }
}

#[test]
fn question_html_budget() {
    let input = r#"{"questions":[{"question":"가나","options":[{"label":"a"},{"label":"b"}]},{"question":"다"}]}"#.as_bytes();
    assert_eq!(
        question_html(input, &mut Budget::new(CONTENT_MAX)),
        "<b>가나</b>\n1. a\n2. b\n\n<b>다</b>"
    );
    // 가나(2) + \n(1) + "1. a"(4) = 7, 다음 \n 에서 넘친다.
    assert_eq!(
        question_html(input, &mut Budget::new(7)),
        format!("<b>가나</b>\n1. a{CUT_MARK}")
    );
    assert_eq!(question_html(b"", &mut Budget::new(10)), "");
    assert_eq!(question_html(b"null", &mut Budget::new(10)), "");
}

#[test]
fn perm_summary_rules() {
    assert_eq!(perm_summary(br#"{"command":"ls"}"#, "d"), "ls");
    assert_eq!(perm_summary(br#"{"path":"","url":"u"}"#, "d"), "u");
    assert_eq!(perm_summary(br#"{"x":1}"#, "d"), r#"{"x":1}"#);
    assert_eq!(perm_summary(b"", "d"), "d");
    assert_eq!(perm_summary(b"[1]", "d"), "d");
    assert_eq!(perm_summary(b"null", "d"), "null");
}

#[test]
fn plain_text_unescapes_once() {
    assert_eq!(plain_text("<b>a &amp;lt; b</b> &#39;&#34;"), "a &lt; b '\"");
    assert_eq!(esc("<>&'\""), "&lt;&gt;&amp;&#39;&#34;");
}
