use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::locate::{
    MISSING_NOT_FETCHED, MISSING_RUNTIME, MISSING_TOOL, ORIGIN_CONFIG, ORIGIN_MANAGED, ORIGIN_PATH,
    managed_exe, plugin_dir, runtime_dir,
};
use crate::manifest::{MANIFEST_NAME, Server, current_target};
use crate::service::Service;

fn put_managed(root: &str, m: &Manifest, s: &Server) -> String {
    let p = managed_exe(root, m, s);
    assert!(!p.is_empty(), "조달물의 자리를 얻지 못했다");
    must_exec(&p);
    p
}

/// 이 타깃의 런타임 파일을 놓는다. 선언에 이 타깃이 없으면 `false`.
pub(crate) fn put_runtime(root: &str, m: &Manifest) -> bool {
    let Some(tg) = m.source.targets.get(&current_target()) else {
        return false;
    };
    for rel in tg.provides.values() {
        must_exec(&filepath::join(&[
            runtime_dir(root, m).as_str(),
            filepath::from_slash(rel).as_str(),
        ]));
    }
    true
}

#[test]
fn locate_order() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let s = &m.servers[0];
    let managed = put_managed(&root, &m, s);
    let st = test_locator(&root, &[], &[], vec![]).locate(&m, s);
    assert!(
        st.found && st.origin == ORIGIN_MANAGED && st.exe == managed,
        "{st:?}"
    );

    let from_path = filepath::join(&[root.as_str(), "from-path"]);
    let on_path = [("gopls", from_path.as_str())];
    let st = test_locator(&root, &on_path, &[], vec![]).locate(&m, s);
    assert_eq!(st.origin, ORIGIN_PATH, "PATH 가 격리 칸을 이기지 않았다");

    let cfg = filepath::join(&[root.as_str(), &format!("from-config{}", exe_suffix())]);
    must_exec(&cfg);
    let st = test_locator(&root, &on_path, &[("gopls/gopls", &cfg)], vec![]).locate(&m, s);
    assert!(st.origin == ORIGIN_CONFIG && st.exe == cfg, "{st:?}");
}

#[test]
fn locate_isolated_flag() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let s = &m.servers[0];
    put_managed(&root, &m, s);
    assert!(test_locator(&root, &[], &[], vec![]).locate(&m, s).isolated);
    let elsewhere = filepath::join(&[root.as_str(), "elsewhere"]);
    let st = test_locator(&root, &[("gopls", &elsewhere)], &[], vec![]).locate(&m, s);
    assert!(!st.isolated, "PATH 의 것이 격리됐다고 보고됐다 (FR-EXT-28)");
}

#[test]
fn locate_pack_yields_all_servers() {
    let (_d, root) = tmp();
    let m = must_parse(PACK_JSON);
    for s in &m.servers {
        put_managed(&root, &m, s);
    }
    let a = filepath::dir(&managed_exe(&root, &m, &m.servers[0]));
    let b = filepath::dir(&managed_exe(&root, &m, &m.servers[1]));
    assert_eq!(a, b, "한 팩의 서버들이 다른 자리를 쓴다");
    let node = must_parse(&node_runtime());
    if !put_runtime(&root, &node) {
        return;
    }
    for s in &m.servers {
        let st = test_locator(&root, &[], &[], vec![node.clone()]).locate(&m, s);
        assert!(st.found, "{} 를 못 찾았다: {st:?}", s.id);
    }
}

#[test]
fn locate_managed_layout_per_source() {
    let (_d, root) = tmp();
    let npm = must_parse(NPM_PACK);
    let tool = must_parse(GO_PACK);
    let npm_dir = filepath::dir(&managed_exe(&root, &npm, &npm.servers[0]));
    let want = filepath::join(&[plugin_dir(&root, &npm.id).as_str(), "node_modules", ".bin"]);
    assert_eq!(npm_dir, want);
    let tool_dir = filepath::dir(&managed_exe(&root, &tool, &tool.servers[0]));
    assert_eq!(
        tool_dir,
        filepath::join(&[plugin_dir(&root, &tool.id).as_str(), "bin"])
    );
}

#[cfg(unix)]
#[test]
fn locate_needs_executable() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let s = &m.servers[0];
    let p = managed_exe(&root, &m, s);
    std::fs::create_dir_all(filepath::dir(&p)).unwrap();
    std::fs::write(&p, "not exec").unwrap();
    assert!(!test_locator(&root, &[], &[], vec![]).locate(&m, s).found);
}

#[test]
fn locate_missing_runtime() {
    let (_d, root) = tmp();
    let m = must_parse(NPM_PACK);
    let s = &m.servers[0];
    let node = must_parse(&node_runtime());
    let st = test_locator(&root, &[], &[], vec![node.clone()]).locate(&m, s);
    assert!(!st.found);
    let miss = st.missing.unwrap();
    assert_eq!(
        (miss.kind.as_str(), miss.name.as_str()),
        (MISSING_RUNTIME, "node")
    );
    let st = test_locator(&root, &[("node", "/usr/bin/node")], &[], vec![node]).locate(&m, s);
    assert_eq!(st.missing.unwrap().kind, MISSING_NOT_FETCHED);
}

