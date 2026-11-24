//! Go `static_test.go`·`asset_version_test.go`·`commands_test.go`(인사의 판) 의 이식.
//!
//! 옮기지 않은 것: `BenchmarkStaticPrecompressed`(할당 측정 벤치마크).

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};

use super::support::{LOCAL, Resp, TEST_HOST, call, get};
use crate::asset_version::{ASSET_VER_PLACEHOLDER, compute_asset_version};
use crate::static_assets::{
    AssetEntry, StaticAssets, StaticHandler, WebAssets, content_type_for, csp_for,
};
use crate::{Config, Deps, Server};

/// Go `fstest.MapFS` + `countingFS`: `read` 를 이름별로 센다. `is_file` 은 세지 않는다(Go 의 `Stat`).
#[derive(Debug, Default)]
pub(crate) struct MapFs {
    files: BTreeMap<String, Vec<u8>>,
    opens: Mutex<HashMap<String, usize>>,
}

impl MapFs {
    pub(crate) fn new(files: &[(&str, &[u8])]) -> MapFs {
        MapFs {
            files: files
                .iter()
                .map(|(n, b)| ((*n).to_owned(), b.to_vec()))
                .collect(),
            ..MapFs::default()
        }
    }

    fn count(&self, name: &str) -> usize {
        self.opens
            .lock()
            .unwrap()
            .get(name)
            .copied()
            .unwrap_or_default()
    }
}

impl StaticAssets for MapFs {
    fn read(&self, name: &str) -> Option<Cow<'static, [u8]>> {
        *self
            .opens
            .lock()
            .unwrap()
            .entry(name.to_owned())
            .or_default() += 1;
        self.files.get(name).map(|b| Cow::Owned(b.clone()))
    }

    fn read_dir(&self, name: &str) -> Option<Vec<AssetEntry>> {
        let prefix = if name == "." {
            String::new()
        } else {
            format!("{name}/")
        };
        let mut set = BTreeSet::new();
        for p in self.files.keys() {
            let Some(rest) = p.strip_prefix(&prefix) else {
                continue;
            };
            match rest.split_once('/') {
                Some((d, _)) => set.insert((d.to_owned(), true)),
                None => set.insert((rest.to_owned(), false)),
            };
        }
        if set.is_empty() && name != "." {
            return None;
        }
        Some(
            set.into_iter()
                .map(|(name, is_dir)| AssetEntry { name, is_dir })
                .collect(),
        )
    }

    fn is_file(&self, name: &str) -> bool {
        self.files.contains_key(name)
    }
}

pub(crate) fn static_server(fs: Arc<dyn StaticAssets>) -> (tempfile::TempDir, Arc<Server>) {
    let d = tempfile::tempdir().unwrap();
    let s = Server::new(
        Config {
            port: "0".to_owned(),
            data_dir: d.path().to_path_buf(),
            static_fs: Some(fs),
            ..Config::default()
        },
        Deps::default(),
    );
    (d, s)
}

fn map(files: &[(&str, &[u8])]) -> Arc<dyn StaticAssets> {
    Arc::new(MapFs::new(files))
}

async fn get_h(s: &Arc<Server>, target: &str, headers: &[(&str, &str)]) -> Resp {
    call(s, "GET", target, headers, "", LOCAL).await
}

fn gz_bytes(plain: &str) -> Vec<u8> {
    let mut w = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    w.write_all(plain.as_bytes()).unwrap();
    w.finish().unwrap()
}

/// Go `precompressedFS`.
fn precompressed_fs(plain: &str) -> MapFs {
    let cm = gz_bytes(plain);
    let theme = gz_bytes("body{}");
    MapFs::new(&[
        ("index.html", b"<html></html>"),
        ("vendor/codemirror/cm.js.gz", &cm),
        ("vendor/codemirror/theme.css.gz", &theme),
        ("vendor/xterm.js", b"xterm\n"),
    ])
}

