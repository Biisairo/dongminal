//! `/api/file/*` 의 시험 (Go `handlers_files_*_test.go`·`handlers_file_probe_test.go`).

use std::collections::BTreeMap;

use dm_shared_editorlimit as editorlimit;
use dm_shared_textenc::{self as textenc, Encoded};
use dm_webserver_action::{self as action, Answer};
use dm_webserver_apierr as apierr;
use serde_json::{Value, json};

use super::fsenv::{FileEnv, file_env, file_env_with, get, jq, post, qe, write};
use crate::files_rw::{FILE_ACTIONS_HEADER, convert_utf8_answer, lsp_watch_type, stamp_conflict};
use crate::files_stamp::FILE_STAMPS_MAX;
use crate::path_lock::PathLocks;

fn cp949(s: &str) -> Vec<u8> {
    match textenc::encode(s, textenc::CP949, false).unwrap() {
        Encoded::Bytes(b) => b,
        Encoded::Unmappable(u) => panic!("{u:?}"),
    }
}

async fn write_req(e: &FileEnv, body: Value) -> super::fsenv::Res {
    post(&e.srv, "/api/file/write", &body.to_string()).await
}

async fn write_simple(e: &FileEnv, path: &str, content: &str) -> super::fsenv::Res {
    write_req(e, json!({"path": path, "content": content})).await
}

async fn read(e: &FileEnv, path: &str, extra: &str) -> super::fsenv::Res {
    get(&e.srv, &format!("/api/file/read?path={}{extra}", qe(path))).await
}

fn p(e: &FileEnv, name: &str) -> String {
    format!("{}/{name}", e.root)
}

fn read_file(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

// ── 경계 (handlers_files_boundary_test.go) ─────────

#[tokio::test]
async fn file_write_inside_root_succeeds() {
    let e = file_env();
    let t = p(&e, "note.txt");
    let r = write_simple(&e, &t, "hello\n").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(r.text().contains(r#""ok":true"#), "{}", r.text());
    assert_eq!(read_file(&t), b"hello\n");
}

#[tokio::test]
async fn file_write_relative_and_empty_path_are_400() {
    let e = file_env();
    let r = write_simple(&e, "note.txt", "x").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_ABS_PATH_NEEDED);
    assert_eq!(r.text(), "path must be absolute\n");
    let r = write_simple(&e, "", "x").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_MISSING_ARG);
    assert_eq!(r.text(), "missing path\n");
}

#[tokio::test]
async fn file_write_failure_is_500() {
    let e = file_env();
    let dir = p(&e, "sub");
    std::fs::create_dir_all(&dir).unwrap();
    let r = write_simple(&e, &dir, "x").await;
    assert_eq!(r.status, 500);
    assert_eq!(r.text(), "write failed\n");
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_IO);
}

#[tokio::test]
async fn file_write_invalid_json_and_unknown_encoding() {
    let e = file_env();
    let r = post(&e.srv, "/api/file/write", "{").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_INVALID_JSON);
    assert!(r.text().starts_with("invalid json"), "{}", r.text());
    let r = write_req(
        &e,
        json!({"path": p(&e, "a.txt"), "content": "x", "encoding": "klingon"}),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.text(), "unknown encoding: klingon\n");
}

#[tokio::test]
async fn file_read_inside_root_succeeds() {
    let e = file_env();
    let t = p(&e, "ok.txt");
    write(&t, b"visible\n");
    let r = read(&e, &t, "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"visible\n");
    assert_eq!(r.header("Content-Type"), "text/plain; charset=utf-8");
}

#[tokio::test]
async fn file_read_missing_and_dir() {
    let e = file_env();
    let r = read(&e, &p(&e, "gone.txt"), "").await;
    assert_eq!((r.status, r.text().as_str()), (404, "file not found\n"));
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_NOT_FOUND);
    let r = read(&e, &e.root, "").await;
    assert_eq!((r.status, r.text().as_str()), (400, "not a file\n"));
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_NOT_A_FILE);
}