#[test]
fn locate_missing_tool() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let s = &m.servers[0];
    let st = test_locator(&root, &[], &[], vec![]).locate(&m, s);
    let miss = st.missing.clone().unwrap();
    assert_eq!(
        (miss.kind.as_str(), miss.name.as_str()),
        (MISSING_TOOL, "go")
    );
    assert!(
        !st.can_install,
        "도구가 없는데 조달할 수 있다고 했다 (FR-EXT-14)"
    );
    let st = test_locator(&root, &[("go", "/usr/bin/go")], &[], vec![]).locate(&m, s);
    assert!(st.can_install);
    assert_eq!(st.missing.unwrap().kind, MISSING_NOT_FETCHED);
}

#[test]
fn locate_is_observation_not_cache() {
    let (_d, root) = tmp();
    let m = must_parse(GO_PACK);
    let s = &m.servers[0];
    let l = test_locator(&root, &[], &[], vec![]);
    let p = put_managed(&root, &m, s);
    assert!(l.locate(&m, s).found);
    std::fs::remove_file(&p).unwrap();
    assert!(
        !l.locate(&m, s).found,
        "지운 것을 있다고 우겼다 (FR-EXT-33)"
    );
}

fn counting_service(
    on_path: &[(&str, &str)],
    decls: &[&str],
) -> (tempfile::TempDir, Service, Arc<AtomicUsize>) {
    let (d, root) = tmp();
    for js in decls {
        let m = must_parse(js);
        let dir = plugin_dir(&root, &m.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(filepath::join(&[dir.as_str(), MANIFEST_NAME]), js).unwrap();
    }
    let n = Arc::new(AtomicUsize::new(0));
    let look = map_look(on_path);
    let counter = Arc::clone(&n);
    let svc = Service::with(
        &root,
        Arc::new(move |name: &str| {
            counter.fetch_add(1, Ordering::SeqCst);
            look(name)
        }),
        Arc::new(failing_fetch("네트워크 없음")),
        Arc::new(Recorder::default()),
    );
    (d, svc, n)
}

#[test]
fn resolve_found_stops_looking() {
    let (_d, svc, n) = counting_service(&[("gopls", "/p/gopls"), ("go", "/p/go")], &[GO_PACK]);
    let (_, _, st) = svc.resolve(".go", &HashMap::new()).unwrap();
    assert!(st.found);
    assert_eq!(n.load(Ordering::SeqCst), 1, "찾은 뒤에 더 보지 않아야 한다");
    let (_d, svc, _) = counting_service(&[], &[GO_PACK]);
    let (_, _, st) = svc.resolve(".go", &HashMap::new()).unwrap();
    assert!(!st.found && st.missing.unwrap().kind == MISSING_TOOL);
}

#[test]
fn status_readiness_once_per_pack() {
    let (_d, svc, n) = counting_service(&[("node", "/p/node")], &[PACK_JSON]);
    let (sts, _) = svc.status(&HashMap::new());
    assert_eq!(sts.len(), 2);
    for st in &sts {
        assert!(!st.found && st.can_install);
        assert_eq!(st.missing.as_ref().unwrap().kind, MISSING_NOT_FETCHED);
        assert_eq!(st.note, "아직 받지 않았습니다");
    }
    assert_eq!(
        n.load(Ordering::SeqCst),
        3,
        "판정은 팩마다 한 번이어야 한다"
    );
}

#[test]
fn locate_overrides_keyed_by_pack_server() {
    let (_d, root) = tmp();
    let a = must_parse(GO_PACK);
    let b = must_parse(
        r#"{"id":"other","kind":"server",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]}"#,
    );
    let cfg = filepath::join(&[root.as_str(), &format!("mine{}", exe_suffix())]);
    must_exec(&cfg);
    let l = test_locator(&root, &[], &[("gopls/gopls", &cfg)], vec![]);
    let st = l.locate(&a, &a.servers[0]);
    assert!(st.origin == ORIGIN_CONFIG && st.exe == cfg);
    assert!(
        !l.locate(&b, &b.servers[0]).found,
        "다른 팩의 같은 서버 id 에 경로가 번졌다"
    );
}

#[test]
fn server_ids_no_locate() {
    let (_d, svc, n) = counting_service(&[], &[GO_PACK, PACK_JSON]);
    let ids: Vec<String> = svc.server_ids().into_iter().collect();
    assert_eq!(
        ids,
        [
            "gopls/gopls",
            "vscode-langservers-extracted/css",
            "vscode-langservers-extracted/html"
        ]
    );
    assert_eq!(
        n.load(Ordering::SeqCst),
        0,
        "id 를 얻는 데 탐색하지 않아야 한다"
    );
}

#[test]
fn resolve_id_and_unknown() {
    let (_d, svc, _) = counting_service(&[("gopls", "/p/gopls")], &[GO_PACK]);
    let (srv, st) = svc.resolve_id("gopls/gopls", &HashMap::new()).unwrap();
    assert_eq!((srv.exe.as_str(), st.exe.as_str()), ("gopls", "/p/gopls"));
    assert!(svc.resolve_id("gopls/nope", &HashMap::new()).is_none());
    assert!(svc.resolve(".zzz", &HashMap::new()).is_none());
}
