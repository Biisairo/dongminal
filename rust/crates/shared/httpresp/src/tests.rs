use super::*;
use http_body_util::BodyExt;

async fn parts(res: Response) -> (u16, http::HeaderMap, String) {
    let (p, body) = res.into_parts();
    let b = body.collect().await.unwrap().to_bytes();
    (
        p.status.as_u16(),
        p.headers,
        String::from_utf8(b.to_vec()).unwrap(),
    )
}

fn h<'a>(m: &'a http::HeaderMap, k: &str) -> &'a str {
    m.get(k).map(|v| v.to_str().unwrap()).unwrap_or("")
}

// 종전 인라인 Encoder 와 같은 바이트: 끝 개행·HTML 이스케이프 (FR-OPT-0-3).
#[tokio::test]
async fn json_matches_inline_encoder() {
    let v = serde_json::json!({"a": "<&>", "n": 1});
    let (code, hd, body) = parts(json(StatusCode::OK, &v)).await;
    assert_eq!(code, 200);
    assert_eq!(body, "{\"a\":\"\\u003c\\u0026\\u003e\",\"n\":1}\n");
    assert_eq!(h(&hd, "content-type"), "application/json");
    assert_eq!(hd.len(), 1);
}

#[tokio::test]
async fn json_writes_status() {
    let mut m = std::collections::BTreeMap::new();
    m.insert("error", "x");
    let (code, _, body) = parts(json(StatusCode::CONFLICT, &m)).await;
    assert_eq!((code, body.as_str()), (409, "{\"error\":\"x\"}\n"));
}

// FR-RDG-2: JSON 방언은 코드 헤더 + json 과 같은 바이트다.
#[tokio::test]
async fn fail_json_matches_inline() {
    let v = serde_json::json!({"error": "<x>", "n": 1});
    let (code, hd, body) = parts(fail_json(StatusCode::CONFLICT, "c", &v)).await;
    assert_eq!(code, 409);
    assert_eq!(body, "{\"error\":\"\\u003cx\\u003e\",\"n\":1}\n");
    assert_eq!(h(&hd, CODE_HEADER), "c");
    assert_eq!(h(&hd, "content-type"), "application/json");
    assert_eq!(hd.len(), 2);
}

// 평문 방언은 `http.Error` 와 바이트가 같다.
#[tokio::test]
async fn fail_text_matches_http_error() {
    let (code, hd, body) = parts(fail_text(
        StatusCode::BAD_REQUEST,
        "bad_request",
        "read body",
    ))
    .await;
    assert_eq!(code, 400);
    assert_eq!(body, "read body\n");
    assert_eq!(h(&hd, CODE_HEADER), "bad_request");
    assert_eq!(h(&hd, "content-type"), "text/plain; charset=utf-8");
    assert_eq!(h(&hd, "x-content-type-options"), "nosniff");
    assert_eq!(hd.len(), 3);
}

// 미리 직렬화한 본문은 그대로 나간다 — 끝 개행을 붙이지 않는다.
#[tokio::test]
async fn fail_raw_writes_bytes() {
    let raw = r#"{"code":"edge_not_edge","message":"x"}"#;
    let (code, hd, body) = parts(fail_raw(StatusCode::FORBIDDEN, "edge_not_edge", raw)).await;
    assert_eq!((code, body.as_str()), (403, raw));
    assert_eq!(h(&hd, CODE_HEADER), "edge_not_edge");
    assert_eq!(h(&hd, "content-type"), "application/json");
}

// `{code,message}` 방언 (FR-RDG-4).
#[tokio::test]
async fn fail_code_body() {
    let (code, hd, body) = parts(fail_code(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "invalid json",
    ))
    .await;
    assert_eq!(code, 400);
    assert_eq!(
        body,
        "{\"code\":\"invalid_json\",\"message\":\"invalid json\"}\n"
    );
    assert_eq!(h(&hd, CODE_HEADER), "invalid_json");
    assert_eq!(h(&hd, "content-type"), "application/json");
}

#[tokio::test]
async fn fail_code_escapes_html() {
    let (_, _, body) = parts(fail_code(StatusCode::NOT_FOUND, "x", "<a&b>")).await;
    assert_eq!(
        body,
        "{\"code\":\"x\",\"message\":\"\\u003ca\\u0026b\\u003e\"}\n"
    );
}

struct Unencodable;

impl Serialize for Unencodable {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("no"))
    }
}

// 인코딩 실패: Go `json.Encoder.Encode` 는 아무것도 쓰지 않는다 — 상태·헤더만 나간다.
#[tokio::test]
async fn json_encode_failure_writes_empty_body() {
    let (code, hd, body) = parts(json(StatusCode::OK, &Unencodable)).await;
    assert_eq!((code, body.as_str()), (200, ""));
    assert_eq!(h(&hd, "content-type"), "application/json");
}

#[test]
fn code_header_name() {
    assert_eq!(CODE_HEADER, "X-Error-Code");
}

// TC-RDG-2: 헤더 이름 리터럴은 이 crate 밖의 비시험 코드에 없다 (FR-RDG-1).
#[test]
fn code_header_literal_only_here() {
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let crates = here.parent().and_then(|p| p.parent()).unwrap();
    let lit = format!("\"{CODE_HEADER}\"");
    let mut hits = Vec::new();
    let mut stack = vec![crates.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                if p != here && p.file_name().is_some_and(|n| n != "tests" && n != "target") {
                    stack.push(p);
                }
                continue;
            }
            if p.extension().is_none_or(|x| x != "rs")
                || p.file_name().is_some_and(|n| n == "tests.rs")
            {
                continue;
            }
            if std::fs::read_to_string(&p).unwrap().contains(&lit) {
                hits.push(p);
            }
        }
    }
    assert!(
        hits.is_empty(),
        "X-Error-Code 리터럴이 httpresp 밖에 있다: {hits:?}"
    );
}
