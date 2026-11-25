//! 묶음 JS 주석 걷기 (PERF_OPTIMIZATION_SRS D-35, perf 이슈 3.4.10).
//! 주석과 줄 끝 공백만 걷는다. 줄바꿈·들여쓰기·문자열·정규식·템플릿은 그대로다.

use crate::js_strip::strip_comments;

fn strip(s: &str) -> String {
    String::from_utf8(strip_comments(s.as_bytes())).unwrap()
}

fn lines(s: &str) -> usize {
    s.split('\n').count()
}

#[test]
fn line_comment_goes_and_trailing_space_before_it() {
    assert_eq!(strip("a = 1; // 끝\nb = 2;\n"), "a = 1;\nb = 2;\n");
}

#[test]
fn block_comment_keeps_its_newlines() {
    let src = "/**\n * 설명\n */\nfunction f() {}\n";
    let out = strip(src);
    assert_eq!(out, "\n\n\nfunction f() {}\n");
    assert_eq!(lines(out.as_str()), lines(src));
}

#[test]
fn indentation_is_kept() {
    assert_eq!(
        strip("  if (a) {\n    // 왜\n    b();\n  }\n"),
        "  if (a) {\n\n    b();\n  }\n"
    );
}

#[test]
fn inline_block_comment_never_joins_tokens() {
    assert_eq!(strip("return/**/x;\n"), "return x;\n");
    assert_eq!(strip("f(a /* 첫 */, b);\n"), "f(a , b);\n");
}

#[test]
fn trailing_whitespace_goes_outside_templates() {
    assert_eq!(strip("a();  \t\nb();\t\n"), "a();\nb();\n");
    assert_eq!(strip("a();  \r\nb();\r\n"), "a();\r\nb();\r\n");
}

#[test]
fn license_comment_stays() {
    let src = "/*! (c) 누군가 | BSD */\nvar x = 1;\n";
    assert_eq!(strip(src), src);
}

#[test]
fn comment_shapes_inside_strings_stay() {
    let src = "var a = '// 아님', b = \"/* 아님 */\", c = 'it\\'s // 아님';\n";
    assert_eq!(strip(src), src);
}

#[test]
fn comment_shapes_inside_regex_stay() {
    for src in [
        "var r = /\\/\\/+/g;\n",
        "var r = /[/*]+/;\n",
        "if (/^https?:\\/\\//.test(u)) go();\n",
        "s = s.replace(/\\/\\*.*?\\*\\//g, '');\n",
        "return /a\\/b/.source;\n",
        "x = (a) => /\\/*/.test(a);\n",
    ] {
        assert_eq!(strip(src), src, "{src}");
    }
}

#[test]
fn division_is_not_a_regex() {
    assert_eq!(strip("x = a / b / c; // 나눔\n"), "x = a / b / c;\n");
    assert_eq!(strip("x = f(a) / 2 /* 반 */;\n"), "x = f(a) / 2 ;\n");
    assert_eq!(strip("x = a[0] / n[1]; // 비\n"), "x = a[0] / n[1];\n");
    assert_eq!(strip("i++ / 2; // 뒤\n"), "i++ / 2;\n");
}

#[test]
fn comment_shapes_and_trailing_space_inside_templates_stay() {
    let src = "var t = `a // 아님  \n  /* 아님 */  \n`;\n";
    assert_eq!(strip(src), src);
}

#[test]
fn template_expressions_are_code_and_nest() {
    let src = "var t = `x${a /* 걷음 */ + `y${ {k: 1}.k // 걷음\n}` }// 아님 ${'/*'}`;\n";
    let out = strip(src);
    assert_eq!(
        out,
        "var t = `x${a  + `y${ {k: 1}.k\n}` }// 아님 ${'/*'}`;\n"
    );
}

#[test]
fn regex_after_keyword_and_punctuator() {
    let src = "if (x) return /\\/\\//.test(s); // 꼬리\n";
    assert_eq!(strip(src), "if (x) return /\\/\\//.test(s);\n");
    assert_eq!(strip("a = [/\\/*/];\n"), "a = [/\\/*/];\n");
}

#[test]
fn no_comment_no_change() {
    let src = "/* ==== js/a.js ==== */\nA1\n";
    assert_eq!(strip("A1\nA2\n"), "A1\nA2\n");
    assert_eq!(strip(src), "\nA1\n");
}

#[test]
fn unterminated_input_does_not_panic() {
    for src in ["'abc\\", "/[a", "`x${", "/* 끝없음", "a = '\\"] {
        let _ = strip(src);
    }
}
