use super::*;
use http_body_util::{Full, StreamBody};

fn body(s: &str) -> Full<Bytes> {
    Full::new(Bytes::from(s.to_owned()))
}

#[tokio::test]
async fn reads_within_limit() {
    let got = read(body(r#"{"a":"x"}"#), 0).await.unwrap();
    assert_eq!(&got[..], br#"{"a":"x"}"#);
}

#[tokio::test]
async fn empty_body_is_empty() {
    assert!(read(body(""), 0).await.unwrap().is_empty());
}

#[tokio::test]
async fn exact_limit_passes_one_more_fails() {
    let s = "x".repeat(16);
    assert_eq!(read(body(&s), 16).await.unwrap().len(), 16);
    let s = "x".repeat(17);
    assert!(matches!(read(body(&s), 16).await, Err(ReadError::TooLarge)));
}

#[tokio::test]
async fn too_large() {
    let s = format!(r#"{{"a":"{}"}}"#, "x".repeat(64));
    let err = read(body(&s), 16).await.unwrap_err();
    assert!(matches!(err, ReadError::TooLarge));
    assert_eq!(err.to_string(), "본문이 상한을 넘었다");
    assert_eq!(status(&err), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn non_positive_limit_is_default() {
    let s = "x".repeat(DEFAULT_LIMIT as usize);
    assert_eq!(
        read(body(&s), -1).await.unwrap().len(),
        DEFAULT_LIMIT as usize
    );
    let s = "x".repeat(DEFAULT_LIMIT as usize + 1);
    assert!(matches!(read(body(&s), 0).await, Err(ReadError::TooLarge)));
}

#[tokio::test]
async fn other_error_is_400() {
    let frames: Vec<Result<hyper::body::Frame<Bytes>, std::io::Error>> =
        vec![Err(std::io::Error::other("unexpected EOF"))];
    let b = StreamBody::new(futures_util::stream::iter(frames));
    let err = read(b, 0).await.unwrap_err();
    assert!(matches!(err, ReadError::Other(_)));
    assert_eq!(err.to_string(), "unexpected EOF");
    assert_eq!(status(&err), StatusCode::BAD_REQUEST);
}

#[test]
fn mark_response_sets_connection_close_only_when_too_large() {
    let mut res = http::Response::new(());
    mark_response(&ReadError::Other("x".into()), &mut res);
    assert!(res.headers().get("connection").is_none());
    mark_response(&ReadError::TooLarge, &mut res);
    assert_eq!(res.headers()["connection"], "close");
}

// FR-RDG-6: 64 KiB 는 이름 하나다.
#[test]
fn limits() {
    assert_eq!(SMALL_LIMIT, 64 << 10);
    assert_eq!(DEFAULT_LIMIT, 1 << 20);
    assert_eq!(WORKSPACE_LIMIT, 8 << 20);
}

#[derive(serde::Deserialize, Default, Debug)]
#[serde(default)]
struct A {
    a: String,
}

// TC-RDG-3: decode_json — 정상 · 빈 본문(두 선택) · 상한 초과 · 깨진 JSON (FR-RDG-5).
#[tokio::test]
async fn decode_json_cases() {
    let v: A = decode_json(body(r#"{"a":"x"}"#), 0, Empty::NotJson)
        .await
        .unwrap();
    assert_eq!(v.a, "x");

    let e = decode_json::<A, _>(body(""), 0, Empty::NotJson)
        .await
        .unwrap_err();
    assert!(matches!(e, DecodeError::NotJson(_)));
    assert_eq!(e.status(), StatusCode::BAD_REQUEST);

    let v: A = decode_json(body(""), 0, Empty::AsObject).await.unwrap();
    assert_eq!(v.a, "");

    let big = format!(r#"{{"a":"{}"}}"#, "x".repeat(64));
    let e = decode_json::<A, _>(body(&big), 16, Empty::NotJson)
        .await
        .unwrap_err();
    assert!(matches!(e, DecodeError::Read(ReadError::TooLarge)));
    assert_eq!(e.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let e = decode_json::<A, _>(body("{"), 0, Empty::AsObject)
        .await
        .unwrap_err();
    assert!(matches!(e, DecodeError::NotJson(_)));
}

#[derive(serde::Deserialize, Default)]
#[serde(default, rename = "httpreq.deleteReq")]
struct DeleteReq {
    #[allow(dead_code)]
    paths: Option<Vec<String>>,
    #[allow(dead_code)]
    inner: Inner,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct Inner {
    #[allow(dead_code)]
    n: i64,
}

fn decode_err(s: &str) -> DecodeError {
    DecodeError::NotJson(
        dm_gocompat::json::unmarshal::<DeleteReq>(s.as_bytes())
            .err()
            .expect("오류여야 한다"),
    )
}

// QUALITY_GO_SRS TC-QG-2: reason 은 요청 자리만 말한다 (FR-QG-1·2).
#[test]
fn reason_cases() {
    let cases = [
        (decode_err(r#"{"paths":1}"#), "paths: number 값은 맞지 않다"),
        (
            decode_err(r#"{"inner":{"n":"x"}}"#),
            "inner.n: string 값은 맞지 않다",
        ),
        (decode_err("[1]"), "array 값은 맞지 않다"),
        (decode_err("{"), "unexpected end of JSON input"),
        (
            decode_err("{x}"),
            "invalid character 'x' looking for beginning of object key string",
        ),
        (
            DecodeError::Read(ReadError::TooLarge),
            "본문이 상한을 넘었다",
        ),
        (
            DecodeError::Read(ReadError::Other(
                "read tcp 10.0.0.1:1->10.0.0.2:2: i/o timeout".into(),
            )),
            "",
        ),
    ];
    for (err, want) in cases {
        let got = reason(&err);
        assert_eq!(got, want, "{err}");
        for leak in ["deleteReq", "[]string", "Go struct", "Go value", "httpreq."] {
            assert!(!got.contains(leak), "reason 에 {leak:?} 가 샌다: {got:?}");
        }
    }
}

// FR-QG-1·3: message 는 고정 문구에 요청 자리를 잇는다.
#[test]
fn message_cases() {
    assert_eq!(
        message(
            None,
            "POST",
            "/api/fs/delete",
            "본문이 JSON 이 아니다",
            &decode_err(r#"{"paths":1}"#)
        ),
        "본문이 JSON 이 아니다: paths: number 값은 맞지 않다"
    );
    assert_eq!(
        message(
            None,
            "POST",
            "/api/fs/delete",
            "본문을 읽지 못했다",
            &DecodeError::Read(ReadError::Other("boom".into()))
        ),
        "본문을 읽지 못했다"
    );
}
