use super::*;
use crate::load::load;
use crate::locate::plugin_dir;
use crate::manifest::{KIND_RUNTIME, KIND_SERVER, MANIFEST_NAME};

pub(crate) fn write_plugin(root: &str, id: &str, js: &str) {
    let dir = plugin_dir(root, id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(filepath::join(&[dir.as_str(), MANIFEST_NAME]), js).unwrap();
}

#[test]
fn load_reads_all() {
    let (_d, root) = tmp();
    write_plugin(&root, "yaml", NPM_PACK);
    write_plugin(&root, "gopls", GO_PACK);
    write_plugin(&root, "node", &node_runtime());
    let (got, errs) = load(&root);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(got.len(), 3);
    let servers = got.iter().filter(|m| m.kind == KIND_SERVER).count();
    let runtimes = got.iter().filter(|m| m.kind == KIND_RUNTIME).count();
    assert_eq!((servers, runtimes), (2, 1));
    let ids: Vec<&str> = got.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["gopls", "node", "yaml"], "순서가 고정되지 않았다");
}

#[test]
fn load_broken_one_does_not_kill_others() {
    let (_d, root) = tmp();
    write_plugin(&root, "yaml", NPM_PACK);
    write_plugin(&root, "broken", "{ this is not json");
    write_plugin(
        &root,
        "escaping",
        r#"{"id":"escaping","kind":"server",
	  "source":{"kind":"toolchain","tool":"go","args":["install","x"],"bin":"../../out"},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":[".go"]}]}"#,
    );
    write_plugin(&root, "gopls", GO_PACK);
    let (got, errs) = load(&root);
    assert_eq!(got.len(), 2, "온전한 둘이 살아남아야 한다");
    assert_eq!(errs.len(), 2, "{errs:?}");
    let joined: String = errs.iter().map(|e| e.to_string()).collect();
    for want in ["broken", "escaping"] {
        assert!(
            joined.contains(want),
            "사유에 팩 이름 {want:?} 가 없다: {joined}"
        );
    }
    assert_eq!(
        errs[1].to_string(),
        r#"escaping: escaping: bin 이 격리 칸을 벗어납니다: 상위로 올라갑니다: "../../out""#
    );
}

#[test]
fn load_ignores_dirs_without_manifest() {
    let (_d, root) = tmp();
    std::fs::create_dir_all(filepath::join(&[
        plugin_dir(&root, "leftover").as_str(),
        "node_modules",
    ]))
    .unwrap();
    write_plugin(&root, "gopls", GO_PACK);
    let (got, errs) = load(&root);
    assert_eq!((got.len(), errs.len()), (1, 0));
}

#[test]
fn load_missing_dir_is_not_an_error() {
    let (_d, root) = tmp();
    let (got, errs) = load(&filepath::join(&[root.as_str(), "nope"]));
    assert_eq!((got.len(), errs.len()), (0, 0));
}

#[test]
fn load_rejects_id_mismatch() {
    let (_d, root) = tmp();
    write_plugin(&root, "elsewhere", GO_PACK); // 안의 id 는 "gopls"
    let (got, errs) = load(&root);
    assert_eq!((got.len(), errs.len()), (0, 1));
    assert_eq!(
        errs[0].to_string(),
        r#"elsewhere: 선언의 id 가 디렉터리와 다릅니다: "gopls""#
    );
}