// ── probe·raw (handlers_file_probe_test.go) ─────────

fn png_bytes() -> Vec<u8> {
    let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    b.extend_from_slice(&[0; 32]);
    b
}

const SVG: &str = "<?xml version=\"1.0\"?>\n<!-- 주석 -->\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\"><rect width=\"4\" height=\"4\"/></svg>";

async fn probe(e: &FileEnv, path: &str) -> (u16, Value) {
    let r = get(&e.srv, &format!("/api/file/probe?path={}", qe(path))).await;
    (r.status, r.json())
}

#[tokio::test]
async fn file_probe_classifies_by_content() {
    let e = file_env();
    let mut bin = b"MZ\x00\x01".to_vec();
    for _ in 0..64 {
        bin.extend_from_slice(&[0x01, 0x00]);
    }
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("disguised.txt", png_bytes(), "image"),
        ("script", b"#!/bin/sh\necho hi\n".to_vec(), "text"),
        ("code.go", b"package main\n".to_vec(), "text"),
        ("blob.bin", bin, "binary"),
        ("empty.txt", Vec::new(), "text"),
    ];
    for (name, blob, want) in cases {
        let path = p(&e, name);
        write(&path, &blob);
        let (code, body) = probe(&e, &path).await;
        assert_eq!(code, 200, "{name}: {body}");
        assert_eq!(body["kind"], want, "{name}: {body}");
    }
}

#[tokio::test]
async fn file_probe_reports_size_and_max_bytes() {
    let e = file_env();
    let path = p(&e, "a.txt");
    write(&path, b"12345");
    let r = get(&e.srv, &format!("/api/file/probe?path={}", qe(&path))).await;
    assert_eq!(
        r.text(),
        format!(
            "{{\"kind\":\"text\",\"maxBytes\":{},\"mime\":\"text/plain; charset=utf-8\",\"size\":5}}\n",
            editorlimit::FILE_MAX_BYTES
        )
    );
}

#[tokio::test]
async fn file_probe_rejects_bad_path() {
    let e = file_env();
    for path in ["", "relative/path", &p(&e, "nope")] {
        let (code, _) = probe(&e, path).await;
        assert_ne!(code, 200, "{path}");
    }
    let r = get(&e.srv, &format!("/api/file/probe?path={}", qe(&e.root))).await;
    assert_eq!((r.status, r.text().as_str()), (400, "not a file\n"));
}

#[tokio::test]
async fn file_raw_serves_image_inline() {
    let e = file_env();
    let path = p(&e, "pic.png");
    write(&path, &png_bytes());
    let r = get(&e.srv, &format!("/api/file/raw?path={}", qe(&path))).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("Content-Type"), "image/png");
    assert_eq!(r.header("X-Content-Type-Options"), "nosniff");
    assert_eq!(r.header("Content-Length"), png_bytes().len().to_string());
    assert_eq!(r.body, png_bytes());
}

#[tokio::test]
async fn file_raw_refuses_non_image() {
    let e = file_env();
    for (name, body) in [
        ("page.html", "<script>alert(1)</script>"),
        ("a.txt", "plain text"),
        ("a.xml", "<?xml version='1.0'?><root><item/></root>"),
        (
            "evil.svg",
            "<html><body><script>alert(1)</script></body></html>",
        ),
    ] {
        let path = p(&e, name);
        write(&path, body.as_bytes());
        let r = get(&e.srv, &format!("/api/file/raw?path={}", qe(&path))).await;
        assert_eq!(r.status, 415, "{name}");
        assert_eq!(r.text(), "not an image\n");
        assert_eq!(r.header("X-Error-Code"), apierr::CODE_NOT_AN_IMAGE);
    }
}

