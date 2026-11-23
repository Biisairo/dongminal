use std::path::Path;
use std::sync::{Arc, Mutex};

use dm_gocompat::filepath;
use serde_json::Value;

use super::*;

fn abs(seg: &[&str]) -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    filepath::join(&[&[root], seg].concat())
}

fn jq(s: &str) -> String {
    String::from_utf8(dm_gocompat::json::marshal(s).unwrap()).unwrap()
}

fn sv(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[derive(Default)]
struct FakeState {
    raw: Vec<u8>,
    rev: u64,
    saves: usize,
    stale_once: bool,
}

#[derive(Default)]
struct FakeWork(Mutex<FakeState>);

impl FakeWork {
    fn set(&self, raw: &str) {
        self.0.lock().unwrap().raw = raw.as_bytes().to_vec();
    }
    #[cfg_attr(not(unix), allow(dead_code))]
    fn set_rev(&self, rev: u64) {
        self.0.lock().unwrap().rev = rev;
    }
    fn raw(&self) -> Vec<u8> {
        self.0.lock().unwrap().raw.clone()
    }
    fn rev(&self) -> u64 {
        self.0.lock().unwrap().rev
    }
    fn saves(&self) -> usize {
        self.0.lock().unwrap().saves
    }
}

impl WorkspaceStore for FakeWork {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        let s = self.0.lock().unwrap();
        (Arc::new(s.raw.clone()), s.rev)
    }
    fn save(&self, blob: &[u8], _: &str) -> Result<u64, dm_shared_workspace::Error> {
        let mut s = self.0.lock().unwrap();
        if s.stale_once {
            s.stale_once = false;
            return Err(dm_shared_workspace::Error::Stale);
        }
        s.raw = blob.to_vec();
        s.rev += 1;
        s.saves += 1;
        Ok(s.rev)
    }
}

#[derive(Default)]
struct FakeBroker(Mutex<Vec<Vec<u8>>>);

impl Broadcaster for FakeBroker {
    fn broadcast(&self, p: &[u8]) -> usize {
        self.0.lock().unwrap().push(p.to_vec());
        1
    }
}

impl FakeBroker {
    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

fn new_store(home: &str) -> (Store, Arc<FakeWork>, Arc<FakeBroker>) {
    let w = Arc::new(FakeWork::default());
    let b = Arc::new(FakeBroker::default());
    let h = home.to_owned();
    let s = Store {
        work: Some(w.clone()),
        commands: Some(b.clone()),
        home_fn: Some(Arc::new(move || Ok(h.clone()))),
        ..Store::default()
    };
    (s, w, b)
}

fn doc_of(raw: &[u8]) -> Value {
    serde_json::from_slice(raw).unwrap()
}

fn tmp() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().to_str().unwrap().to_owned();
    (t, p)
}

fn j(a: &str, b: &str) -> String {
    filepath::join(&[a, b])
}

fn mkdir(p: &str) {
    std::fs::create_dir_all(p).unwrap();
}

fn repo_root_fn(f: impl Fn(&str) -> Result<String, String> + Send + Sync + 'static) -> RepoRootFn {
    let f = Arc::new(f);
    Arc::new(move |_, p| {
        let r = f(&p);
        Box::pin(async move { r })
    })
}

fn ctx() -> Ctx {
    Ctx::background()
}

fn editors_doc(paths: &[&str]) -> String {
    let list: Vec<String> = paths.iter().map(|p| jq(p)).collect();
    format!(
        r#"{{"schemaVersion":2,"editors":{{"list":[{}]}}}}"#,
        list.join(",")
    )
}

// ---- link ----

