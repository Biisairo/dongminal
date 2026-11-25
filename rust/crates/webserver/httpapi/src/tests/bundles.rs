//! 묶음 서빙 `/b/<name>.js` (PERF_OPTIMIZATION_SRS D-29·D-33, perf 이슈 3.4.2).

use std::io::Read;
use std::sync::Arc;

use super::statics::{MapFs, get_raw, static_server};
use super::support::{LOCAL, call, get};
use crate::asset_version::compute_asset_version;
use crate::static_assets::{StaticAssets, WebAssets};

const DEF: &str = "# 주석\n\n[boot]\n# 순서가 곧 로드 순서다\njs/b.js\nstyle.css\njs/a.js\n";

fn fs(def: &str, files: &[(&str, &str)]) -> Arc<MapFs> {
    let mut all: Vec<(&str, &[u8])> = vec![("bundles.txt", def.as_bytes())];
    all.extend(files.iter().map(|(n, b)| (*n, b.as_bytes())));
    Arc::new(MapFs::new(&all))
}

fn ab() -> Arc<MapFs> {
    fs(
        DEF,
        &[
            ("js/a.js", "A1\nA2\n"),
            ("js/b.js", "B"),
            ("style.css", "body{}"),
        ],
    )
}

const BOOT: &str = "/* ==== js/b.js ==== */\nB\n/* ==== js/a.js ==== */\nA1\nA2\n//# sourceMappingURL=boot.js.map\n";

#[tokio::test]
async fn bundle_is_files_in_definition_order_with_boundaries() {
    let (_d, s) = static_server(ab());
    let r = get(&s, "/b/boot.js").await;
    assert_eq!(r.status, 200);
    assert!(r.header("Content-Type").starts_with("text/javascript"));
    assert_eq!(r.body, BOOT);
}

#[tokio::test]
async fn unknown_bundle_is_404() {
    let (_d, s) = static_server(ab());
    for p in ["/b/nope.js", "/b/", "/b/boot", "/b/nope.js.map"] {
        assert_eq!(get(&s, p).await.status, 404, "{p}");
    }
}

#[tokio::test]
async fn missing_file_drops_only_that_bundle() {
    let def = "[boot]\njs/a.js\n[git]\njs/a.js\njs/gone.js\n";
    let (_d, s) = static_server(fs(def, &[("js/a.js", "A\n")]));
    assert_eq!(get(&s, "/b/boot.js").await.status, 200);
    assert_eq!(get(&s, "/b/git.js").await.status, 404);
}

#[tokio::test]
async fn malformed_definition_serves_no_bundle() {
    for def in [
        "js/a.js\n[boot]\njs/a.js\n",
        "[boot]\njs/a.js\n[boot]\njs/a.js\n",
        "[boot]\nREADME\n",
        "[]\njs/a.js\n",
    ] {
        let (_d, s) = static_server(fs(def, &[("js/a.js", "A\n"), ("README", "x")]));
        assert_eq!(get(&s, "/b/boot.js").await.status, 404, "{def:?}");
    }
}

#[tokio::test]
async fn no_definition_serves_no_bundle() {
    let (_d, s) = static_server(Arc::new(MapFs::new(&[("js/a.js", b"A\n")])));
    assert_eq!(get(&s, "/b/boot.js").await.status, 404);
    assert_eq!(get(&s, "/js/a.js").await.status, 200);
}