#[tokio::test]
async fn file_raw_serves_svg_sandboxed_and_probe_keeps_it_text() {
    let e = file_env();
    let path = p(&e, "icon.svg");
    write(&path, SVG.as_bytes());
    let r = get(&e.srv, &format!("/api/file/raw?path={}", qe(&path))).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("Content-Type"), "image/svg+xml");
    assert_eq!(r.header("X-Content-Type-Options"), "nosniff");
    assert_eq!(r.header("Content-Security-Policy"), "sandbox");
    assert_eq!(r.body, SVG.as_bytes());
    let (_, body) = probe(&e, &path).await;
    assert_eq!(body["kind"], "text");
}

#[tokio::test]
async fn file_probe_utf16_is_text() {
    let e = file_env();
    for (name, blob) in [
        ("le.txt", vec![0xFF, 0xFE, b'a', 0, b'b', 0]),
        ("be.txt", vec![0xFE, 0xFF, 0, b'a', 0, b'b']),
    ] {
        let path = p(&e, name);
        write(&path, &blob);
        assert_eq!(probe(&e, &path).await.1["kind"], "text", "{name}");
    }
    let path = p(&e, "u32.bin");
    write(&path, &[0xFF, 0xFE, 0, 0, b'a', 0, 0, 0]);
    assert_eq!(probe(&e, &path).await.1["kind"], "binary");
}

// ── 크기 상한 (handlers_files_size_test.go · handlers_files_limit_test.go) ─────────

fn small(n: i64) -> FileEnv {
    file_env_with(|s| s.limits.file_read_max = n)
}

#[tokio::test]
async fn file_read_over_limit_is_413() {
    let e = small(16);
    let t = p(&e, "big.txt");
    let content = "x".repeat(100);
    write(&t, content.as_bytes());
    let r = read(&e, &t, "").await;
    assert_eq!(r.status, 413);
    assert_eq!(r.text(), "file too large: 100 bytes (max 16)\n");
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_TOO_LARGE);
}

#[tokio::test]
async fn file_read_at_limit_succeeds() {
    let e = small(32);
    let t = p(&e, "exact.txt");
    write(&t, "y".repeat(32).as_bytes());
    let r = read(&e, &t, "").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), 32);
}

#[tokio::test]
async fn file_raw_over_limit_is_413() {
    let e = small(16);
    let t = p(&e, "big.png");
    write(&t, "z".repeat(100).as_bytes());
    let r = get(&e.srv, &format!("/api/file/raw?path={}", qe(&t))).await;
    assert_eq!(r.status, 413);
}

#[tokio::test]
async fn file_read_max_default() {
    assert_eq!(
        crate::fs_limits::ServerLimits::default().file_read_max,
        editorlimit::FILE_MAX_BYTES
    );
}

#[tokio::test]
async fn file_write_at_editor_limit_saves() {
    let e = file_env();
    let t = p(&e, "big.txt");
    let n = usize::try_from(editorlimit::FILE_MAX_BYTES).unwrap();
    let r = write_simple(&e, &t, &"a".repeat(n)).await;
    assert_eq!(r.status, 200, "{}", r.header("X-Error-Code"));
    assert_eq!(std::fs::metadata(&t).unwrap().len(), n as u64);
}

#[tokio::test]
async fn file_write_escaped_worst_cases_save() {
    let e = small(2 << 20);
    let r = write_simple(&e, &p(&e, "lines.txt"), &"\n".repeat(2 << 20)).await;
    assert_eq!(r.status, 200, "{}", r.header("X-Error-Code"));
    let t = p(&e, "ctl.bin.txt");
    let r = write_simple(&e, &t, &"\x01".repeat(2 << 20)).await;
    assert_eq!(r.status, 200, "{}", r.header("X-Error-Code"));
    assert_eq!(std::fs::metadata(&t).unwrap().len(), 2 << 20);
}

#[tokio::test]
async fn file_write_over_limit_is_too_large() {
    let e = small(16);
    let t = p(&e, "over.txt");
    write(&t, b"keep");
    let r = write_simple(&e, &t, &"b".repeat(17)).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_TOO_LARGE);
    assert_eq!(r.text(), "file too large: 17 bytes (max 16)\n");
    assert_eq!(read_file(&t), b"keep");
}

