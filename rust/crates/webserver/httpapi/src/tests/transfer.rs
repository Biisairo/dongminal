//! `/api/{upload,download,cwd}` 의 시험 (Go `handlers_transfer_test.go`·`handlers_term_relpath_test.go`·
//! `handlers_upload_actions_test.go`) 과 multipart·미디어 형 판정.

use std::sync::Arc;

use dm_webserver_action::{self as action};
use dm_webserver_apierr as apierr;
use serde_json::json;

use super::fsenv::{
    Env, FakeHub, exists, fs_env, fs_env_with, get, qe, req, seed_root, temp_dir, upload, write,
};
use crate::files::{is_filesystem_root, safe_resolve, unique_path};
use crate::files_transfer::{
    CWD_SOURCE_SERVER, CWD_SOURCE_TOOL, attachment_disposition, term_upload_answer,
};
use crate::mediatype::parse_media_type;
use crate::{Deps, ToolHub};

fn transfer_env(root: &str) -> Env {
    let e = fs_env();
    seed_root(&e.ws, root);
    e
}

#[tokio::test]
async fn download_content_disposition_non_ascii() {
    let (_d, root) = temp_dir();
    let name = "한글 파일 이름.txt";
    write(&format!("{root}/{name}"), b"x");
    let e = transfer_env(&root);
    let r = get(
        &e.srv,
        &format!("/api/download?path={}", qe(&format!("{root}/{name}"))),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.header("Content-Disposition"),
        "attachment; filename=\"__ __ __.txt\"; filename*=UTF-8''%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC%20%EC%9D%B4%EB%A6%84.txt"
    );
    assert_eq!(r.header("Content-Type"), "application/octet-stream");
    assert_eq!(r.header("Content-Length"), "1");
    assert_eq!(r.body, b"x");
    let (_, params) = parse_media_type(r.header("Content-Disposition").as_bytes()).unwrap();
    assert_eq!(params["filename"], name.as_bytes());
}

#[test]
fn content_disposition_quote_escape_and_fallback() {
    assert_eq!(
        attachment_disposition("a\"b\\c.txt"),
        "attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b%5Cc.txt"
    );
    assert_eq!(
        attachment_disposition("한"),
        "attachment; filename=\"_\"; filename*=UTF-8''%ED%95%9C"
    );
    assert_eq!(
        attachment_disposition(" "),
        "attachment; filename=\"download\"; filename*=UTF-8''%20"
    );
}

#[tokio::test]
async fn download_directory_and_not_found() {
    let (_d, root) = temp_dir();
    let sub = format!("{root}/sub");
    std::fs::create_dir(&sub).unwrap();
    let e = transfer_env(&root);
    let r = get(&e.srv, &format!("/api/download?path={}", qe(&sub))).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("Content-Disposition"), "");
    assert_eq!(r.text(), "not a file\n");
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_BAD_REQUEST);
    let r = get(
        &e.srv,
        &format!("/api/download?path={}", qe(&format!("{root}/nope.txt"))),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.text(), "not found\n");
    let r = get(&e.srv, "/api/download").await;
    assert_eq!((r.status, r.text().as_str()), (400, "missing path\n"));
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_MISSING_ARG);
    let r = get(&e.srv, "/api/download?path=relative-nope.txt").await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn upload_max_bytes() {
    let (_d, root) = temp_dir();
    let e = fs_env_with(Deps::default(), |s| s.limits.upload_max_bytes = 64);
    seed_root(&e.ws, &root);
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(&root)),
        "big.txt",
        &[b'x'; 4096],
        &[],
    )
    .await;
    assert_eq!(r.status, 413, "{}", r.text());
    assert_eq!(r.text(), "upload too large\n");
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_TOO_LARGE);
    assert_eq!(r.header("Connection"), "close");
    assert!(!exists(format!("{root}/big.txt")));
}