#[tokio::test]
async fn bundle_gzip_for_clients_that_accept_it() {
    let (_d, s) = static_server(ab());
    let (r, body) = get_raw(&s, "/b/boot.js", &[("Accept-Encoding", "gzip, br")]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Encoding"), "gzip");
    assert!(r.header("Vary").contains("Accept-Encoding"));
    let mut got = String::new();
    flate2::read::GzDecoder::new(&body[..])
        .read_to_string(&mut got)
        .unwrap();
    assert_eq!(got, BOOT);
    assert_ne!(r.header("ETag"), get(&s, "/b/boot.js").await.header("ETag"));
    for ae in ["", "identity", "gzip;q=0"] {
        let r = call(
            &s,
            "GET",
            "/b/boot.js",
            &[("Accept-Encoding", ae)],
            "",
            LOCAL,
        )
        .await;
        assert_eq!(r.header("Content-Encoding"), "", "{ae}");
        assert!(r.header("Vary").contains("Accept-Encoding"), "{ae}");
        assert_eq!(r.body, BOOT, "{ae}");
    }
}

#[tokio::test]
async fn bundle_etag_revalidates() {
    let (_d, s) = static_server(ab());
    let tag = get(&s, "/b/boot.js").await.header("ETag");
    assert!(!tag.is_empty());
    let r = call(
        &s,
        "GET",
        "/b/boot.js",
        &[("If-None-Match", &tag)],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 304);
    let (_d2, s2) = static_server(fs(
        DEF,
        &[
            ("js/a.js", "A9\n"),
            ("js/b.js", "B"),
            ("style.css", "body{}"),
        ],
    ));
    assert_ne!(get(&s2, "/b/boot.js").await.header("ETag"), tag);
}

#[tokio::test]
async fn bundle_source_map_maps_lines_to_files() {
    let (_d, s) = static_server(ab());
    let r = get(&s, "/b/boot.js.map").await;
    assert_eq!(r.status, 200);
    assert!(r.header("Content-Type").starts_with("application/json"));
    assert!(!r.header("ETag").is_empty());
    let m = r.json();
    assert_eq!(m["version"], 3);
    assert_eq!(m["file"], "boot.js");
    assert_eq!(
        m["sources"],
        serde_json::json!(["../js/b.js", "../js/a.js"])
    );
    // 줄: 경계 · B · 경계 · A1 · A2 · sourceMappingURL. 경계와 꼬리는 비운다.
    assert_eq!(m["mappings"], ";AAAA;;ACAA;AACA;");
}

#[test]
fn version_follows_definition() {
    let files = [("js/a.js", "A\n"), ("js/b.js", "B\n")];
    let a = compute_asset_version(fs("[boot]\njs/a.js\njs/b.js\n", &files).as_ref());
    let b = compute_asset_version(fs("[boot]\njs/b.js\njs/a.js\n", &files).as_ref());
    assert_ne!(a, b, "정의 순서가 바뀌었는데 판이 그대로다");
}

#[test]
fn version_follows_bundled_file() {
    let a = compute_asset_version(fs("[boot]\njs/a.js\n", &[("js/a.js", "A\n")]).as_ref());
    let b = compute_asset_version(fs("[boot]\njs/a.js\n", &[("js/a.js", "A2\n")]).as_ref());
    assert_ne!(a, b);
}

#[tokio::test]
async fn real_definition_builds_boot() {
    let Some(def) = WebAssets.read("bundles.txt") else {
        panic!("web/bundles.txt 가 실리지 않았다");
    };
    assert!(std::str::from_utf8(&def).unwrap().contains("[boot]"));
    let (_d, s) = static_server(Arc::new(WebAssets));
    let r = get(&s, "/b/boot.js").await;
    assert_eq!(r.status, 200, "정의의 파일이 빠졌다");
    assert!(
        r.body.starts_with("/* ==== js/"),
        "{}",
        &r.body[..80.min(r.body.len())]
    );
}

// ── CSS (perf 3.4.3, 결정 A): `.css` 줄도 이어 `/b/<이름>.css` 로 낸다 ──

const CSS_DEF: &str = "[git]\njs/g.js\nstyle-g2.css\nstyle-g1.css\n[plain]\njs/g.js\n";

fn css_fs() -> Arc<MapFs> {
    fs(
        CSS_DEF,
        &[
            ("js/g.js", "G\n"),
            ("style-g1.css", ".a{}\n"),
            ("style-g2.css", ".b{}"),
        ],
    )
}

const GIT_CSS: &str = "/* ==== style-g2.css ==== */\n.b{}\n/* ==== style-g1.css ==== */\n.a{}\n";

#[tokio::test]
async fn bundle_css_is_css_lines_in_order_with_boundaries() {
    let (_d, s) = static_server(css_fs());
    let r = get(&s, "/b/git.css").await;
    assert_eq!(r.status, 200);
    assert!(r.header("Content-Type").starts_with("text/css"));
    assert!(!r.header("ETag").is_empty());
    assert_eq!(r.body, GIT_CSS);
    let (r, body) = get_raw(&s, "/b/git.css", &[("Accept-Encoding", "gzip")]).await;
    assert_eq!(r.header("Content-Encoding"), "gzip");
    let mut got = String::new();
    flate2::read::GzDecoder::new(&body[..])
        .read_to_string(&mut got)
        .unwrap();
    assert_eq!(got, GIT_CSS);
}

#[tokio::test]
async fn bundle_without_css_has_no_css() {
    let (_d, s) = static_server(css_fs());
    assert_eq!(get(&s, "/b/plain.js").await.status, 200);
    assert_eq!(get(&s, "/b/plain.css").await.status, 404);
}

#[tokio::test]
async fn missing_css_file_drops_the_bundle() {
    let (_d, s) = static_server(fs(
        CSS_DEF,
        &[("js/g.js", "G\n"), ("style-g1.css", ".a{}\n")],
    ));
    assert_eq!(get(&s, "/b/git.js").await.status, 404);
    assert_eq!(get(&s, "/b/git.css").await.status, 404);
}

// ── 주석 걷기 (perf 3.4.10, D-35): 파일의 주석·줄 끝 공백만 걷고 줄 수는 지킨다 ──

#[tokio::test]
async fn bundle_strips_comments_but_keeps_boundaries_and_lines() {
    let src = "/** 설명\n */\nvar a = '//'; // 꼬리  \nvar t = `x  \n`;\n";
    let (_d, s) = static_server(fs("[boot]\njs/a.js\n", &[("js/a.js", src)]));
    let r = get(&s, "/b/boot.js").await;
    assert_eq!(
        r.body,
        "/* ==== js/a.js ==== */\n\n\nvar a = '//';\nvar t = `x  \n`;\n//# sourceMappingURL=boot.js.map\n"
    );
    // 줄: 경계 · 원본 5줄 · sourceMappingURL. 걷어도 줄 맞춤은 그대로다.
    let m = get(&s, "/b/boot.js.map").await.json();
    assert_eq!(m["mappings"], ";AAAA;AACA;AACA;AACA;AACA;");
}

#[tokio::test]
async fn bundle_keeps_line_count_when_file_ends_in_comment() {
    let (_d, s) = static_server(fs("[boot]\njs/a.js\n", &[("js/a.js", "a();\n// 끝")]));
    let r = get(&s, "/b/boot.js").await;
    assert_eq!(
        r.body,
        "/* ==== js/a.js ==== */\na();\n\n//# sourceMappingURL=boot.js.map\n"
    );
}