#[test]
fn link_rules() {
    let (repo, home) = (abs(&["work", "repo"]), abs(&["home", "u"]));
    let got = link_pin_add(Lists::default(), &repo, &home);
    let want = Lists {
        pinned: vec![repo.clone()],
        editors: vec![repo.clone()],
    };
    assert_eq!(got, want);
    assert_eq!(link_pin_add(got, &repo, &home), want);

    let got = link_pin_add(Lists::default(), &home, &home);
    assert!(got.editors.is_empty() && got.pinned == vec![home.clone()]);

    let (a, b) = (abs(&["a"]), abs(&["b"]));
    let cur = Lists {
        pinned: vec![a.clone(), b.clone()],
        editors: vec![a.clone(), b.clone()],
    };
    let got = link_pin_remove(cur, &a, &home);
    let want = Lists {
        pinned: vec![b.clone()],
        editors: vec![b.clone()],
    };
    assert_eq!(got, want);
    assert_eq!(link_pin_remove(got, "/zzz", &home), want);

    let cur = Lists {
        pinned: vec![home.clone()],
        editors: vec![home.clone()],
    };
    let got = link_pin_remove(cur, &home, &home);
    assert!(got.pinned.is_empty() && got.editors.len() == 1);

    let root = link_editor_add(Lists::default(), &repo, &home, true);
    assert_eq!(root.pinned, vec![repo.clone()]);
    let inside = link_editor_add(
        Lists::default(),
        &abs(&["work", "repo", "sub"]),
        &home,
        false,
    );
    assert!(inside.pinned.is_empty() && inside.editors.len() == 1);
    assert_eq!(
        link_editor_add(Lists::default(), &home, &home, true),
        Lists::default()
    );

    let cur = Lists {
        pinned: vec![a.clone()],
        editors: vec![a.clone()],
    };
    assert_eq!(link_editor_remove(cur, &a, &home), Lists::default());
    let cur = Lists {
        pinned: vec![home.clone(), "/other".into()],
        editors: vec!["/other".into()],
    };
    let got = link_editor_remove(cur.clone(), &home, &home);
    assert_eq!(got, cur);
}

#[test]
fn link_rules_do_not_call_each_other() {
    let src = include_str!("link.rs");
    let rules = [
        "link_pin_add",
        "link_pin_remove",
        "link_editor_add",
        "link_editor_remove",
    ];
    for rule in rules {
        let start = src.find(&format!("pub fn {rule}(")).expect(rule);
        let body_start = start + src[start..].find('{').unwrap();
        let body_end = body_start + src[body_start..].find("\n}\n").unwrap();
        let body = &src[body_start..body_end];
        for other in rules {
            assert!(
                !body.contains(&format!("{other}(")),
                "{rule} 가 {other} 를 부른다"
            );
        }
    }
}

// ---- check / helpers ----

#[test]
fn check_editor_path_cases() {
    let (_t, dir) = tmp();
    let file = j(&dir, "f.txt");
    std::fs::write(&file, "").unwrap();
    assert!(matches!(check_editor_path("  "), Err(Error::EmptyPath)));
    assert!(matches!(
        check_editor_path("rel/dir"),
        Err(Error::NotAbsolute)
    ));
    assert!(matches!(
        check_editor_path(&j(&dir, "gone")),
        Err(Error::NotFound)
    ));
    assert!(matches!(check_editor_path(&file), Err(Error::NotDir)));
    assert!(matches!(
        check_editor_path(&abs(&[])),
        Err(Error::FilesystemRoot)
    ));
    assert_eq!(
        check_editor_path(&format!(" {dir} ")).unwrap(),
        normalize_path(&dir)
    );
    assert_eq!(Error::NotDir.to_string(), "디렉터리가 아니다");
    assert_eq!(
        Error::FilesystemRoot.to_string(),
        "파일시스템 루트는 행이 될 수 없다"
    );
}

