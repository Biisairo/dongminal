//! 탐색기 조작·답·복사·스탬프·전송의 시험 (Go `handlers_fs_test.go`·`handlers_fs_actions_test.go`·
//! `handlers_fs_copy_test.go`·`handlers_fs_case_test.go`·`handlers_fs_name_test.go`·
//! `handlers_fs_stamp*_test.go`·`handlers_fs_relpath_test.go`·`handlers_fs_notes_dir_test.go`).
//! 상태·본문의 바이트는 `golden_files.rs` 가 Go 출력과 대조한다. 여기는 그것이 덮지 못하는 갈래다.

use std::sync::Arc;

#[cfg(unix)]
use dm_webserver_apierr as apierr;
use serde_json::{Value, json};

#[cfg(unix)]
use super::fsenv::upload;
use super::fsenv::{Env, exists, fs_env, fs_env_with, get, post, qe, seed_root, temp_dir, write};
use crate::fs_actions::fs_name_answer;
use crate::fs_copy::fs_copy_name;
use crate::routes::API_ROUTES;
use crate::{Deps, Server};

fn env_root() -> (Env, String, tempfile::TempDir) {
    let e = fs_env();
    let (d, root) = temp_dir();
    seed_root(&e.ws, &root);
    (e, root, d)
}

async fn op(srv: &Arc<Server>, path: &str, body: Value) -> (u16, Value) {
    let r = post(srv, path, &body.to_string()).await;
    (r.status, r.json())
}

#[test]
fn fs_ops_routes_registered() {
    for (m, p) in [
        ("GET", "/api/meta"),
        ("POST", "/api/fs/stamp"),
        ("POST", "/api/fs/stamps"),
        ("POST", "/api/fs/create"),
        ("POST", "/api/fs/rename"),
        ("POST", "/api/fs/delete"),
        ("POST", "/api/fs/actions"),
        ("POST", "/api/fs/validate-name"),
        ("POST", "/api/fs/copy"),
        ("GET", "/api/fs/download"),
        ("POST", "/api/fs/upload"),
    ] {
        assert!(
            API_ROUTES
                .iter()
                .any(|rt| (rt.method.is_empty() || rt.method == m) && rt.matcher.matches(p)),
            "{m} {p}"
        );
    }
}

#[test]
fn fs_name_answer_table() {
    for (n, why) in [
        ("", "empty_name"),
        ("  ", "empty_name"),
        ("a/b", "name_has_separator"),
        (".", "name_reserved"),
        (" .. ", "name_reserved"),
        ("..b", ""),
        (" ok ", ""),
    ] {
        let a = fs_name_answer(n);
        assert_eq!(a.why, why, "{n:?}");
        assert_eq!(a.ok, why.is_empty());
    }
}

