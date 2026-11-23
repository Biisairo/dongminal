//! Go 기준선 `dongminal/internal/ctl/errdoc` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 오류 코드 문서(`docs/errors.md` 꼴)를 apierr 의 코드 목록과 안내에서 만든다.

use dm_webserver_apierr as apierr;

/// 문서의 머리말이다. 코드 표는 이 뒤에 붙는다.
pub const HEADER: &str = r#"<!-- 이 파일은 생성물입니다. 직접 고치지 마세요.
     원천: internal/webserver/apierr/codes_doc.go
     생성: dongminal 저장소에서 `go run ./scripts/gen-errors`
     검사: scripts/check-error-docs.sh (CI) -->

# 오류 코드

이 서버가 낼 수 있는 오류 코드 전부입니다.

## 어디서 받나요

모든 오류 응답에 코드가 `X-Error-Code` **헤더**로 실립니다. 본문의 모양은
표면마다 다르지만(아래 *방언*), 헤더는 어디서나 같습니다 — 그래서 분기는 헤더로
하세요.

함께 실리는 `X-Request-Id` 는 그 요청 하나의 식별자입니다. 신고할 때 이
값을 적어 주시면 서버 로그에서 그 요청이 남긴 줄 전부를 찾을 수 있습니다.

## 본문의 모양 — 방언 다섯

본문 형식은 표면마다 다르고 **각각이 공개 계약**이라 통일하지 않습니다.
코드로 분기하려면 본문이 아니라 헤더를 보세요.

| 방언 | 본문 | 쓰는 곳 |
|---|---|---|
| git | `{"error": <코드>, "message": <tail>}` | `/api/git/*` |
| fs | `{"code": <코드>, "message": <msg>}` | `/api/fs/*` · `/api/editors/*` · 노드 포트의 `/edge/v1/*` · `/api/edges/*` · `/api/telegram/*` |
| runs | `{"error": <코드>, "detail": <err>}` | `/api/runs/*` |
| 단문 | `{"error": <문구>}` | `/api/tools/{output,input,message}` · `/api/whoami` |
| 평문 | `text/plain` 한 줄 | 그 밖의 `/api/*` |

## 코드
"#;

/// 문서 전체. 안내가 빠진 코드가 있으면 그 목록을 오류로 돌려준다.
pub fn render() -> Result<String, String> {
    let mut codes = apierr::all_codes();
    codes.sort_unstable();
    let missing: Vec<&str> = codes
        .iter()
        .copied()
        .filter(|c| {
            apierr::code_doc(c).is_none_or(|d| d.meaning.is_empty() || d.recover.is_empty())
        })
        .collect();
    if !missing.is_empty() {
        return Err(missing_docs(&missing));
    }
    let mut b = String::from(HEADER);
    b.push_str("\n| 코드 | 의미 | 다음에 할 일 |\n|---|---|---|\n");
    for c in &codes {
        let d = apierr::code_doc(c).unwrap_or(apierr::Doc {
            meaning: "",
            recover: "",
        });
        b.push_str(&format!(
            "| `{c}` | {} | {} |\n",
            cell(d.meaning),
            cell(d.recover)
        ));
    }
    b.push_str(&format!("\n총 **{}개**.\n", codes.len()));
    Ok(b)
}

/// 안내가 빠진 코드의 오류 문구다. 고칠 자리는 Rust 의 원천(apierr 의 코드 안내)을 가리킨다 — Go 는
/// `codes_doc.go` 를 가리켰다 (DIFF-30).
fn missing_docs(missing: &[&str]) -> String {
    format!(
        "안내가 없는 코드 {}개: {}\n  apierr 의 코드 안내(code_doc) 에 의미와 복구 안내를 적으세요",
        missing.len(),
        missing.join(", ")
    )
}

fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_docs_points_at_rust_source() {
        assert_eq!(
            super::missing_docs(&["a", "b"]),
            "안내가 없는 코드 2개: a, b\n  apierr 의 코드 안내(code_doc) 에 의미와 복구 안내를 적으세요"
        );
    }

    /// go1.27.2 의 `errdoc.Render()` 출력과 바이트 단위로 같다.
    #[test]
    fn render_matches_go_golden() {
        let want = include_str!("../testdata/errors.md");
        assert_eq!(render().unwrap(), want);
    }
}