#[tokio::test]
async fn file_write_over_body_limit_is_body_too_large() {
    let e = small(16);
    let n = usize::try_from(editorlimit::body_max_bytes(16)).unwrap() + 1;
    let r = write_simple(&e, &p(&e, "body.txt"), &"c".repeat(n)).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_BODY_TOO_BIG);
    assert_eq!(r.header("Connection"), "close");
}

// ── 인코딩 (handlers_files_encoding_test.go) ─────────

#[tokio::test]
async fn file_read_decode_contract() {
    let e = file_env();
    let k = p(&e, "k.txt");
    let raw = cp949("한글 파일\n");
    write(&k, &raw);

    let r = read(&e, &k, "").await;
    assert_eq!(r.body, raw);
    assert_eq!(r.header("X-File-Encoding"), "");

    let r = read(&e, &k, "&decode=1").await;
    assert_eq!(r.text(), "한글 파일\n");
    assert_eq!(r.header("X-File-Encoding"), "cp949");
    assert_eq!(r.header("X-File-BOM"), "0");
    assert_eq!(r.header("X-File-Decodable"), "1");
    assert_ne!(r.header("X-File-Stamp"), "");

    let b = p(&e, "b.txt");
    write(&b, &[0xEF, 0xBB, 0xBF, b'x']);
    let r = read(&e, &b, "&decode=1").await;
    assert_eq!(
        (r.text().as_str(), r.header("X-File-BOM").as_str()),
        ("x", "1")
    );
    assert_eq!(r.header("X-File-Encoding"), "utf-8");

    let w = p(&e, "w.txt");
    write(&w, &[0xFF, 0xFE, b'h', 0, b'i', 0]);
    let r = read(&e, &w, "&decode=1").await;
    assert_eq!(r.text(), "hi");
    assert_eq!(r.header("X-File-Encoding"), "utf-16le");

    let bad = p(&e, "bad.txt");
    write(&bad, &[0xFF, 0xFF, 0x80]);
    assert_eq!(
        read(&e, &bad, "&decode=1").await.header("X-File-Decodable"),
        "0"
    );

    let r = read(&e, &bad, "&decode=1&encoding=utf-8").await;
    assert_eq!(r.status, 422);
    assert_eq!(r.header("X-Error-Code"), "encoding_undecodable");
    assert_eq!(r.text(), "cannot decode as utf-8\n");
    let r = read(&e, &k, "&decode=1&encoding=cp949").await;
    assert_eq!((r.status, r.text().as_str()), (200, "한글 파일\n"));
}