#[test]
fn fs_copy_names() {
    assert_eq!(fs_copy_name("a.txt", 1), "a copy.txt");
    assert_eq!(fs_copy_name("a.txt", 2), "a copy 2.txt");
    assert_eq!(fs_copy_name(".env", 1), ".env copy");
    assert_eq!(fs_copy_name("dir", 3), "dir copy 3");
    assert_eq!(fs_copy_name("a.b.c", 1), "a.b copy.c");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn fs_rename_file_never_overwrites() {
    let (e, root, _d) = env_root();
    let n = 8;
    for i in 0..n {
        write(&format!("{root}/f{i}.txt"), format!("body-{i}").as_bytes());
    }
    let dst = format!("{root}/dst.txt");
    let mut tasks = Vec::new();
    for i in 0..n {
        let srv = e.srv.clone();
        let body = json!({"root": root, "from": format!("{root}/f{i}.txt"), "to": dst});
        tasks.push(tokio::spawn(async move {
            op(&srv, "/api/fs/rename", body).await.0
        }));
    }
    let mut won = Vec::new();
    for (i, t) in tasks.into_iter().enumerate() {
        if t.await.unwrap() == 200 {
            won.push(i);
        }
    }
    assert_eq!(won.len(), 1);
    assert_eq!(
        std::fs::read(&dst).unwrap(),
        format!("body-{}", won[0]).as_bytes()
    );
    let left = (0..n)
        .filter(|i| exists(format!("{root}/f{i}.txt")))
        .count();
    assert_eq!(left, n - 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn fs_rename_dir_never_overwrites() {
    let (e, root, _d) = env_root();
    let n = 8;
    for i in 0..n {
        std::fs::create_dir_all(format!("{root}/src{i}/inner")).unwrap();
    }
    let dst = format!("{root}/dst");
    let mut tasks = Vec::new();
    for i in 0..n {
        let srv = e.srv.clone();
        let body = json!({"root": root, "from": format!("{root}/src{i}"), "to": dst});
        tasks.push(tokio::spawn(async move {
            op(&srv, "/api/fs/rename", body).await.0
        }));
    }
    let mut ok = 0;
    for t in tasks {
        match t.await.unwrap() {
            200 => ok += 1,
            409 => {}
            c => panic!("상태 {c}"),
        }
    }
    assert_eq!(ok, 1);
    assert!(exists(format!("{dst}/inner")));
    assert!(!exists(format!("{dst}/src0")));
}

#[tokio::test]
async fn fs_rename_case_only_and_hardlink_conflict() {
    let (e, root, _d) = env_root();
    write(&format!("{root}/a.txt"), b"x");
    let (code, out) = op(
        &e.srv,
        "/api/fs/rename",
        json!({"root": root, "from": format!("{root}/a.txt"), "name": "A.txt"}),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let names: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|d| d.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["A.txt"]);

    write(&format!("{root}/p.txt"), b"x");
    std::fs::hard_link(format!("{root}/p.txt"), format!("{root}/q.txt")).unwrap();
    let (code, out) = op(
        &e.srv,
        "/api/fs/rename",
        json!({"root": root, "from": format!("{root}/p.txt"), "to": format!("{root}/q.txt")}),
    )
    .await;
    assert_eq!((code, out["code"].as_str()), (409, Some("exists")));
    assert!(exists(format!("{root}/p.txt")));
}

#[tokio::test]
async fn fs_delete_protects_roots_and_home() {
    let e = fs_env();
    let (_a, a) = temp_dir();
    let (_b, b) = temp_dir();
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"editors":{{"list":[{},{}]}}}}"#,
        super::fsenv::jq(&a),
        super::fsenv::jq(&b)
    ));
    // 다른 Editor 루트를 그 루트 밖에서 지울 수 없다 — 루트 밖이다.
    let (code, out) = op(&e.srv, "/api/fs/delete", json!({"root": a, "path": b})).await;
    assert_eq!((code, out["code"].as_str()), (403, Some("outside_root")));
    // 홈 아래에 든 Editor 루트는 홈을 루트로 해도 지울 수 없다.
    let inner = format!("{}/proj", e.home);
    std::fs::create_dir(&inner).unwrap();
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"editors":{{"list":[{}]}}}}"#,
        super::fsenv::jq(&inner)
    ));
    let (code, out) = op(
        &e.srv,
        "/api/fs/delete",
        json!({"root": e.home, "path": inner}),
    )
    .await;
    assert_eq!((code, out), (400, json!({"code": "editor_root_protected"})));
    assert!(exists(&inner));
    let (code, out) = op(
        &e.srv,
        "/api/fs/delete",
        json!({"root": e.home, "path": e.home}),
    )
    .await;
    assert_eq!(
        (code, out["code"].as_str()),
        (400, Some("editor_root_protected"))
    );
}

#[tokio::test]
async fn fs_delete_over_max_deletes_nothing_and_actions_agree() {
    let e = fs_env_with(Deps::default(), |s| s.limits.fs_delete = 3);
    let (_d, root) = temp_dir();
    seed_root(&e.ws, &root);
    let big = format!("{root}/big");
    std::fs::create_dir(&big).unwrap();
    for i in 0..5 {
        write(&format!("{big}/f{i}"), b"");
    }
    let (code, out) = op(&e.srv, "/api/fs/delete", json!({"root": root, "path": big})).await;
    assert_eq!(
        (code, out),
        (400, json!({"args": {"max": 3}, "code": "too_many_entries"}))
    );
    assert!(exists(format!("{big}/f4")));
    let (_, out) = op(
        &e.srv,
        "/api/fs/actions",
        json!({"root": root, "paths": [big]}),
    )
    .await;
    assert_eq!(
        out["actions"]["fs.delete"],
        json!({"ok": false, "why": "too_many_entries", "args": {"max": 3}})
    );
    assert_eq!(out["count"], 0);
    let small = format!("{root}/small");
    std::fs::create_dir(&small).unwrap();
    write(&format!("{small}/x"), b"");
    let (_, out) = op(
        &e.srv,
        "/api/fs/actions",
        json!({"root": root, "paths": [small]}),
    )
    .await;
    assert_eq!(out["count"], 1);
    assert_eq!(
        op(
            &e.srv,
            "/api/fs/delete",
            json!({"root": root, "path": small})
        )
        .await
        .0,
        200
    );
    assert!(!exists(&small));
}