#[test]
fn home_default_and_injected() {
    let s = Store::default();
    let want = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    match (s.home_raw(), want) {
        (Ok(got), Some(w)) if !cfg!(windows) => assert_eq!(got, w),
        (Err(e), None) if !cfg!(windows) => assert_eq!(e.to_string(), "$HOME is not defined"),
        (r, w) if !cfg!(windows) => panic!("{r:?} vs {w:?}"),
        _ => {}
    }
    let (_t, dir) = tmp();
    let raw = filepath::join(&[dir.as_str(), "x", "..", "h"]);
    let r2 = raw.clone();
    let mut s = Store {
        home_fn: Some(Arc::new(move || Ok(r2.clone()))),
        ..Store::default()
    };
    assert_eq!(s.home_raw().unwrap(), raw);
    s.home_fn = Some(Arc::new(|| Err("홈 없음".into())));
    assert_eq!(s.home_raw().unwrap_err().to_string(), "홈 없음");
}

#[test]
fn ensure_root_cases() {
    assert!(matches!(ensure_root(""), Err(Error::Unavailable)));
    let (_t, d) = tmp();
    let dir = filepath::join(&[d.as_str(), "a", "b"]);
    assert_eq!(ensure_root(&dir).unwrap(), normalize_path(&dir));
    assert!(Path::new(&dir).is_dir());
    let file = j(&d, "f");
    std::fs::write(&file, "").unwrap();
    let err = ensure_root(&j(&file, "x")).unwrap_err();
    if cfg!(unix) {
        assert_eq!(err.to_string(), format!("mkdir {file}: not a directory"));
    }
}

#[test]
fn notes_and_plugins_create_and_normalize() {
    let (_t, dir) = tmp();
    let (mut s, w, _) = new_store(&j(&dir, "home"));
    let notes = j(&dir, "notes");
    let memo_dir = j(&dir, "kept");
    mkdir(&memo_dir);
    std::fs::write(j(&memo_dir, "a.md"), "hi").unwrap();
    let plugins = filepath::join(&[dir.as_str(), "ext", "plugins"]);
    s.notes_dir = notes.clone();
    s.plugins_dir = plugins.clone();
    assert_eq!(s.notes().unwrap(), normalize_path(&notes));
    assert!(Path::new(&notes).is_dir());
    assert_eq!(s.plugins().unwrap(), normalize_path(&plugins));
    assert!(Path::new(&plugins).is_dir());
    s.notes_dir = memo_dir.clone();
    s.notes().unwrap();
    assert_eq!(std::fs::read_to_string(j(&memo_dir, "a.md")).unwrap(), "hi");
    w.set("");
    assert!(s.roots().unwrap().contains(&normalize_path(&plugins)));
}

#[test]
fn notes_unavailable_without_dir() {
    let (_t, dir) = tmp();
    let home = j(&dir, "home");
    mkdir(&home);
    let (s, w, _) = new_store(&home);
    let x = abs(&["x"]);
    w.set(&editors_doc(&[&x]));
    assert!(matches!(s.notes(), Err(Error::Unavailable)));
    assert!(matches!(s.plugins(), Err(Error::Unavailable)));
    assert_eq!(s.roots().unwrap(), vec![normalize_path(&home), x]);
}

#[test]
fn roots_includes_notes_after_home() {
    let (_t, dir) = tmp();
    let home = j(&dir, "home");
    mkdir(&home);
    let (mut s, w, _) = new_store(&home);
    let notes = j(&dir, "notes");
    s.notes_dir = notes.clone();
    let (x, y) = (abs(&["x"]), abs(&["y"]));
    w.set(&editors_doc(&[&x, &y]));
    assert_eq!(
        s.roots().unwrap(),
        vec![normalize_path(&home), normalize_path(&notes), x, y]
    );
    let (_, list) = s.list().unwrap();
    assert_eq!(list, vec![abs(&["x"]), abs(&["y"])]);
}

