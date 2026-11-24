//! `/api/fs/list`·`/api/editors/*` 의 시험 (Go `handlers_fs_test.go`·`handlers_fs_paging_test.go`·
//! `handlers_editors_check_test.go`).

use std::sync::Arc;

use otter_webserver_action::{self as action};
use otter_webserver_apierr as apierr;
use otter_webserver_domain_wsentry::normalize_path;
use serde_json::Value;

use super::fsenv::{Env, fs_env, get, jq, post, qe, seed_root, temp_dir, write};
use crate::Server;
use crate::fs::{FS_ERR_BAD_REQUEST, FS_ERR_NOT_FOUND, FS_ERR_OUTSIDE_ROOT, fs_under_root};
use crate::routes::API_ROUTES;

fn names(out: &Value) -> Vec<String> {
    out["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("entries 가 없다: {out}"))
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect()
}

async fn list(srv: &Arc<Server>, root: &str, dir: &str, extra: &str) -> (u16, Value) {
    let r = get(
        srv,
        &format!("/api/fs/list?root={}&path={}{extra}", qe(root), qe(dir)),
    )
    .await;
    (r.status, r.json())
}

/// 루트 하나를 Editor 목록에 둔 서버와 그 루트(평평한 파일 n 개).
fn flat(n: usize) -> (Env, String, tempfile::TempDir) {
    let e = fs_env();
    let (d, root) = temp_dir();
    for i in 0..n {
        write(&format!("{root}/f{i:04}.txt"), b"");
    }
    seed_root(&e.ws, &root);
    (e, root, d)
}

#[tokio::test]
async fn editor_add_answer_matches_rejection() {
    let e = fs_env();
    let (_d, dir) = temp_dir();
    let file = format!("{dir}/f.txt");
    write(&file, b"");
    let cases = [
        (String::new(), apierr::CODE_EMPTY_PATH),
        ("rel/dir".to_owned(), apierr::CODE_ABS_PATH_NEEDED),
        (format!("{dir}/gone"), apierr::CODE_NOT_FOUND),
        (file.clone(), apierr::CODE_NOT_A_DIRECTORY),
        ("/".to_owned(), apierr::CODE_FILESYSTEM_ROOT_PROTECTED),
    ];
    for (path, why) in cases {
        let body = format!(r#"{{"path":{}}}"#, jq(&path));
        let r = post(&e.srv, "/api/editors/validate", &body).await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(
            r.text(),
            format!(r#"{{"actions":{{"editor.add":{{"ok":false,"why":"{why}"}}}}}}"#) + "\n"
        );
        let r = post(&e.srv, "/api/editors/add", &body).await;
        assert_eq!(r.status, apierr::fs_status(why), "{path}");
        assert_eq!(r.text(), format!(r#"{{"code":"{why}"}}"#) + "\n");
        assert_eq!(r.header("X-Error-Code"), why);
    }
    let body = format!(r#"{{"path":{}}}"#, jq(&dir));
    let r = post(&e.srv, "/api/editors/validate", &body).await;
    assert_eq!(r.text(), "{\"actions\":{\"editor.add\":{\"ok\":true}}}\n");
    assert_eq!(post(&e.srv, "/api/editors/add", &body).await.status, 200);
    let cat = action::catalog();
    for why in [
        apierr::CODE_EMPTY_PATH,
        apierr::CODE_ABS_PATH_NEEDED,
        apierr::CODE_NOT_FOUND,
        apierr::CODE_NOT_A_DIRECTORY,
        apierr::CODE_FILESYSTEM_ROOT_PROTECTED,
    ] {
        assert!(action::may_give(&cat, action::EDITOR_ADD, why), "{why}");
    }
}

fn routed(method: &str, path: &str) -> bool {
    API_ROUTES
        .iter()
        .any(|rt| (rt.method.is_empty() || rt.method == method) && rt.matcher.matches(path))
}

#[test]
fn fs_routes_registered() {
    for (m, p) in [
        ("GET", "/api/fs/list"),
        ("GET", "/api/editors"),
        ("POST", "/api/editors/add"),
        ("POST", "/api/editors/validate"),
        ("POST", "/api/editors/remove"),
        ("POST", "/api/editors/reorder"),
        ("POST", "/api/upload"),
        ("GET", "/api/download"),
        ("GET", "/api/cwd"),
        ("GET", "/api/file/read"),
        ("POST", "/api/file/write"),
        ("POST", "/api/file/stamps"),
        ("GET", "/api/file/probe"),
        ("GET", "/api/file/raw"),
    ] {
        assert!(routed(m, p), "{m} {p}");
        assert!(crate::serve::should_log_request(p, 200), "{p}");
    }
}

#[test]
fn fs_under_root_allows_dot_dot_names() {
    let (_d, root) = temp_dir();
    for name in ["..b", "...", ".git", "normal"] {
        let p = format!("{root}/{name}");
        assert_eq!(fs_under_root(&root, &p), Ok(p.clone()), "{name}");
    }
    let parent = otter_gocompat::filepath::dir(&root);
    assert!(fs_under_root(&root, &parent).is_err());
    assert!(fs_under_root(&root, &format!("{root}-sibling")).is_err());
}

#[tokio::test]
async fn fs_list_includes_dot_entries() {
    let (e, root, _d) = flat(0);
    write(&format!("{root}/.hidden"), b"");
    write(&format!("{root}/visible.txt"), b"");
    std::fs::create_dir(format!("{root}/.dotdir")).unwrap();
    let (code, out) = list(&e.srv, &root, &root, "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(names(&out), [".dotdir", ".hidden", "visible.txt"]);
    assert_eq!(out["truncated"], false);
    assert_eq!(out["path"], root.as_str());
    let first = out["entries"][0].as_object().unwrap();
    assert_eq!(
        first.keys().collect::<Vec<_>>(),
        ["name", "dir", "link", "linkDir"]
    );
}

#[tokio::test]
async fn fs_list_wire_shape() {
    let (e, root, _d) = flat(1);
    std::fs::create_dir(format!("{root}/B")).unwrap();
    std::fs::create_dir(format!("{root}/a")).unwrap();
    let r = get(
        &e.srv,
        &format!("/api/fs/list?root={}&path={}", qe(&root), qe(&root)),
    )
    .await;
    let st = crate::fs_stamp::fs_stamp_of(&std::fs::metadata(&root).unwrap());
    assert_eq!(
        r.text(),
        format!(
            concat!(
                r#"{{"entries":[{{"name":"a","dir":true,"link":false,"linkDir":false}},"#,
                r#"{{"name":"B","dir":true,"link":false,"linkDir":false}},"#,
                r#"{{"name":"f0000.txt","dir":false,"link":false,"linkDir":false}}],"#,
                r#""offset":0,"path":{},"stamp":"{}","total":3,"truncated":false}}"#,
                "\n"
            ),
            jq(&root),
            st
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn fs_list_link_entries() {
    let (e, root, _d) = flat(0);
    std::fs::create_dir(format!("{root}/d")).unwrap();
    write(&format!("{root}/f.txt"), b"");
    std::os::unix::fs::symlink(format!("{root}/d"), format!("{root}/ld")).unwrap();
    std::os::unix::fs::symlink(format!("{root}/f.txt"), format!("{root}/lf")).unwrap();
    let (_, out) = list(&e.srv, &root, &root, "").await;
    let get = |n: &str| {
        out["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == n)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        (
            get("ld")["dir"].clone(),
            get("ld")["link"].clone(),
            get("ld")["linkDir"].clone()
        ),
        (false.into(), true.into(), true.into())
    );
    assert_eq!(
        (
            get("lf")["dir"].clone(),
            get("lf")["link"].clone(),
            get("lf")["linkDir"].clone()
        ),
        (false.into(), true.into(), false.into())
    );
    assert_eq!(
        (get("d")["dir"].clone(), get("d")["link"].clone()),
        (true.into(), false.into())
    );
}

#[tokio::test]
async fn fs_list_truncates_without_failing() {
    let e = super::fsenv::fs_env_with(crate::Deps::default(), |s| s.limits.fs_list = 3);
    let (_d, root) = temp_dir();
    for i in 0..5 {
        write(&format!("{root}/f{i}"), b"");
    }
    seed_root(&e.ws, &root);
    let (code, out) = list(&e.srv, &root, &root, "").await;
    assert_eq!(code, 200);
    assert_eq!(out["truncated"], true);
    assert_eq!(names(&out).len(), 3);
    assert_eq!(out["total"], 5);
}

#[tokio::test]
async fn fs_rejects_unknown_root() {
    let e = fs_env();
    let (_d, other) = temp_dir();
    seed_root(&e.ws, &other);
    let (code, out) = list(&e.srv, "/etc", "/etc", "").await;
    assert_eq!(code, 403);
    assert_eq!(out["code"], FS_ERR_OUTSIDE_ROOT);
    assert_eq!(out["message"], "root 가 Editor 목록에 없다");
    let (code, out) = list(&e.srv, &e.home, &e.home, "").await;
    assert_eq!(code, 200, "{out}");
}

#[tokio::test]
async fn fs_rejects_relative_paths() {
    let e = fs_env();
    let (_d, root) = temp_dir();
    seed_root(&e.ws, &root);
    let (code, out) = list(&e.srv, "rel", &root, "").await;
    assert_eq!(
        (code, out["code"].as_str()),
        (400, Some(FS_ERR_BAD_REQUEST))
    );
    assert_eq!(out["message"], "root 는 절대경로여야 한다");
    let (code, out) = list(&e.srv, &root, "rel", "").await;
    assert_eq!(
        (code, out["code"].as_str()),
        (400, Some(FS_ERR_BAD_REQUEST))
    );
    assert_eq!(out["message"], "path 는 절대경로여야 한다");
    let r = get(&e.srv, &format!("/api/fs/list?root={}", qe(&root))).await;
    assert_eq!(r.json()["message"], "path 가 없다");
    let r = get(&e.srv, "/api/fs/list").await;
    assert_eq!(r.json()["message"], "root 가 없다");
    for (path, body) in [
        ("/api/editors/remove", r#"{"path":"rel"}"#.to_owned()),
        (
            "/api/editors/reorder",
            format!(r#"{{"src":"rel","target":{}}}"#, jq(&root)),
        ),
        ("/api/editors/reorder", r#"{"src":""}"#.to_owned()),
    ] {
        let r = post(&e.srv, path, &body).await;
        assert_eq!(
            (r.status, r.json()["code"].as_str()),
            (400, Some(FS_ERR_BAD_REQUEST)),
            "{path} {body}"
        );
    }
    let r = post(&e.srv, "/api/editors/add", r#"{"path":"rel"}"#).await;
    assert_eq!(
        (r.status, r.json()["code"].as_str()),
        (400, Some(apierr::CODE_ABS_PATH_NEEDED))
    );
}

#[tokio::test]
async fn fs_error_shape() {
    let e = fs_env();
    let (_d, root) = temp_dir();
    seed_root(&e.ws, &root);
    let r = get(
        &e.srv,
        &format!("/api/fs/list?root={}&path={}/nope", qe(&root), qe(&root)),
    )
    .await;
    assert_eq!(r.status, 404);
    assert_eq!(r.header("X-Error-Code"), FS_ERR_NOT_FOUND);
    assert_eq!(
        r.text(),
        "{\"code\":\"not_found\",\"message\":\"경로를 찾을 수 없다\"}\n"
    );
    write(&format!("{root}/file"), b"");
    let r = get(
        &e.srv,
        &format!("/api/fs/list?root={}&path={}/file", qe(&root), qe(&root)),
    )
    .await;
    assert_eq!(
        r.text(),
        "{\"code\":\"bad_request\",\"message\":\"디렉터리가 아니다\"}\n"
    );
}

#[tokio::test]
async fn fs_decode_failures() {
    let e = fs_env();
    let r = post(&e.srv, "/api/editors/add", "{").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json()["code"], "bad_request");
    assert!(
        r.json()["message"]
            .as_str()
            .unwrap()
            .starts_with("본문이 JSON 이 아니다")
    );
    let r = post(&e.srv, "/api/editors/add", "").await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn editors_endpoints() {
    let e = fs_env();
    let (_a, a) = temp_dir();
    let (_b, b) = temp_dir();
    let r = get(&e.srv, "/api/editors").await;
    let out = r.json();
    assert_eq!(r.status, 200);
    assert_eq!(out["home"], e.home.as_str());
    assert_eq!(out["list"], serde_json::json!([]));
    let notes = out["notes"].as_str().unwrap().to_owned();
    let plugins = out["plugins"].as_str().unwrap().to_owned();
    assert_eq!(out["fixed"], serde_json::json!([e.home, notes, plugins]));

    for _ in 0..2 {
        let r = post(
            &e.srv,
            "/api/editors/add",
            &format!(r#"{{"path":{}}}"#, jq(&a)),
        )
        .await;
        assert_eq!(r.status, 200);
        assert_eq!(r.json()["list"], serde_json::json!([a]));
        assert!(r.json().get("pinned").is_some());
    }
    let saves = e.ws.saves();
    let r = post(
        &e.srv,
        "/api/editors/add",
        &format!(r#"{{"path":{}}}"#, jq(&e.home)),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["list"].as_array().unwrap().len(), 1);
    assert_eq!(e.ws.saves(), saves);

    assert_eq!(
        post(
            &e.srv,
            "/api/editors/add",
            &format!(r#"{{"path":{}}}"#, jq(&b))
        )
        .await
        .status,
        200
    );
    let r = post(
        &e.srv,
        "/api/editors/reorder",
        &format!(r#"{{"src":{},"target":{},"before":true}}"#, jq(&b), jq(&a)),
    )
    .await;
    assert_eq!(r.text(), format!("{{\"list\":[{},{}]}}\n", jq(&b), jq(&a)));

    let r = post(
        &e.srv,
        "/api/editors/remove",
        &format!(r#"{{"path":{}}}"#, jq(&b)),
    )
    .await;
    assert_eq!(
        r.text(),
        format!("{{\"list\":[{}],\"pinned\":[]}}\n", jq(&a))
    );

    let r = post(
        &e.srv,
        "/api/editors/add",
        &format!(r#"{{"path":{}}}"#, jq(&format!("{a}/nope"))),
    )
    .await;
    assert_eq!(
        (r.status, r.json()["code"].as_str()),
        (404, Some(FS_ERR_NOT_FOUND))
    );
    let f = format!("{a}/f.txt");
    write(&f, b"");
    let r = post(
        &e.srv,
        "/api/editors/add",
        &format!(r#"{{"path":{}}}"#, jq(&f)),
    )
    .await;
    assert_eq!(
        (r.status, r.json()["code"].as_str()),
        (400, Some(apierr::CODE_NOT_A_DIRECTORY))
    );
}

#[tokio::test]
async fn fs_without_workspace_fails_cleanly() {
    let data = tempfile::tempdir().unwrap();
    let (_h, home) = temp_dir();
    let srv = Server::new_with(
        crate::Config {
            data_dir: data.path().to_path_buf(),
            ..crate::Config::default()
        },
        crate::Deps::default(),
        |s| super::fsenv::set_home(s, &home),
    );
    for (m, p, body) in [
        ("GET", "/api/editors", ""),
        ("GET", "/api/fs/list?root=/tmp&path=/tmp", ""),
        ("POST", "/api/editors/add", r#"{"path":"/tmp"}"#),
    ] {
        let r = if m == "GET" {
            get(&srv, p).await
        } else {
            post(&srv, p, body).await
        };
        assert_eq!(r.status, 500, "{m} {p}");
        assert_eq!(
            r.text(),
            "{\"code\":\"io_failed\",\"message\":\"파일 작업에 실패했다\"}\n",
            "{m} {p}"
        );
    }
    assert_eq!(get(&srv, "/api/ping").await.status, 200);
}

#[cfg(unix)]
#[tokio::test]
async fn fs_list_permission_denied_not_404() {
    use std::os::unix::fs::PermissionsExt;
    // root 로는 권한 거부를 만들 수 없다.
    if std::fs::metadata("/").is_ok_and(|_| {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x");
        std::fs::create_dir(&p).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        let readable = std::fs::read_dir(&p).is_ok();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        readable
    }) {
        return;
    }
    let e = fs_env();
    let (_d, root) = temp_dir();
    seed_root(&e.ws, &root);
    let locked = format!("{root}/locked");
    let inner = format!("{locked}/sub");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    for p in [&locked, &inner] {
        let (code, out) = list(&e.srv, &root, p, "").await;
        assert_eq!(
            (code, out["code"].as_str()),
            (403, Some("permission_denied")),
            "{p}"
        );
    }
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
}

// ── 쪽 (handlers_fs_paging_test.go) ─────────

#[tokio::test]
async fn fs_list_total_and_default_offset() {
    let (e, root, _d) = flat(5);
    let (code, out) = list(&e.srv, &root, &root, "").await;
    assert_eq!(code, 200);
    assert_eq!(names(&out).len(), 5);
    assert_eq!(
        (
            out["total"].clone(),
            out["offset"].clone(),
            out["truncated"].clone()
        ),
        (5.into(), 0.into(), false.into())
    );
}

#[tokio::test]
async fn fs_list_pages_concatenate_exactly() {
    let (e, root, _d) = flat(7);
    let want = names(&list(&e.srv, &root, &root, "&offset=0").await.1);
    assert_eq!(want.len(), 7);
    for off in 0..=7 {
        let got = names(
            &list(&e.srv, &root, &root, &format!("&offset={off}"))
                .await
                .1,
        );
        assert_eq!(got, want[off..], "offset={off}");
    }
}

#[tokio::test]
async fn fs_list_offset_beyond_total_is_empty_not_error() {
    let (e, root, _d) = flat(3);
    for off in [3, 4, 1000] {
        let (code, out) = list(&e.srv, &root, &root, &format!("&offset={off}")).await;
        assert_eq!(code, 200);
        assert!(names(&out).is_empty());
        assert_eq!(
            (
                out["truncated"].clone(),
                out["total"].clone(),
                out["offset"].clone()
            ),
            (false.into(), 3.into(), off.into())
        );
    }
}

#[tokio::test]
async fn fs_list_bad_offset_falls_back_to_zero() {
    let (e, root, _d) = flat(4);
    for raw in ["-1", "abc", "", "1.5", "99999999999999999999"] {
        let (code, out) = list(&e.srv, &root, &root, &format!("&offset={}", qe(raw))).await;
        assert_eq!(code, 200, "{raw}");
        assert_eq!(names(&out).len(), 4, "{raw}");
        assert_eq!(out["offset"], 0, "{raw}");
    }
}

#[tokio::test]
async fn fs_list_stamp_travels_with_every_page() {
    let (e, root, _d) = flat(3);
    for off in [0, 2, 5] {
        let (_, out) = list(&e.srv, &root, &root, &format!("&offset={off}")).await;
        assert_ne!(out["stamp"].as_str().unwrap_or_default(), "", "{off}");
    }
}

#[tokio::test]
async fn fs_list_normalizes_root() {
    let (e, root, _d) = flat(1);
    let raw = format!("{root}/./");
    let (code, out) = list(&e.srv, &raw, &root, "").await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(normalize_path(&raw), root);
}