#[cfg(unix)]
#[tokio::test]
async fn fs_delete_link_removes_link_only_and_escape_rejected() {
    let (e, root, _d) = env_root();
    let (_o, outside) = temp_dir();
    write(&format!("{outside}/keep"), b"k");
    std::os::unix::fs::symlink(&outside, format!("{root}/ln")).unwrap();
    // 링크를 지나 루트 밖을 가리키는 경로는 루트 밖이다 (FR-EDT-112).
    let (code, out) = op(
        &e.srv,
        "/api/fs/delete",
        json!({"root": root, "path": format!("{root}/ln/keep")}),
    )
    .await;
    assert_eq!((code, out["code"].as_str()), (403, Some("outside_root")));
    // 링크 자신은 지울 수 있고 대상은 남는다.
    assert_eq!(
        op(
            &e.srv,
            "/api/fs/delete",
            json!({"root": root, "path": format!("{root}/ln")})
        )
        .await
        .0,
        200
    );
    assert!(exists(format!("{outside}/keep")));
}

#[tokio::test]
async fn fs_copy_cross_root_never_overwrites_and_over_max() {
    let e = fs_env_with(Deps::default(), |s| s.limits.fs_copy = 3);
    let (_a, a) = temp_dir();
    let (_b, b) = temp_dir();
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"editors":{{"list":[{},{}]}}}}"#,
        super::fsenv::jq(&a),
        super::fsenv::jq(&b)
    ));
    write(&format!("{a}/x.txt"), b"src");
    write(&format!("{b}/x.txt"), b"orig");
    let (code, out) = op(
        &e.srv,
        "/api/fs/copy",
        json!({"srcRoot": a, "src": format!("{a}/x.txt"), "dstRoot": b, "dstDir": b}),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["path"], format!("{b}/x copy.txt"));
    assert_eq!(std::fs::read(format!("{b}/x.txt")).unwrap(), b"orig");
    assert_eq!(std::fs::read(format!("{b}/x copy.txt")).unwrap(), b"src");
    let d = format!("{a}/d");
    std::fs::create_dir(&d).unwrap();
    for i in 0..3 {
        write(&format!("{d}/f{i}"), b"");
    }
    let (code, out) = op(
        &e.srv,
        "/api/fs/copy",
        json!({"srcRoot": a, "src": d, "dstRoot": b, "dstDir": b}),
    )
    .await;
    assert_eq!(
        (code, out),
        (400, json!({"args": {"max": 3}, "code": "too_many_entries"}))
    );
    assert!(!exists(format!("{b}/d")));
}

#[cfg(unix)]
#[tokio::test]
async fn fs_copy_keeps_links_and_modes() {
    use std::os::unix::fs::PermissionsExt;
    let (e, root, _d) = env_root();
    let src = format!("{root}/src");
    std::fs::create_dir(&src).unwrap();
    write(&format!("{src}/run.sh"), b"#!/bin/sh\n");
    std::fs::set_permissions(
        format!("{src}/run.sh"),
        std::fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    std::os::unix::fs::symlink("run.sh", format!("{src}/ln")).unwrap();
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o750)).unwrap();
    let dst = format!("{root}/dst");
    std::fs::create_dir(&dst).unwrap();
    let (code, out) = op(
        &e.srv,
        "/api/fs/copy",
        json!({"srcRoot": root, "src": src, "dstRoot": root, "dstDir": dst}),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let mode = |p: &str| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&format!("{dst}/src/run.sh")), 0o751);
    assert_eq!(mode(&format!("{dst}/src")), 0o750);
    assert_eq!(
        std::fs::read_link(format!("{dst}/src/ln"))
            .unwrap()
            .to_string_lossy(),
        "run.sh"
    );
}