/// 본문을 바이트로 받는다 (gzip 본문은 UTF-8 이 아니다).
async fn get_raw(s: &Arc<Server>, target: &str, headers: &[(&str, &str)]) -> (Resp, Vec<u8>) {
    let mut b = http::Request::builder()
        .method("GET")
        .uri(target)
        .header("Host", TEST_HOST);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let res = s
        .serve_addr(b.body(Full::new(Bytes::new())).unwrap(), LOCAL.to_owned())
        .await;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (
        Resp {
            status,
            headers,
            body: String::new(),
        },
        body,
    )
}

#[tokio::test]
async fn static_assets_carry_etag() {
    let (_d, s) = static_server(map(&[("js/app.js", b"console.log(1)\n")]));
    let r = get(&s, "/js/app.js").await;
    assert_eq!(r.status, 200);
    let etag = r.header("ETag");
    assert!(!etag.is_empty(), "ETag 가 없다");
    let r2 = get_h(&s, "/js/app.js", &[("If-None-Match", &etag)]).await;
    assert_eq!(r2.status, 304);
    assert!(r2.body.is_empty());
}

#[tokio::test]
async fn static_etag_follows_content() {
    let mut tags = Vec::new();
    for body in ["old\n", "new\n"] {
        let (_d, s) = static_server(map(&[("js/app.js", body.as_bytes())]));
        tags.push(get(&s, "/js/app.js").await.header("ETag"));
    }
    assert_ne!(tags[0], tags[1]);
}

#[tokio::test]
async fn static_etag_does_not_touch_api() {
    let (_d, s) = static_server(map(&[("index.html", b"<html>")]));
    assert_eq!(get(&s, "/api/ping").await.header("ETag"), "");
}