#[tokio::test]
async fn editor_add_notes_root_is_noop() {
    let (_t, dir) = tmp();
    let (home, notes) = (j(&dir, "home"), j(&dir, "notes"));
    mkdir(&home);
    mkdir(&notes);
    let (mut s, w, _) = new_store(&home);
    s.notes_dir = notes.clone();
    w.set(r#"{"schemaVersion":2}"#);
    let l = s.editor_add(&ctx(), &notes).await.unwrap();
    assert!(l.editors.is_empty());
    assert_eq!(w.saves(), 0);
}

#[cfg(unix)]
#[test]
fn roots_memoized_by_workspace_rev() {
    let (_t, dir) = tmp();
    let (home, real, link) = (j(&dir, "home"), j(&dir, "real"), j(&dir, "link"));
    mkdir(&home);
    mkdir(&real);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (s, w, _) = new_store(&home);
    w.set(&editors_doc(&[&link]));
    w.set_rev(1);
    let want = vec![normalize_path(&home), normalize_path(&real)];
    let mut got = s.roots().unwrap();
    assert_eq!(got, want);
    let elsewhere = abs(&["elsewhere"]);
    w.set(&editors_doc(&[&elsewhere]));
    assert_eq!(s.roots().unwrap(), want, "같은 rev 에서 다시 파싱했다");
    got[0] = abs(&["mutated"]);
    assert_eq!(s.roots().unwrap()[0], normalize_path(&home));
    w.set_rev(2);
    assert_eq!(s.roots().unwrap(), vec![normalize_path(&home), elsewhere]);
}

#[test]
fn roots_memo_still_ensures_notes_dir() {
    let (_t, dir) = tmp();
    let (home, notes) = (j(&dir, "home"), j(&dir, "notes"));
    mkdir(&home);
    let (mut s, _, _) = new_store(&home);
    s.notes_dir = notes.clone();
    s.roots().unwrap();
    std::fs::remove_dir_all(&notes).unwrap();
    let roots = s.roots().unwrap();
    assert!(Path::new(&notes).is_dir());
    assert_eq!(roots[1], normalize_path(&notes));
}

#[cfg(unix)]
#[test]
fn roots_normalizes_at_call_time() {
    let (_t, dir) = tmp();
    let (home, real, link) = (j(&dir, "home"), j(&dir, "real"), j(&dir, "link"));
    mkdir(&home);
    mkdir(&real);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (s, w, _) = new_store(&home);
    let later = j(&link, "later");
    w.set(&editors_doc(&[&later]));
    w.set_rev(1);
    s.roots().unwrap();
    mkdir(&j(&real, "later"));
    let got = s.roots().unwrap();
    assert_eq!(got.last().unwrap(), &normalize_path(&later));
}

#[test]
fn fixed_roots_cases() {
    assert_eq!(fixed_roots("/h", "/n", "/p"), sv(&["/h", "/n", "/p"]));
    assert_eq!(fixed_roots("/h", "", "/p"), sv(&["/h", "/p"]));
    assert_eq!(fixed_roots("/h", "/n", ""), sv(&["/h", "/n"]));
    assert_eq!(fixed_roots("/h", "", ""), sv(&["/h"]));
}

#[test]
fn normalize_path_falls_back_to_clean_when_missing() {
    let no = abs(&["no", "such", "dir"]);
    assert_eq!(
        normalize_path(&filepath::join(&[no.as_str(), "..", "dir"])),
        no
    );
}

// ---- store ----

#[tokio::test]
async fn editor_add_remove_persists_and_preserves_other_keys() {
    let (_t, dir) = tmp();
    let (s, w, _) = new_store(&j(&dir, "home"));
    w.set(r#"{"schemaVersion":2,"windows":[{"id":"w1"}],"activeWindow":"w1","git":{"pinned":["/p"],"drafts":{"a":"b"}}}"#);
    let target = j(&dir, "proj");
    mkdir(&target);
    let norm = normalize_path(&target);
    let l = s.editor_add(&ctx(), &target).await.unwrap();
    assert_eq!(l.editors, vec![norm.clone()]);
    // Go json.Marshal(map) 와 같은 바이트: 키 정렬, 숫자 2.
    let want = format!(
        r#"{{"activeWindow":"w1","editors":{{"list":[{}]}},"git":{{"drafts":{{"a":"b"}},"pinned":["/p"]}},"schemaVersion":2,"windows":[{{"id":"w1"}}]}}"#,
        jq(&norm)
    );
    assert_eq!(String::from_utf8(w.raw()).unwrap(), want);

    let l = s.editor_remove(&norm).unwrap();
    assert!(l.editors.is_empty());
    let doc = doc_of(&w.raw());
    assert_eq!(doc["git"]["pinned"].as_array().unwrap().len(), 1);
    assert_eq!(doc["editors"]["list"], Value::Array(vec![]));
}

#[tokio::test]
async fn editor_add_idempotent_home_and_rejects() {
    let (_t, dir) = tmp();
    let home = j(&dir, "home");
    mkdir(&home);
    let (s, w, _) = new_store(&home);
    let target = j(&dir, "proj");
    mkdir(&target);
    for _ in 0..2 {
        assert_eq!(
            s.editor_add(&ctx(), &target).await.unwrap().editors.len(),
            1
        );
    }
    let saves = w.saves();
    assert!(s.editor_add(&ctx(), &home).await.unwrap().editors.len() == 1);
    assert_eq!(w.saves(), saves, "홈 추가는 저장하지 않는다");
    assert!(matches!(
        s.editor_add(&ctx(), &j(&dir, "nope")).await,
        Err(Error::NotFound)
    ));
    let f = j(&dir, "a.txt");
    std::fs::write(&f, "x").unwrap();
    assert!(matches!(s.editor_add(&ctx(), &f).await, Err(Error::NotDir)));
    assert!(matches!(
        s.editor_add(&ctx(), "rel/path").await,
        Err(Error::NotAbsolute)
    ));
}

#[test]
fn editor_remove_string_match_on_vanished_path() {
    let (s, w, _) = new_store(&abs(&["home", "u"]));
    w.set(r#"{"schemaVersion":2,"editors":{"list":["/gone/dir","/still/here"]}}"#);
    assert_eq!(
        s.editor_remove("/gone/dir").unwrap().editors,
        sv(&["/still/here"])
    );
}

#[test]
fn editor_reorder_delta() {
    let (s, w, _) = new_store(&abs(&["home", "u"]));
    let (a, b, c) = (abs(&["a"]), abs(&["b"]), abs(&["c"]));
    w.set(&editors_doc(&[&a, &b, &c]));
    let cab = vec![c.clone(), a.clone(), b.clone()];
    assert_eq!(s.editor_reorder(&c, &a, true).unwrap(), cab);
    assert_eq!(s.editor_reorder("/zz", &a, true).unwrap(), cab);
    assert_eq!(s.editor_reorder(&c, "/zz", true).unwrap(), cab);
    assert_eq!(s.editor_reorder(&c, "", false).unwrap(), vec![a, b, c]);
}

#[test]
fn parse_drops_malformed_editors() {
    let cases = [
        (r#"{"schemaVersion":2,"editors":"nope"}"#, sv(&[])),
        (r#"{"schemaVersion":2,"editors":{"list":"nope"}}"#, sv(&[])),
        (
            r#"{"schemaVersion":2,"editors":{"list":[1,null,{"a":1},"/ok",""]}}"#,
            sv(&["/ok"]),
        ),
        (r#"{"schemaVersion":2,"editors":[1,2]}"#, sv(&[])),
    ];
    for (raw, want) in cases {
        let (s, w, _) = new_store(&abs(&["home", "u"]));
        w.set(raw);
        assert_eq!(s.list().unwrap().1, want, "{raw}");
    }
}

#[test]
fn parse_errors_match_go() {
    let (s, w, _) = new_store(&abs(&["home", "u"]));
    w.set("[1]");
    assert_eq!(
        s.read().unwrap_err().to_string(),
        "workspace 파싱: json: cannot unmarshal array into Go value of type map[string]interface {}"
    );
    w.set("{");
    assert_eq!(
        s.read().unwrap_err().to_string(),
        "workspace 파싱: unexpected end of JSON input"
    );
}

#[test]
fn parse_null_blob_does_not_panic() {
    for raw in ["null", " null\n"] {
        let home = abs(&["home", "u"]);
        let (s, w, _) = new_store(&home);
        w.set(raw);
        let (h, list) = s.list().unwrap();
        assert!(h == home && list.is_empty());
        let x = abs(&["x"]);
        let l = s
            .mutate(|mut cur| {
                cur.editors.push(x.clone());
                cur
            })
            .unwrap();
        assert_eq!(l.editors, vec![abs(&["x"])]);
        assert_eq!(doc_of(&w.raw())["schemaVersion"], 2);
    }
}

#[test]
fn mutate_retries_once_on_stale() {
    let (s, w, b) = new_store(&abs(&["home", "u"]));
    w.set(r#"{"schemaVersion":2}"#);
    w.0.lock().unwrap().stale_once = true;
    let l = s
        .mutate(|mut cur| {
            cur.editors.push(abs(&["x"]));
            cur
        })
        .unwrap();
    assert_eq!(l.editors.len(), 1);
    assert_eq!(w.saves(), 1);
    assert_eq!(b.count(), 1);
    assert_eq!(
        b.0.lock().unwrap()[0],
        dm_webserver_sse::workspace_changed(1)
    );
}

struct AlwaysStale(Mutex<usize>);

impl WorkspaceStore for AlwaysStale {
    fn snapshot(&self) -> (Arc<Vec<u8>>, u64) {
        (Arc::new(br#"{"schemaVersion":2}"#.to_vec()), 0)
    }
    fn save(&self, _: &[u8], _: &str) -> Result<u64, dm_shared_workspace::Error> {
        *self.0.lock().unwrap() += 1;
        Err(dm_shared_workspace::Error::Stale)
    }
}

#[test]
fn mutate_gives_up_after_second_stale() {
    let w = Arc::new(AlwaysStale(Mutex::new(0)));
    let s = Store {
        work: Some(w.clone()),
        ..Store::default()
    };
    let err = s
        .mutate(|mut c| {
            c.editors.push(abs(&["a"]));
            c
        })
        .unwrap_err();
    assert!(err.is_stale());
    assert_eq!(*w.0.lock().unwrap(), 2);
}

#[test]
fn mutate_noop_does_not_save() {
    let (s, w, b) = new_store(&abs(&["home", "u"]));
    let (a, bb) = (abs(&["a"]), abs(&["b"]));
    w.set(&editors_doc(&[&a, &bb]));
    s.editor_remove("/nope").unwrap();
    s.editor_reorder("/nope", &a, true).unwrap();
    assert_eq!((w.saves(), b.count()), (0, 0));
    s.editor_remove(&a).unwrap();
    assert_eq!(w.saves(), 1);
}

#[tokio::test]
async fn linked_change_bumps_rev_once() {
    let (_t, dir) = tmp();
    let (mut s, w, b) = new_store(&j(&dir, "home"));
    let target = j(&dir, "repo");
    mkdir(&target);
    s.repo_root = Some(repo_root_fn(|p| Ok(p.to_owned())));
    let before = w.rev();
    s.editor_add(&ctx(), &target).await.unwrap();
    assert_eq!(w.rev(), before + 1);
    assert_eq!(b.count(), 1);
    let doc = doc_of(&w.raw());
    let norm = Value::String(normalize_path(&target));
    assert_eq!(doc["git"]["pinned"], Value::Array(vec![norm.clone()]));
    assert_eq!(doc["editors"]["list"], Value::Array(vec![norm]));
}

#[tokio::test]
async fn editor_add_pins_only_repo_root() {
    let (_t, dir) = tmp();
    let repo = j(&dir, "repo");
    let sub = j(&repo, "sub");
    mkdir(&sub);
    let root = normalize_path(&repo);
    let (mut s, _, _) = new_store(&j(&dir, "home"));
    let r2 = repo.clone();
    s.repo_root = Some(repo_root_fn(move |_| Ok(r2.clone())));
    let l = s.editor_add(&ctx(), &repo).await.unwrap();
    assert_eq!(l.pinned, vec![root]);
    let l = s.editor_add(&ctx(), &sub).await.unwrap();
    assert_eq!((l.pinned.len(), l.editors.len()), (1, 2));
    s.repo_root = Some(repo_root_fn(|_| Err("x".into())));
    let other = j(&dir, "other");
    mkdir(&other);
    assert_eq!(s.editor_add(&ctx(), &other).await.unwrap().pinned.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn editor_add_normalizes_symlinked_path() {
    let (_t, dir) = tmp();
    let (real, link) = (j(&dir, "real"), j(&dir, "link"));
    mkdir(&real);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (mut s, _, _) = new_store(&j(&dir, "home"));
    let r2 = real.clone();
    s.repo_root = Some(repo_root_fn(move |_| Ok(r2.clone())));
    let l = s.editor_add(&ctx(), &link).await.unwrap();
    let want = normalize_path(&real);
    assert_eq!(l.editors, vec![want.clone()]);
    assert_eq!(l.pinned, vec![want]);
}

#[test]
fn list_home_is_not_in_list() {
    let home = abs(&["home", "u"]);
    let (s, w, _) = new_store(&home);
    let a = abs(&["a"]);
    w.set(&editors_doc(&[&a]));
    let (h, list) = s.list().unwrap();
    assert_eq!(h, home);
    assert!(!list.contains(&h));
    assert_eq!(s.roots().unwrap(), vec![home, a]);
}

#[test]
fn mutate_without_workspace_fails() {
    let s = Store::default();
    assert!(matches!(s.mutate(|c| c), Err(Error::Unavailable)));
    assert!(matches!(s.read(), Err(Error::Unavailable)));
}

#[test]
fn mutate_seeds_schema_version_on_empty_blob() {
    let (s, w, _) = new_store(&abs(&["home", "u"]));
    let a = abs(&["a"]);
    s.mutate(|mut c| {
        c.editors = vec![a.clone()];
        c
    })
    .unwrap();
    assert_eq!(
        String::from_utf8(w.raw()).unwrap(),
        format!(
            r#"{{"editors":{{"list":[{}]}},"git":{{"pinned":[]}},"schemaVersion":2}}"#,
            jq(&a)
        )
    );
}

#[test]
fn pin_add_remove_round_trip() {
    let home = abs(&["home", "u"]);
    let (s, w, _) = new_store(&home);
    w.set(r#"{"schemaVersion":2}"#);
    let (norm, l) = s.pin_add("/no/such/../repo").unwrap();
    assert_eq!(norm, normalize_path("/no/repo"));
    assert_eq!((l.pinned.len(), l.editors.len()), (1, 1));
    let (_, l) = s.pin_add(&home).unwrap();
    assert_eq!((l.pinned.len(), l.editors.len()), (2, 1));
    let l = s.pin_remove(&norm).unwrap();
    assert_eq!(l.pinned, vec![home.clone()]);
    assert!(l.editors.is_empty());
    // 큰 정수·실수는 Go float64 처럼 다시 쓰인다.
    w.set(r#"{"schemaVersion":2,"n":12345678901234567890,"f":1.50,"h":"<&>","git":{"pinned":["/q"]}}"#);
    s.pin_remove("/q").unwrap();
    assert_eq!(
        String::from_utf8(w.raw()).unwrap(),
        r#"{"f":1.5,"git":{"pinned":[]},"h":"\u003c\u0026\u003e","n":12345678901234567000,"schemaVersion":2}"#
    );
}