#[tokio::test]
async fn file_write_encoding_round_trip() {
    let e = file_env();
    let k = p(&e, "k.txt");
    write(&k, &cp949("옛"));
    let r = write_req(
        &e,
        json!({"path": k, "content": "새 내용", "encoding": "cp949", "bom": false}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(read_file(&k), cp949("새 내용"));
    let r = write_req(
        &e,
        json!({"path": k, "content": "a", "encoding": "utf-8", "bom": true}),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(read_file(&k), [0xEF, 0xBB, 0xBF, b'a']);
    let r = write_req(
        &e,
        json!({"path": k, "content": "hi", "encoding": "utf-16be", "bom": true}),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(read_file(&k), [0xFE, 0xFF, 0, b'h', 0, b'i']);
    let r = write_req(&e, json!({"path": k, "content": "원문"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(read_file(&k), "원문".as_bytes());
}

#[tokio::test]
async fn file_write_unmappable_rejected() {
    let e = file_env();
    let k = p(&e, "k.txt");
    let orig = cp949("옛");
    write(&k, &orig);
    let r = write_req(
        &e,
        json!({"path": k, "content": "a\nb😀", "encoding": "cp949", "bom": false}),
    )
    .await;
    assert_eq!(r.status, 422);
    assert_eq!(r.header("X-Error-Code"), "encoding_unmappable");
    assert_eq!(
        r.text(),
        "{\"char\":\"😀\",\"col\":2,\"error\":\"encoding_unmappable\",\"line\":2}\n"
    );
    assert_eq!(read_file(&k), orig);
}

#[cfg(unix)]
#[tokio::test]
async fn file_write_new_file_defaults_and_preserves_mode() {
    use std::os::unix::fs::PermissionsExt;
    let e = file_env();
    let n = p(&e, "new.txt");
    let r = write_req(
        &e,
        json!({"path": n, "content": "한", "encoding": "cp949", "bom": true}),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(read_file(&n), "한".as_bytes());
    assert_eq!(
        std::fs::metadata(&n).unwrap().permissions().mode() & 0o777,
        0o644
    );
    for mode in [0o755, 0o600] {
        let m = p(&e, &format!("m{mode:o}"));
        write(&m, b"x");
        std::fs::set_permissions(&m, std::fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(write_simple(&e, &m, "y").await.status, 200);
        assert_eq!(
            std::fs::metadata(&m).unwrap().permissions().mode() & 0o777,
            mode
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn file_write_follows_symlink() {
    use std::os::unix::fs::PermissionsExt;
    let e = file_env();
    let target = p(&e, "real.txt");
    write(&target, b"old");
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let link = p(&e, "link.txt");
    std::os::unix::fs::symlink("real.txt", &link).unwrap();
    assert_eq!(write_simple(&e, &link, "new").await.status, 200);
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(read_file(&target), b"new");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );

    let dangling = p(&e, "dangle.txt");
    std::os::unix::fs::symlink("sub-missing.txt", &dangling).unwrap();
    assert_eq!(write_simple(&e, &dangling, "made").await.status, 200);
    assert_eq!(read_file(&p(&e, "sub-missing.txt")), b"made");
    assert!(
        std::fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

// ── 변환 답 (handlers_files_convert_test.go) ─────────

const UNDECODABLE: &[u8] = &[b'a', 0xff, 0xff, 0xff, b'\n'];

#[test]
fn convert_utf8_answer_cases() {
    let cp = cp949("한글\n");
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice(b"a\n");
    let cases: Vec<(&[u8], &str, bool, &str, u16)> = vec![
        (&cp, textenc::CP949, true, "", 0),
        (&bom, textenc::UTF8, true, "", 0),
        (b"a\n", textenc::UTF8, false, apierr::CODE_ALREADY_UTF8, 409),
        (
            UNDECODABLE,
            textenc::UTF8,
            false,
            apierr::CODE_ENCODING_UNDECODABLE,
            422,
        ),
        (
            &cp,
            textenc::UTF8,
            false,
            apierr::CODE_ENCODING_UNDECODABLE,
            422,
        ),
    ];
    let cat = action::catalog();
    for (raw, from, ok, why, status) in cases {
        let a = convert_utf8_answer(raw, from);
        assert_eq!((a.ok, a.why.as_str(), a.status), (ok, why, status));
        if !a.ok {
            assert!(action::may_give(&cat, action::FILE_CONVERT_UTF8, &a.why));
        }
    }
}

fn actions_of(r: &super::fsenv::Res) -> BTreeMap<String, Value> {
    serde_json::from_str(&r.header(FILE_ACTIONS_HEADER)).unwrap()
}

#[tokio::test]
async fn file_read_carries_convert_answer() {
    let e = file_env();
    for (name, raw, want) in [
        (
            "cp949",
            cp949("한글\n"),
            r#"{"file.convert_utf8":{"ok":true}}"#,
        ),
        (
            "utf-8",
            b"a\n".to_vec(),
            r#"{"file.convert_utf8":{"ok":false,"why":"already_utf8"}}"#,
        ),
        (
            "undecodable",
            UNDECODABLE.to_vec(),
            r#"{"file.convert_utf8":{"ok":false,"why":"encoding_undecodable"}}"#,
        ),
    ] {
        let path = p(&e, &format!("{name}.txt"));
        write(&path, &raw);
        let r = read(&e, &path, "&decode=1").await;
        assert_eq!(r.header(FILE_ACTIONS_HEADER), want, "{name}");
    }
}

#[tokio::test]
async fn file_write_convert_rejects_with_answer() {
    let e = file_env();
    for raw in [b"a\n".to_vec(), UNDECODABLE.to_vec()] {
        let path = p(&e, "rej.txt");
        write(&path, &raw);
        let r = read(&e, &path, "&decode=1").await;
        let want = actions_of(&r)[action::FILE_CONVERT_UTF8].clone();
        let w = write_req(
            &e,
            json!({"path": path, "content": "x\n", "encoding": "utf-8", "convertFrom": r.header("X-File-Encoding")}),
        )
        .await;
        assert_eq!(want["ok"], false);
        assert_eq!(w.header("X-Error-Code"), want["why"].as_str().unwrap());
        assert_eq!(w.status, convert_utf8_answer(&raw, textenc::UTF8).status);
        assert_eq!(w.text(), format!("{}\n", want["why"].as_str().unwrap()));
        assert_eq!(read_file(&path), raw);
    }
}

#[tokio::test]
async fn file_write_convert_succeeds_and_answer_follows() {
    let e = file_env();
    let k = p(&e, "k.txt");
    write(&k, &cp949("한글\n"));
    let r = write_req(
        &e,
        json!({"path": k, "content": "한글\n", "encoding": "utf-8", "convertFrom": "cp949"}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(read_file(&k), "한글\n".as_bytes());
    let out = r.json();
    assert_eq!(
        out["actions"]["file.convert_utf8"],
        json!({"ok": false, "why": "already_utf8"})
    );
    assert_eq!(out["ok"], true);
    let stamp = out["stamp"].as_str().unwrap();
    assert!(
        r.text()
            .ends_with(&format!(",\"ok\":true,\"stamp\":{}}}\n", jq(stamp))),
        "{}",
        r.text()
    );
}

#[tokio::test]
async fn file_write_without_convert_unchanged() {
    let e = file_env();
    let u = p(&e, "u.txt");
    write(&u, b"a\n");
    let r = write_req(
        &e,
        json!({"path": u, "content": "b\n", "encoding": "utf-8"}),
    )
    .await;
    assert_eq!(r.status, 200);
}

// ── 표식 (handlers_files_stamp_test.go · handlers_files_stamps_test.go) ─────────

async fn write_stamped(e: &FileEnv, path: &str, content: &str, stamp: &str) -> super::fsenv::Res {
    let mut m = json!({"path": path, "content": content});
    if !stamp.is_empty() {
        m["stamp"] = json!(stamp);
    }
    write_req(e, m).await
}

#[tokio::test]
async fn file_read_gives_stamp_and_matching_write_succeeds() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    let r = read(&e, &t, "").await;
    let stamp = r.header("X-File-Stamp");
    assert_ne!(stamp, "");
    let w = write_stamped(&e, &t, "edited\n", &stamp).await;
    assert_eq!(w.status, 200, "{}", w.text());
    assert_eq!(read_file(&t), b"edited\n");
}

#[tokio::test]
async fn file_write_stamp_mismatch_is_409() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    let stamp = read(&e, &t, "").await.header("X-File-Stamp");
    write(&t, b"changed by someone else\n");
    let w = write_stamped(&e, &t, "edited\n", &stamp).await;
    assert_eq!(w.status, 409);
    assert_eq!(w.text(), "file changed on disk\n");
    assert_eq!(w.header("X-Error-Code"), apierr::CODE_FILE_CHANGED);
    assert_eq!(read_file(&t), b"changed by someone else\n");
}

#[tokio::test]
async fn file_write_no_stamp_writes_even_when_changed() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    write(&t, b"changed by someone else\n");
    assert_eq!(write_stamped(&e, &t, "edited\n", "").await.status, 200);
    assert_eq!(read_file(&t), b"edited\n");
}

#[tokio::test]
async fn file_write_response_carries_next_stamp() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    let stamp = read(&e, &t, "").await.header("X-File-Stamp");
    let w = write_stamped(&e, &t, "first\n", &stamp).await;
    let next = w.json()["stamp"].as_str().unwrap().to_owned();
    assert_ne!(next, "");
    assert_eq!(write_stamped(&e, &t, "second\n", &next).await.status, 200);
    assert_eq!(read_file(&t), b"second\n");
}

#[tokio::test]
async fn file_write_stamp_on_deleted_file_creates() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    let stamp = read(&e, &t, "").await.header("X-File-Stamp");
    std::fs::remove_file(&t).unwrap();
    assert_eq!(write_stamped(&e, &t, "edited\n", &stamp).await.status, 200);
    assert_eq!(read_file(&t), b"edited\n");
}

#[tokio::test]
async fn file_write_leaves_no_backup_generations() {
    let e = file_env();
    let t = p(&e, "note.txt");
    write(&t, b"hello\n");
    assert_eq!(write_stamped(&e, &t, "edited\n", "").await.status, 200);
    assert!(std::fs::metadata(format!("{t}.bak.1")).is_err());
}

#[test]
fn stamp_shape_matches_go() {
    let e = file_env();
    let t = p(&e, "s.txt");
    write(&t, b"abc");
    let fi = std::fs::metadata(&t).unwrap();
    let ns = crate::files_stamp::mod_nano(&fi);
    assert_eq!(crate::files_stamp::file_stamp(&fi), format!("{ns:x}-3"));
    assert_eq!(crate::fs_stamp::fs_stamp_of(&fi), ns.to_string());
}

async fn file_stamps(e: &FileEnv, paths: &[String]) -> super::fsenv::Res {
    post(
        &e.srv,
        "/api/file/stamps",
        &json!({"paths": paths}).to_string(),
    )
    .await
}

#[tokio::test]
async fn file_stamps_matches_read_header_and_changes() {
    let e = file_env();
    let a = p(&e, "a.txt");
    let b = p(&e, "b.txt");
    write(&a, b"alpha\n");
    write(&b, b"beta\n");
    let wa = read(&e, &a, "").await.header("X-File-Stamp");
    let wb = read(&e, &b, "").await.header("X-File-Stamp");
    let r = file_stamps(&e, &[a.clone(), b.clone()]).await;
    assert_eq!(r.status, 200);
    let got = r.json();
    assert_eq!(got["stamps"][&a], wa.as_str());
    assert_eq!(got["stamps"][&b], wb.as_str());

    write(&a, "after — 길이가 달라졌다\n".as_bytes());
    let again = file_stamps(&e, std::slice::from_ref(&a)).await.json();
    assert_ne!(again["stamps"][&a], wa.as_str());
}

#[tokio::test]
async fn file_stamps_skips_unreadable_and_missing() {
    let e = file_env();
    let ok = p(&e, "ok.txt");
    write(&ok, b"ok\n");
    let missing = p(&e, "gone.txt");
    let r = file_stamps(
        &e,
        &[missing.clone(), e.root.clone(), ok.clone(), "rel".into()],
    )
    .await;
    assert_eq!(r.status, 200);
    let stamps = r.json()["stamps"].as_object().unwrap().clone();
    assert_eq!(stamps.keys().collect::<Vec<_>>(), vec![&ok]);
}

#[tokio::test]
async fn file_stamps_too_many_paths() {
    let e = file_env();
    let paths = vec![p(&e, "f.txt"); FILE_STAMPS_MAX + 1];
    let r = file_stamps(&e, &paths).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.text(), "too many paths (max 512)\n");
    let r = post(&e.srv, "/api/file/stamps", "").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_INVALID_JSON);
}

// ── 경합 (handlers_files_write_race_test.go · handlers_files_rw_verdict_test.go) ─────────

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn file_write_same_stamp_concurrent_only_one_wins() {
    let e = file_env();
    let t = p(&e, "race.txt");
    write(&t, b"base\n");
    let stamp = read(&e, &t, "").await.header("X-File-Stamp");
    let mut tasks = Vec::new();
    for i in 0..8u8 {
        let srv = e.srv.clone();
        let body = json!({"path": t, "content": ((b'a' + i) as char).to_string().repeat(4 << 20), "stamp": stamp}).to_string();
        tasks.push(tokio::spawn(async move {
            post(&srv, "/api/file/write", &body).await.status
        }));
    }
    let mut ok = 0;
    for t in tasks {
        match t.await.unwrap() {
            200 => ok += 1,
            409 => {}
            c => panic!("예상 밖 상태 {c}"),
        }
    }
    assert_eq!(ok, 1);
}

#[tokio::test]
async fn path_locks_release_entries() {
    let p = PathLocks::default();
    let u1 = p.lock("/a").await;
    let u2 = p.lock("/b").await;
    assert_eq!(p.size(), 2);
    drop(u1);
    drop(u2);
    assert_eq!(p.size(), 0);
}

#[test]
fn stamp_conflict_verdict() {
    assert!(!stamp_conflict("a", ""));
    assert!(!stamp_conflict("a", "a"));
    assert!(stamp_conflict("a", "b"));
}

#[test]
fn lsp_watch_type_verdict() {
    assert_eq!(lsp_watch_type(true), dm_webserver_domain_lsp::WATCH_CHANGED);
    assert_eq!(
        lsp_watch_type(false),
        dm_webserver_domain_lsp::WATCH_CREATED
    );
}

/// 저장이 LSP 에 그 경로의 변경을 알린다 (FR-CMR-110).
#[tokio::test]
async fn file_write_notifies_lsp() {
    use std::sync::{Arc, Mutex};

    use dm_webserver_domain_lsp::FileEvent;

    #[derive(Default)]
    struct Rec(Mutex<Vec<FileEvent>>);
    impl crate::LspService for Rec {
        fn notify_files(&self, events: Vec<FileEvent>) {
            self.0.lock().unwrap().extend(events);
        }
        fn status(&self) -> (Vec<dm_webserver_domain_ext::Status>, Vec<String>) {
            Default::default()
        }
        fn open_tunnel(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Arc<dyn dm_webserver_domain_lsp::Tunnel>, dm_webserver_domain_lsp::OpenError>
        {
            Err(dm_webserver_domain_lsp::OpenError::Limit)
        }
        fn paths(&self) -> std::collections::HashMap<String, String> {
            Default::default()
        }
        fn set_paths(
            &self,
            next: std::collections::HashMap<String, String>,
        ) -> Result<std::collections::HashMap<String, String>, dm_webserver_domain_lsp::PathsError>
        {
            Ok(next)
        }
        fn install<'a>(
            &'a self,
            _: &'a dm_webserver_domain_ext::Ctx,
            _: &'a str,
        ) -> futures_util::future::BoxFuture<'a, dm_webserver_domain_ext::Outcome> {
            Box::pin(async { Default::default() })
        }
    }
    let rec = Arc::new(Rec::default());
    let r2 = rec.clone();
    let e = file_env_with(move |s| s.deps.lsp = Some(r2));
    let t = p(&e, "n.txt");
    assert_eq!(write_simple(&e, &t, "1").await.status, 200);
    assert_eq!(write_simple(&e, &t, "2").await.status, 200);
    let got = rec.0.lock().unwrap().clone();
    assert_eq!(
        got,
        vec![
            FileEvent {
                path: t.clone(),
                typ: dm_webserver_domain_lsp::WATCH_CREATED
            },
            FileEvent {
                path: t,
                typ: dm_webserver_domain_lsp::WATCH_CHANGED
            },
        ]
    );
    let _: Answer = action::allow();
}
