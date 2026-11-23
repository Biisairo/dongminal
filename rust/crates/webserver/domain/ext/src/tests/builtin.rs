use super::*;
use crate::builtin::{builtins, deploy, deploy_with};
use crate::load::{load, runtimes, server_for_ext};
use crate::locate::{plugin_dir, runtimes_dir};
use crate::manifest::{KIND_RUNTIME, KIND_SERVER, MANIFEST_NAME, current_target};

#[test]
fn builtins_all_parse() {
    let ms = builtins().unwrap();
    assert!(!ms.is_empty());
    assert!(
        ms.iter().any(|m| m.kind == KIND_RUNTIME),
        "런타임 선언이 없다"
    );
    assert!(ms.iter().any(|m| m.kind == KIND_SERVER), "서버 팩이 없다");
    for m in ms.iter().filter(|m| m.kind == KIND_SERVER) {
        assert!(!m.servers.is_empty(), "{} 가 서버를 내지 않는다", m.id);
    }
}

#[test]
fn builtins_versions_are_pinned() {
    for m in builtins().unwrap() {
        for p in &m.source.packages {
            assert!(p.contains('@') && !p.ends_with("@latest"), "{}: {p}", m.id);
        }
        assert!(
            m.source.args.iter().all(|a| !a.ends_with("@latest")),
            "{}",
            m.id
        );
        assert!(!m.version.is_empty(), "{}: version 이 없다", m.id);
    }
}

#[test]
fn builtins_runtime_covers_this_target() {
    if current_target().is_empty() {
        return;
    }
    for m in runtimes(&builtins().unwrap()) {
        let tg = &m.source.targets[&current_target()];
        for want in [m.id.as_str(), "npm"] {
            assert!(
                tg.provides.get(want).is_some_and(|v| !v.is_empty()),
                "{}: {want}",
                m.id
            );
        }
    }
}

#[test]
fn builtins_no_ext_collision() {
    let mut owner: HashMap<String, String> = HashMap::new();
    for m in builtins().unwrap() {
        for s in &m.servers {
            for e in &s.exts {
                let me = format!("{}/{}", m.id, s.id);
                if let Some(prev) = owner.insert(e.clone(), me.clone()) {
                    panic!("{e} 를 {prev} 와 {me} 가 함께 주장한다");
                }
            }
        }
    }
}

#[test]
fn deploy_writes_manifests_only() {
    let (_d, root) = tmp();
    assert!(deploy(&root).is_empty());
    let (got, errs) = load(&root);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(got.len(), builtins().unwrap().len());
    for m in &got {
        let ents: Vec<_> = std::fs::read_dir(plugin_dir(&root, &m.id))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(ents, [MANIFEST_NAME], "{}", m.id);
    }
    assert!(
        std::fs::metadata(runtimes_dir(&root)).is_err(),
        "전개가 런타임을 받았다 (FR-EXT-16)"
    );
    // 원본 바이트 그대로 쓴다.
    let p = filepath::join(&[plugin_dir(&root, "node").as_str(), MANIFEST_NAME]);
    let want = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/builtin/node.json")).unwrap();
    assert_eq!(std::fs::read(p).unwrap(), want);
    // 기록은 Go MarshalIndent 모양이다.
    let rec = std::fs::read_to_string(filepath::join(&[root.as_str(), "deployed.json"])).unwrap();
    assert!(
        rec.starts_with("{\n  \"") && rec.ends_with("\"\n}\n"),
        "{rec}"
    );
}

#[test]
fn deploy_does_not_overwrite_user_edits() {
    let (_d, root) = tmp();
    assert!(deploy(&root).is_empty());
    let ms = builtins().unwrap();
    let p = filepath::join(&[plugin_dir(&root, &ms[0].id).as_str(), MANIFEST_NAME]);
    let mut mine = std::fs::read(&p).unwrap();
    mine.push(b' ');
    std::fs::write(&p, &mine).unwrap();
    assert!(deploy(&root).is_empty());
    assert_eq!(
        std::fs::read(&p).unwrap(),
        mine,
        "전개가 사용자의 편집을 덮었다 (FR-EXT-36)"
    );
}

#[test]
fn deploy_does_not_resurrect_deleted() {
    let (_d, root) = tmp();
    assert!(deploy(&root).is_empty());
    let gone = builtins().unwrap()[0].id.clone();
    std::fs::remove_dir_all(plugin_dir(&root, &gone)).unwrap();
    assert!(deploy(&root).is_empty());
    assert!(
        std::fs::metadata(plugin_dir(&root, &gone)).is_err(),
        "{gone} 가 되살아났다"
    );
}

#[test]
fn deploy_broken_record_is_an_error() {
    let (_d, root) = tmp();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(filepath::join(&[root.as_str(), "deployed.json"]), "{").unwrap();
    let errs = deploy(&root);
    assert_eq!(errs.len(), 1);
    assert!(
        errs[0]
            .to_string()
            .starts_with("전개 기록이 깨졌습니다 (deployed.json): "),
        "{}",
        errs[0]
    );
}

#[test]
fn builtins_markdown_is_marksman() {
    let ms = builtins().unwrap();
    for e in [".md", ".markdown"] {
        let (m, s) = server_for_ext(&ms, e).unwrap();
        assert_eq!(
            (m.id.as_str(), s.exe.as_str(), s.args.clone()),
            ("marksman", "marksman", vec!["server".to_owned()])
        );
    }
    let old = Manifest {
        id: "vscode-langservers".to_owned(),
        kind: KIND_SERVER.to_owned(),
        servers: vec![crate::manifest::Server {
            id: "markdown".to_owned(),
            exts: vec![".md".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut with_old = ms.clone();
    with_old.push(old);
    with_old.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(server_for_ext(&with_old, ".md").unwrap().0.id, "marksman");
    for m in ms.iter().filter(|m| m.id == "marksman") {
        assert!(
            m.source
                .targets
                .values()
                .all(|t| t.raw && !t.bin.is_empty())
        );
    }
}

fn fail_write(_: &str, _: &[u8], _: u32) -> io::Result<()> {
    Err(io::Error::other("주입한 실패"))
}

#[test]
fn deploy_record_failure_reverts_manifests() {
    let (_d, root) = tmp();
    let errs = deploy_with(&root, fail_write);
    assert_eq!(
        errs.iter().map(|e| e.to_string()).collect::<Vec<_>>(),
        ["주입한 실패"]
    );
    let ms = builtins().unwrap();
    for m in &ms {
        let p = filepath::join(&[plugin_dir(&root, &m.id).as_str(), MANIFEST_NAME]);
        assert!(
            std::fs::metadata(p).is_err(),
            "{}: 기록 실패 뒤에도 선언이 남았다",
            m.id
        );
    }
    assert!(deploy(&root).is_empty());
    assert_eq!(load(&root).0.len(), ms.len());
}