#[tokio::test]
async fn upload_missing_dir() {
    let (_d, root) = temp_dir();
    let e = transfer_env(&root);
    let gone = format!("{root}/no-such-dir");
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(&gone)),
        "a.txt",
        b"a",
        &[],
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.text(), "upload directory not found\n");
    assert!(!exists(&gone));
    let f = format!("{root}/f.txt");
    write(&f, b"f");
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(&f)),
        "a.txt",
        b"a",
        &[],
    )
    .await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn upload_ok_and_unique_path_kept() {
    let (_d, root) = temp_dir();
    write(&format!("{root}/dup.txt"), b"x");
    let e = transfer_env(&root);
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(&root)),
        "dup.txt",
        b"y",
        &[],
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let path = format!("{root}/dup (1).txt");
    assert_eq!(
        r.text(),
        format!(
            "{{\"name\":\"dup (1).txt\",\"path\":{},\"size\":1}}\n",
            super::fsenv::jq(&path)
        )
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"y");
    assert_eq!(unique_path(&root, "dup.txt"), format!("{root}/dup (2).txt"));
    assert_eq!(unique_path(&root, "new"), format!("{root}/new"));
}

#[tokio::test]
async fn upload_not_multipart_or_no_file_is_400() {
    let (_d, root) = temp_dir();
    let e = transfer_env(&root);
    let target = format!("/api/upload?dir={}", qe(&root));
    // Content-Type 이 없으면 요청 게이트가 먼저 415 로 막는다 (reqgate).
    for (ct, body) in [
        ("application/json", "{}".to_owned()),
        ("multipart/form-data", "--b--\r\n".to_owned()),
        ("multipart/form-data; boundary=b", "--b--\r\n".to_owned()),
        (
            "multipart/form-data; boundary=b",
            "--b\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nvalue\r\n--b--\r\n"
                .to_owned(),
        ),
        (
            "multipart/form-data; boundary=b",
            "--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\ncut"
                .to_owned(),
        ),
    ] {
        let r = req(&e.srv, "POST", &target, ct, body.clone()).await;
        assert_eq!(
            (r.status, r.text().as_str()),
            (400, "no file in request\n"),
            "{ct} {body:?}"
        );
    }
    // 쿼리를 풀지 못하면 Go `ParseMultipartForm` 이 실패한다.
    let (b, ct) = super::fsenv::multipart("a.txt", b"a", &[]);
    let r = req(&e.srv, "POST", &format!("{target}&x=%zz"), &ct, b).await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn upload_multipart_variants() {
    let (_d, root) = temp_dir();
    let e = transfer_env(&root);
    let target = format!("/api/upload?dir={}", qe(&root));
    // 줄바꿈이 \n 뿐이고 서문·끝 공백이 있어도 Go 처럼 받는다. 파일 이름은 마지막 조각만 쓴다.
    let body = "preamble\n--xyz  \nContent-Disposition: form-data; name=\"file\"; filename=\"dir/sub/n.txt\"\n\nline1\n--xyzNOT\nline2\n--xyz--\n";
    let r = req(
        &e.srv,
        "POST",
        &target,
        "multipart/form-data; boundary=\"xyz\"",
        body,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        std::fs::read(format!("{root}/n.txt")).unwrap(),
        b"line1\n--xyzNOT\nline2"
    );
    // RFC 2231 이름.
    let body = "--b\r\nContent-Disposition: form-data; name=\"file\"; filename*=UTF-8''%ED%95%9C.txt\r\n\r\nk\r\n--b--";
    let r = req(
        &e.srv,
        "POST",
        &target,
        "multipart/form-data; boundary=b",
        body,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["name"], "한.txt");
}

#[tokio::test]
async fn upload_large_file_spools_to_disk() {
    let (_d, root) = temp_dir();
    let e = transfer_env(&root);
    let content: Vec<u8> = (0..(33u32 << 20)).map(|i| (i % 251) as u8).collect();
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(&root)),
        "big.bin",
        &content,
        &[],
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["size"], content.len());
    assert!(std::fs::read(format!("{root}/big.bin")).unwrap() == content);
}