#[tokio::test]
async fn static_security_headers() {
    let (_d, s) = static_server(map(&[("index.html", b"<html></html>")]));
    let r = get(&s, "/").await;
    for (k, want) in [
        ("Content-Security-Policy", "default-src 'self'"),
        ("Content-Security-Policy", "frame-ancestors 'none'"),
        ("X-Frame-Options", "DENY"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        assert!(
            r.header(k).contains(want),
            "{k}={:?} 에 {want:?} 가 없다",
            r.header(k)
        );
    }
}

#[test]
fn csp_external_hosts_are_known() {
    let csp = csp_for(b"");
    assert!(
        !csp.contains("https://") && !csp.contains("http://"),
        "{csp}"
    );
}

#[test]
fn csp_has_no_unsafe_inline_script() {
    let csp = csp_for(b"<script>var a=1</script>");
    let rest = csp.strip_prefix("default-src 'self'; ").unwrap();
    let script_src = rest.split_once("; ").unwrap().0;
    assert!(!script_src.contains("unsafe-inline"), "{script_src}");
}

#[test]
fn csp_hashes_every_inline_script() {
    let doc = b"<head><script>var a=1</script>\n<script>var b=2</script>\n<script src=\"js/app.js\"></script></head>";
    assert_eq!(csp_for(doc).matches("'sha256-").count(), 2);
}

#[test]
fn csp_hash_follows_content() {
    assert_ne!(
        csp_for(b"<script>var a=1</script>"),
        csp_for(b"<script>var a=2</script>")
    );
}

#[test]
fn csp_covers_real_index() {
    let Some(doc) = WebAssets.read("index.html") else {
        return;
    };
    let want = doc.windows(8).filter(|w| *w == b"<script>").count();
    assert!(want > 0, "index.html 에 인라인 스크립트가 없다");
    assert_eq!(csp_for(&doc).matches("'sha256-").count(), want);
}

#[test]
fn csp_matches_go_bytes() {
    // go1.27.2 `cspFor([]byte("<script>var a=1</script>"))`.
    assert_eq!(
        csp_for(b"<script>var a=1</script>"),
        "default-src 'self'; script-src 'self' 'sha256-WazVQOu5lmXfSreSrMJd1CsaQ4c00fUQpJfBYCuMSIw='; \
         style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; \
         connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; \
         base-uri 'self'; form-action 'self'"
    );
}

#[tokio::test]
async fn precompressed_served_as_gzip() {
    let plain = "define('loader',[],function(){})\n";
    let (_d, s) = static_server(Arc::new(precompressed_fs(plain)));
    let (r, body) = get_raw(
        &s,
        "/vendor/codemirror/cm.js",
        &[("Accept-Encoding", "gzip, deflate, br")],
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Encoding"), "gzip");
    assert!(r.header("Content-Type").starts_with("text/javascript"));
    let mut got = String::new();
    flate2::read::GzDecoder::new(&body[..])
        .read_to_string(&mut got)
        .unwrap();
    assert_eq!(got, plain);
}

#[tokio::test]
async fn precompressed_falls_back_to_plain() {
    let plain = "define('loader',[],function(){})\n";
    let (_d, s) = static_server(Arc::new(precompressed_fs(plain)));
    for ae in ["", "identity", "gzip;q=0", "br"] {
        let r = get_h(&s, "/vendor/codemirror/cm.js", &[("Accept-Encoding", ae)]).await;
        assert_eq!(r.status, 200, "{ae}");
        assert_eq!(r.header("Content-Encoding"), "", "{ae}");
        assert_eq!(r.body, plain, "{ae}");
    }
}

#[tokio::test]
async fn precompressed_vary_and_etag() {
    let (_d, s) = static_server(Arc::new(precompressed_fs("x\n")));
    let zipped = get_h(
        &s,
        "/vendor/codemirror/cm.js",
        &[("Accept-Encoding", "gzip")],
    )
    .await;
    let plain = get(&s, "/vendor/codemirror/cm.js").await;
    for r in [&zipped, &plain] {
        assert!(r.header("Vary").contains("Accept-Encoding"));
        assert!(!r.header("ETag").is_empty());
    }
    assert_eq!(zipped.header("ETag"), plain.header("ETag"));
}

#[tokio::test]
async fn precompressed_raw_path_still_served() {
    let (_d, s) = static_server(Arc::new(precompressed_fs("x\n")));
    let r = get(&s, "/vendor/codemirror/cm.js.gz").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Encoding"), "");
}

#[tokio::test]
async fn plain_assets_unchanged() {
    let (_d, s) = static_server(Arc::new(precompressed_fs("x\n")));
    let r = get(&s, "/vendor/xterm.js").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Encoding"), "");
    assert_eq!(r.body, "xterm\n");
    assert!(!r.header("ETag").is_empty());
}

#[tokio::test]
async fn precompressed_content_type_by_ext() {
    let (_d, s) = static_server(Arc::new(precompressed_fs("x\n")));
    let r = get_h(
        &s,
        "/vendor/codemirror/theme.css",
        &[("Accept-Encoding", "gzip")],
    )
    .await;
    assert!(r.header("Content-Type").starts_with("text/css"));
}

#[test]
fn content_type_for_is_host_independent() {
    for (name, want) in [
        ("app.js", "text/javascript; charset=utf-8"),
        ("APP.JS", "text/javascript; charset=utf-8"),
        ("style.css", "text/css; charset=utf-8"),
        ("index.html", "text/html; charset=utf-8"),
        ("icon.svg", "image/svg+xml"),
        ("f.woff2", "font/woff2"),
    ] {
        assert_eq!(content_type_for(name), want, "{name}");
    }
    assert_eq!(
        content_type_for("x.unknown-ext-xyz"),
        "application/octet-stream"
    );
}

#[tokio::test]
async fn precompressed_reads_file_once() {
    let plain = "define('loader',[],function(){})\n";
    let fs = Arc::new(precompressed_fs(plain));
    let (_d, s) = static_server(fs.clone());
    for i in 0..5 {
        let r = get_h(
            &s,
            "/vendor/codemirror/cm.js",
            &[("Accept-Encoding", "gzip")],
        )
        .await;
        assert_eq!(r.status, 200, "{i}회차");
    }
    let n = fs.count("vendor/codemirror/cm.js.gz");
    assert!(n <= 2, "{n}번 열었다 — 요청마다 읽고 있다 (FR-PRF-52)");
}

#[tokio::test]
async fn precompressed_cache_keeps_plain_fallback() {
    let plain = "define('loader',[],function(){})\n";
    let (_d, s) = static_server(Arc::new(precompressed_fs(plain)));
    for i in 0..3 {
        let r = get_h(
            &s,
            "/vendor/codemirror/cm.js",
            &[("Accept-Encoding", "identity")],
        )
        .await;
        assert_eq!(r.status, 200, "{i}");
        assert_eq!(r.header("Content-Encoding"), "", "{i}");
        assert_eq!(r.body, plain, "{i}");
    }
}

#[test]
fn etag_does_not_cache_misses() {
    let h = StaticHandler::new(map(&[("js/app.js", b"console.log(1)\n")]));
    for i in 0..1000 {
        h.etag_for(&format!("/no-such-{i}.js"));
    }
    assert_eq!(h.etag_count(), 0);
    assert!(!h.etag_for("/js/app.js").is_empty());
    assert_eq!(h.etag_count(), 1);
}

// ── 자산의 판 (asset_version_test.go) ──

const DOC_WITH: &str = "<link rel=\"stylesheet\" href=\"style.css?v=__ASSETV__\"><script src=\"js/core/main.js?v=__ASSETV__\"></script>";

fn fs_with(files: &[(&str, &str)]) -> MapFs {
    let mut all: Vec<(&str, &[u8])> = vec![("index.html", DOC_WITH.as_bytes())];
    all.extend(files.iter().map(|(n, b)| (*n, b.as_bytes())));
    MapFs::new(&all)
}

#[test]
fn asset_version_follows_assets() {
    let files = [
        ("js/app.js", "console.log(1)\n"),
        ("style.css", "body{}\n"),
        ("vendor/xterm.js", "/* v1 */\n"),
    ];
    let base = compute_asset_version(&fs_with(&files));
    for (name, changed, want) in [
        ("JS", ("js/app.js", "console.log(2)\n"), true),
        ("CSS", ("style.css", "body{color:red}\n"), true),
        ("vendor", ("vendor/xterm.js", "/* v2 */\n"), false),
    ] {
        let mut f = files.to_vec();
        for e in &mut f {
            if e.0 == changed.0 {
                e.1 = changed.1;
            }
        }
        let got = compute_asset_version(&fs_with(&f));
        assert_eq!(got != base, want, "{name}: {base} → {got}");
    }
    let mut m = fs_with(&files);
    m.files.insert(
        "index.html".to_owned(),
        format!("{DOC_WITH}<!-- 주석 -->").into_bytes(),
    );
    assert_eq!(compute_asset_version(&m), base, "문서가 판을 바꿨다");
}

#[test]
fn asset_version_follows_names() {
    let a = compute_asset_version(&fs_with(&[("js/old.js", "x\n")]));
    let b = compute_asset_version(&fs_with(&[("js/new.js", "x\n")]));
    assert_ne!(a, b);
}

#[test]
fn asset_version_without_assets() {
    assert!(!compute_asset_version(&fs_with(&[])).is_empty());
}

#[test]
fn asset_version_matches_go() {
    // go1.27.2 `computeAssetVersion(fsWith({"js/app.js":"console.log(1)\n","style.css":"body{}\n"}))`
    // 와 자산이 없는 경우.
    let v = compute_asset_version(&fs_with(&[
        ("js/app.js", "console.log(1)\n"),
        ("style.css", "body{}\n"),
    ]));
    assert_eq!(v, "4cf3111b96d2");
    assert_eq!(compute_asset_version(&fs_with(&[])), "e3b0c44298fc");
}

fn served_versions(body: &str) -> Vec<String> {
    let re = regex::Regex::new(r"\?v=([0-9a-f]+)").unwrap();
    re.captures_iter(body).map(|c| c[1].to_owned()).collect()
}

#[tokio::test]
async fn index_placeholder_substituted() {
    let files = fs_with(&[("js/app.js", "console.log(1)\n")]);
    let want = compute_asset_version(&files);
    let (_d, s) = static_server(Arc::new(files));
    let r = get(&s, "/").await;
    assert_eq!(r.status, 200);
    assert!(!r.body.contains(ASSET_VER_PLACEHOLDER), "{}", r.body);
    let got = served_versions(&r.body);
    assert_eq!(got.len(), 2, "{}", r.body);
    assert!(got.iter().all(|v| *v == want));
}

#[tokio::test]
async fn index_path_redirects_as_before() {
    let (_d, s) = static_server(Arc::new(fs_with(&[("js/app.js", "x\n")])));
    let r = get(&s, "/index.html").await;
    assert_eq!(r.status, 301);
    assert_eq!(r.header("Location"), "./");
}

#[tokio::test]
async fn assets_are_not_substituted() {
    let body = "const P='__ASSETV__'\n";
    let (_d, s) = static_server(Arc::new(fs_with(&[("js/app.js", body)])));
    assert_eq!(get(&s, "/js/app.js").await.body, body);
}

#[tokio::test]
async fn index_etag_follows_substitution() {
    let mut tags = Vec::new();
    for js in ["console.log(1)\n", "console.log(2)\n"] {
        let (_d, s) = static_server(Arc::new(fs_with(&[("js/app.js", js)])));
        let r = get(&s, "/").await;
        assert_eq!(r.status, 200);
        tags.push(r.header("ETag"));
    }
    assert!(!tags[0].is_empty());
    assert_ne!(tags[0], tags[1]);
}

#[tokio::test]
async fn index_etag_revalidates() {
    let (_d, s) = static_server(Arc::new(fs_with(&[("js/app.js", "x\n")])));
    let r = get(&s, "/").await;
    assert_eq!(r.header("Cache-Control"), "no-cache");
    let r2 = get_h(&s, "/", &[("If-None-Match", &r.header("ETag"))]).await;
    assert_eq!(r2.status, 304);
    assert!(r2.body.is_empty());
}

#[tokio::test]
async fn served_version_matches_hello() {
    let files = fs_with(&[("js/app.js", "console.log(1)\n"), ("style.css", "body{}\n")]);
    let (_d, s) = static_server(Arc::new(files));
    let doc = get(&s, "/").await.body;
    let v = served_versions(&doc);
    assert!(!v.is_empty());
    assert_eq!(s.asset_version(), v[0]);

    // 판은 채널 인사의 `server.assetVersion` 으로 간다 (C2a).
    use super::wsc::{Message, TextOf};
    use futures_util::{SinkExt, StreamExt};
    let port = super::ws::listen(s.clone()).await;
    let mut c = super::wsc::dial(port, "/channel?v=1").await;
    c.send(Message::text(r#"{"t":"hello","slots":[]}"#))
        .await
        .unwrap();
    let seen = loop {
        match tokio::time::timeout(Duration::from_secs(3), c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => break t.as_str().to_owned(),
            Ok(Some(Ok(_))) => continue,
            other => panic!("채널 인사가 없다: {other:?}"),
        }
    };
    let want = format!("\"assetVersion\":\"{}\"", v[0]);
    assert!(seen.contains(&want), "{seen}");
}

#[tokio::test]
async fn no_static_fs_is_404() {
    let d = tempfile::tempdir().unwrap();
    let s = super::support::server(d.path(), Deps::default());
    let r = get(&s, "/").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.body, "404 page not found\n");
    assert_eq!(s.asset_version(), "");
}

/// 실물 자산(`otter-web-assets`)으로 선다 — 문서의 자리표시자가 모두 판으로 바뀐다.
#[tokio::test]
async fn web_assets_serve_index() {
    let (_d, s) = static_server(Arc::new(WebAssets));
    let v = s.asset_version();
    assert_eq!(v.len(), 12);
    let r = get(&s, "/").await;
    assert_eq!(r.status, 200);
    assert!(!r.body.contains(ASSET_VER_PLACEHOLDER));
    assert!(r.body.contains(&format!("?v={v}")));
    assert_eq!(
        r.header("Content-Security-Policy")
            .matches("'sha256-")
            .count(),
        r.body.matches("<script>").count()
    );
}
