//! 정적 자산 `/` 의 Go 대조. go1.27.2 의 실제 핸들러(`New(...).Handler()` + `fstest.MapFS`)가 같은
//! 요청에 낸 상태·머리·본문을 `go_golden_558a.txt` 로 고정했다. 사전압축 자산의 바이트는 Go `gzip` 이
//! 만든 것을 파일 머리(`#gz`·`#both`)에서 읽는다. 여러 구간 요청(경계가 무작위)은 따로 시험한다.
//!
//! Go 와 갈라진 곳(perf 3.4.13): `.js`·`.css` 파일 응답에는 `Vary: Accept-Encoding`·`Content-Type` 이
//! 붙고, gzip 을 밝힌 요청(`/both.js`)에는 서버가 압축한 원본 파일이 나간다.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};

use super::statics::{MapFs, static_server};
use super::support::LOCAL;
use crate::Server;

const GOLDEN: &str = include_str!("go_golden_558a.txt");

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn header_line(name: &str) -> Vec<u8> {
    let line = GOLDEN
        .lines()
        .find_map(|l| l.strip_prefix(&format!("#{name} ")))
        .unwrap();
    hex::decode(line).unwrap()
}

fn fixture() -> MapFs {
    let gz = header_line("gz");
    let both = header_line("both");
    MapFs::new(&[
        (
            "index.html",
            b"<html><head><script>var t=1</script><link href=\"style.css?v=__ASSETV__\"></head><script src=\"js/app.js?v=__ASSETV__\"></script><script>\nb()</script></html>",
        ),
        ("js/app.js", b"console.log(1)\n"),
        ("style.css", b"body{}\n"),
        ("app.webmanifest", b"{\"name\":\"x\"}"),
        ("img/logo.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
        ("data/blob.zzq", b"hello world"),
        ("sub/index.html", b"<p>sub</p>"),
        ("docs/a.txt", b"a"),
        ("docs/b c.md", b"b"),
        ("docs/x:y.txt", b"x"),
        ("docs/q?.txt", b"q"),
        ("docs/<i>&.txt", b"i"),
        ("docs/deep/z.txt", b"z"),
        ("vendor/cm/cm.js.gz", &gz),
        ("vendor/cm/bad.js.gz", b"not gzip"),
        ("both.js", b"plain wins\n"),
        ("both.js.gz", &both),
    ])
}

async fn dump(s: &Arc<Server>, method: &str, target: &str, hdrs: &[(&str, &str)]) -> String {
    let mut b = http::Request::builder()
        .method(method)
        .uri(target)
        .header("Host", "127.0.0.1");
    if method == "POST" {
        b = b.header("Content-Type", "application/json");
    }
    for (k, v) in hdrs {
        b = b.header(*k, *v);
    }
    let res = s
        .serve_addr(b.body(Full::new(Bytes::new())).unwrap(), LOCAL.to_owned())
        .await;
    let status = res.status().as_u16();
    let mut hs: Vec<String> = res
        .headers()
        .iter()
        .filter(|(k, _)| k.as_str() != "x-request-id")
        .map(|(k, v)| format!("{}={}", canon(k.as_str()), v.to_str().unwrap()))
        .collect();
    hs.sort();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    format!(
        "{status} {}\n{}\n",
        hs.join("|"),
        otter_gocompat::strconv::quote_bytes(&body)
    )
}

#[tokio::test]
async fn golden_558a_static() {
    let (_d, s) = static_server(Arc::new(fixture()));
    let line = |k: &str| {
        GOLDEN
            .lines()
            .find_map(|l| l.strip_prefix(&format!("#{k} ")))
            .unwrap()
            .to_owned()
    };
    assert_eq!(s.asset_version(), line("version"));
    assert_eq!(
        crate::static_assets::csp_for(b"<script>var a=1</script>"),
        line("csp")
    );

    let mut blocks = GOLDEN.split("\n== ").skip(1);
    let mut n = 0;
    for blk in &mut blocks {
        let (head, want) = blk.split_once('\n').unwrap();
        let (method, rest) = head.split_once(' ').unwrap();
        let (target, hdrs) = rest.split_once(' ').unwrap();
        let hdrs: Vec<(&str, &str)> = hdrs
            .split(" ; ")
            .filter(|h| !h.is_empty())
            .map(|h| h.split_once(": ").unwrap())
            .collect();
        let want = format!("{}\n", want.trim_end_matches('\n'));
        let got = dump(&s, method, target, &hdrs).await;
        assert_eq!(got, want, "{method} {target} {hdrs:?}");
        n += 1;
    }
    assert_eq!(n, 53);
}

#[tokio::test]
async fn multi_range_is_multipart() {
    let (_d, s) = static_server(Arc::new(fixture()));
    let req = http::Request::builder()
        .uri("/js/app.js")
        .header("Host", "127.0.0.1")
        .header("Range", "bytes=0-1,4-6")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let res = s.serve_addr(req, LOCAL.to_owned()).await;
    assert_eq!(res.status(), 206);
    let ct = res.headers()["content-type"].to_str().unwrap().to_owned();
    let boundary = ct
        .strip_prefix("multipart/byteranges; boundary=")
        .unwrap()
        .to_owned();
    assert_eq!(boundary.len(), 60);
    let cl: usize = res.headers()["content-length"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(cl, body.len());
    let want = format!(
        "--{b}\r\nContent-Range: bytes 0-1/15\r\nContent-Type: text/javascript; charset=utf-8\r\n\r\nco\
         \r\n--{b}\r\nContent-Range: bytes 4-6/15\r\nContent-Type: text/javascript; charset=utf-8\r\n\r\nole\
         \r\n--{b}--\r\n",
        b = boundary
    );
    assert_eq!(String::from_utf8_lossy(&body), want);
}