#[tokio::test]
async fn cwd_source() {
    let (_d, root) = temp_dir();
    let hub: Arc<dyn ToolHub> = FakeHub::with_cwd("p1", "/tmp/tool-cwd");
    let e = fs_env_with(
        Deps {
            tools: Some(hub),
            ..Deps::default()
        },
        |_| {},
    );
    seed_root(&e.ws, &root);
    let r = get(&e.srv, "/api/cwd?tool=p1").await;
    assert_eq!(
        r.text(),
        "{\"actions\":{\"term.upload\":{\"ok\":true}},\"cwd\":\"/tmp/tool-cwd\",\"source\":\"tool\"}\n"
    );
    let r = get(&e.srv, "/api/cwd?tool=unknown").await;
    let out = r.json();
    assert_eq!(out["source"], "server");
    assert_eq!(
        out["actions"]["term.upload"],
        json!({"ok": false, "why": "upload_no_tool_cwd"})
    );
    let wd = std::env::current_dir().unwrap();
    assert_eq!(
        std::fs::canonicalize(out["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(wd).unwrap()
    );
}

#[test]
fn safe_resolve_root_base_imposes_no_limit() {
    for base in ["/", "//"] {
        for p in ["/x/y.txt", "/tmp", "/", "/a/../b"] {
            let got = safe_resolve(base, p).unwrap();
            assert_eq!(got, dm_gocompat::filepath::clean(p), "{base} {p}");
        }
    }
    assert!(is_filesystem_root("/"));
    assert!(!is_filesystem_root("/srv"));
}

#[test]
fn safe_resolve_non_root_base_still_guards() {
    assert!(safe_resolve("/srv/app", "/srv/other/f.txt").is_err());
    assert_eq!(
        safe_resolve("/srv/app", "/srv/app/f.txt"),
        Ok("/srv/app/f.txt".to_owned())
    );
    // `..b` 같은 이름도 막는다 — 이 가드의 알려진 성질이다 (fsUnderRoot 와 다르다).
    assert!(safe_resolve("/srv/app", "/srv/app/../app..b").is_err());
}

// ── relPath (handlers_term_relpath_test.go) ─────────

async fn term_upload(
    e: &Env,
    dir: &str,
    name: &str,
    rel: &str,
    content: &[u8],
) -> super::fsenv::Res {
    let values: Vec<(&str, &str)> = if rel.is_empty() {
        vec![]
    } else {
        vec![("relPath", rel)]
    };
    upload(
        &e.srv,
        &format!("/api/upload?dir={}", qe(dir)),
        name,
        content,
        &values,
    )
    .await
}

#[tokio::test]
async fn term_upload_rel_path_creates_dirs_and_without_unchanged() {
    let (_d, dir) = temp_dir();
    let e = transfer_env(&dir);
    let r = term_upload(&e, &dir, "c.txt", "top/sub/c.txt", b"hi\n").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        std::fs::read(format!("{dir}/top/sub/c.txt")).unwrap(),
        b"hi\n"
    );
    let r = term_upload(&e, &dir, "flat.txt", "", b"x\n").await;
    assert_eq!(r.status, 200);
    assert_eq!(std::fs::read(format!("{dir}/flat.txt")).unwrap(), b"x\n");
}

#[tokio::test]
async fn term_upload_rel_path_renames_leaf_only() {
    let (_d, dir) = temp_dir();
    let e = transfer_env(&dir);
    assert_eq!(
        term_upload(&e, &dir, "c.txt", "top/c.txt", b"first\n")
            .await
            .status,
        200
    );
    let r = term_upload(&e, &dir, "c.txt", "top/c.txt", b"second\n").await;
    assert_eq!(r.status, 200);
    assert!(!exists(format!("{dir}/top (1)")));
    assert_eq!(
        std::fs::read(format!("{dir}/top/c.txt")).unwrap(),
        b"first\n"
    );
    assert_eq!(r.json()["name"], "c (1).txt");
    assert_eq!(
        std::fs::read(format!("{dir}/top/c (1).txt")).unwrap(),
        b"second\n"
    );
}

#[tokio::test]
async fn term_upload_rel_path_rejects_escape() {
    let (_d, base) = temp_dir();
    let dir = format!("{base}/cwd");
    std::fs::create_dir(&dir).unwrap();
    let e = transfer_env(&base);
    for (rel, msg) in [
        ("../out.txt", "relPath 가 대상 밖을 가리킨다"),
        ("a/../../out.txt", "relPath 가 대상 밖을 가리킨다"),
        ("/abs.txt", "relPath 는 상대경로여야 한다"),
    ] {
        let r = term_upload(&e, &dir, "out.txt", rel, b"nope\n").await;
        assert_eq!((r.status, r.text()), (400, format!("{msg}\n")), "{rel}");
        assert!(!exists(format!("{base}/out.txt")));
    }
}

#[tokio::test]
async fn term_upload_query_rel_path_wins() {
    let (_d, dir) = temp_dir();
    let e = transfer_env(&dir);
    let r = upload(
        &e.srv,
        &format!("/api/upload?dir={}&relPath=q/a.txt", qe(&dir)),
        "a.txt",
        b"a",
        &[("relPath", "body/a.txt")],
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(exists(format!("{dir}/q/a.txt")));
    assert!(!exists(format!("{dir}/body")));
}

#[tokio::test]
async fn term_upload_rel_path_existing_dir_is_fine() {
    let (_d, dir) = temp_dir();
    let e = transfer_env(&dir);
    assert_eq!(
        term_upload(&e, &dir, "a.txt", "top/a.txt", b"a\n")
            .await
            .status,
        200
    );
    assert_eq!(
        term_upload(&e, &dir, "b.txt", "top/b.txt", b"b\n")
            .await
            .status,
        200
    );
    assert_eq!(std::fs::read(format!("{dir}/top/a.txt")).unwrap(), b"a\n");
    assert_eq!(std::fs::read(format!("{dir}/top/b.txt")).unwrap(), b"b\n");
}

// ── 드롭 업로드의 답 (handlers_upload_actions_test.go) ─────────

#[test]
fn term_upload_answer_cases() {
    let cat = action::catalog();
    for (cwd, source, ok) in [
        ("/w", CWD_SOURCE_TOOL, true),
        ("/w", CWD_SOURCE_SERVER, false),
        ("", CWD_SOURCE_TOOL, false),
    ] {
        let a = term_upload_answer(cwd, source);
        assert_eq!(a.ok, ok);
        if !a.ok {
            assert_eq!(
                (a.why.as_str(), a.status),
                (apierr::CODE_UPLOAD_NO_TOOL_CWD, 409)
            );
            assert!(action::may_give(&cat, action::TERM_UPLOAD, &a.why));
        }
    }
}

fn tool_env(cwd: &str) -> Env {
    let hub: Arc<dyn ToolHub> = FakeHub::with_cwd("p1", cwd);
    fs_env_with(
        Deps {
            tools: Some(hub),
            ..Deps::default()
        },
        |_| {},
    )
}

#[tokio::test]
async fn upload_to_tool_cwd() {
    let (_c, cwd) = temp_dir();
    let (_o, other) = temp_dir();
    let e = tool_env(&cwd);
    let r = upload(
        &e.srv,
        &format!("/api/upload?tool=p1&dir={}", qe(&other)),
        "a.txt",
        b"hi\n",
        &[],
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(exists(format!("{cwd}/a.txt")));
    assert!(!exists(format!("{other}/a.txt")));
}

#[tokio::test]
async fn upload_rejects_with_answer() {
    let (_c, cwd) = temp_dir();
    let (_o, other) = temp_dir();
    let e = tool_env(&cwd);
    let r = upload(
        &e.srv,
        &format!("/api/upload?tool=p2&dir={}", qe(&other)),
        "a.txt",
        b"hi\n",
        &[],
    )
    .await;
    assert_eq!(r.status, 409);
    assert_eq!(r.header("X-Error-Code"), apierr::CODE_UPLOAD_NO_TOOL_CWD);
    assert_eq!(r.text(), "upload_no_tool_cwd\n");
    assert!(!exists(format!("{other}/a.txt")));
}

// ── 미디어 형 (Go mime.ParseMediaType) ─────────

#[test]
fn parse_media_type_cases() {
    let ok = |v: &str| parse_media_type(v.as_bytes()).unwrap();
    let (t, p) = ok("Multipart/Form-Data; Boundary=\"a b\"");
    assert_eq!(
        (t.as_str(), p["boundary"].as_slice()),
        ("multipart/form-data", b"a b".as_slice())
    );
    let (t, p) = ok("form-data; name=\"file\"; filename=\"a\\\"b.txt\"");
    assert_eq!(t, "form-data");
    assert_eq!(p["filename"], b"a\"b.txt");
    let (_, p) = ok("form-data; filename*0=\"ab\"; filename*1=\"cd\"");
    assert_eq!(p["filename"], b"abcd");
    let (_, p) = ok("form-data; name=x;");
    assert_eq!(p["name"], b"x");
    for bad in [
        "",
        "a/",
        "a/b/c",
        "form-data; name",
        "form-data; a=1; a=2",
        "form-data; =x",
    ] {
        assert!(parse_media_type(bad.as_bytes()).is_err(), "{bad}");
    }
}
