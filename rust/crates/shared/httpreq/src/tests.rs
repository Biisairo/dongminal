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