#[tokio::test]
async fn fs_stamp_changes_and_limits() {
    let (e, root, _d) = env_root();
    let body = json!({"root": root, "dirs": [root]});
    let first = op(&e.srv, "/api/fs/stamp", body.clone()).await.1["stamps"][&root].clone();
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&format!("{root}/new"), b"");
    let second = op(&e.srv, "/api/fs/stamp", body).await.1["stamps"][&root].clone();
    assert_ne!(first, second);
    let (_, list) = (
        0,
        get(
            &e.srv,
            &format!("/api/fs/list?root={}&path={}", qe(&root), qe(&root)),
        )
        .await
        .json(),
    );
    assert_eq!(list["stamp"], second);
    let dirs = vec![root.clone(); 513];
    let (code, out) = op(&e.srv, "/api/fs/stamp", json!({"root": root, "dirs": dirs})).await;
    assert_eq!(
        (code, out["message"].as_str()),
        (400, Some("dirs 가 너무 많다"))
    );
    let trees: Vec<Value> = (0..17).map(|_| json!({"root": root})).collect();
    let (code, out) = op(&e.srv, "/api/fs/stamps", json!({"trees": trees})).await;
    assert_eq!(
        (code, out["message"].as_str()),
        (400, Some("trees 가 너무 많다"))
    );
    let (code, out) = op(
        &e.srv,
        "/api/fs/stamps",
        json!({"paths": vec![root.clone(); 513]}),
    )
    .await;
    assert_eq!(
        (code, out["message"].as_str()),
        (400, Some("paths 가 너무 많다"))
    );
    let (code, out) = op(
        &e.srv,
        "/api/fs/stamps",
        json!({"trees": [{"root": root, "dirs": dirs_n(&root, 513)}]}),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(
        out["trees"][&root],
        json!({"code": "bad_request", "status": 400})
    );
}

fn dirs_n(root: &str, n: usize) -> Vec<String> {
    vec![root.to_owned(); n]
}

#[tokio::test]
async fn fs_notes_root_is_a_root() {
    let e = fs_env();
    let notes = get(&e.srv, "/api/editors").await.json()["notes"]
        .as_str()
        .unwrap()
        .to_owned();
    let (code, out) = op(
        &e.srv,
        "/api/fs/create",
        json!({"root": notes, "parent": notes, "name": "memo", "dir": true}),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let (code, _) = op(
        &e.srv,
        "/api/fs/create",
        json!({"root": notes, "path": format!("{notes}/memo/a.md")}),
    )
    .await;
    assert_eq!(code, 200);
    let r = get(
        &e.srv,
        &format!("/api/fs/list?root={}&path={}/memo", qe(&notes), qe(&notes)),
    )
    .await;
    assert_eq!(r.json()["entries"][0]["name"], "a.md");
}

#[cfg(unix)]
#[tokio::test]
async fn fs_upload_rel_path_guards() {
    let (e, root, _d) = env_root();
    let up = |rel: &'static str| {
        let srv = e.srv.clone();
        let root = root.clone();
        async move {
            upload(
                &srv,
                &format!("/api/fs/upload?root={}&dir={}", qe(&root), qe(&root)),
                "x.txt",
                b"x",
                &[("relPath", rel)],
            )
            .await
        }
    };
    let (_o, outside) = temp_dir();
    std::os::unix::fs::symlink(&outside, format!("{root}/ln")).unwrap();
    let r = up("ln/sub/x.txt").await;
    assert_eq!(
        (r.status, r.json()["code"].as_str()),
        (403, Some("outside_root"))
    );
    assert!(!exists(format!("{outside}/sub")));
    let r = up("a/../../x.txt").await;
    assert_eq!(r.status, 400);
    write(&format!("{root}/dup.txt"), b"orig");
    let r = up("dup.txt").await;
    assert_eq!(
        (r.status, r.json()["code"].as_str()),
        (409, Some(apierr::CODE_EXISTS))
    );
    assert_eq!(std::fs::read(format!("{root}/dup.txt")).unwrap(), b"orig");
    // FR-RDF-9: 부모가 파일이면 Go os.MkdirAll 은 ENOTDIR 이다 — 있음(409)이 아니라 io 다.
    let r = up("dup.txt/x.txt").await;
    assert_eq!(r.json()["code"].as_str(), Some(apierr::CODE_IO));
    let r = upload(
        &e.srv,
        &format!("/api/fs/upload?root={}&dir={}/nope", qe(&root), qe(&root)),
        "x.txt",
        b"x",
        &[("relPath", "a/x.txt")],
    )
    .await;
    assert_eq!(r.status, 404);
    assert!(!exists(format!("{root}/nope")));
}
