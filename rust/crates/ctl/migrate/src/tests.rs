use std::path::Path;

use serde_json::{Map, Value, json};

use super::*;
use crate::identity::is_uuid_form;

type M = Map<String, Value>;

const V1_BASIC: &str = r#"{
  "agentsOrder": ["100"],
  "sessions": [
    {"id":"s1","name":"work","layout":{
      "type":"region","id":"r1","activeTab":"t1",
      "tabs":[
        {"id":"t1","name":"Shell","type":"terminal","paneId":"100"},
        {"id":"t2","name":"Shell","type":"terminal","paneId":"101"}
      ]}}
  ]
}"#;

const V1_SPLIT: &str = r#"{
  "sessions": [
    {"id":"s1","name":"os","layout":{
      "type":"split","direction":"vertical","sizes":[0.61,0.39],
      "children":[
        {"type":"region","id":"r1","activeTab":"t1","tabs":[
          {"id":"t1","name":"Shell","type":"terminal","paneId":"200"}]},
        {"type":"split","direction":"horizontal","sizes":[0.5,0.5],"children":[
          {"type":"region","id":"r2","activeTab":"t2","tabs":[
            {"id":"t2","name":"Shell","type":"terminal","paneId":"201"}]},
          {"type":"region","id":"r3","activeTab":"t3","tabs":[
            {"id":"t3","name":"README.md","type":"editor","filePath":"/tmp/a.md"}]}
        ]}
      ]}}
  ]
}"#;

const PANES_BASIC: &str = r#"[
  {"id":"100","name":"Shell #100","cwd":"/a"},
  {"id":"101","name":"Shell #101","cwd":"/b"},
  {"id":"999","name":"Shell #999","cwd":"/orphan"}
]"#;

const SPLIT_TOOLS: &str =
    r#"[{"id":"200","name":"a","cwd":"/"},{"id":"201","name":"b","cwd":"/"}]"#;

fn obj(b: &[u8]) -> M {
    serde_json::from_slice(b).unwrap()
}

fn tool_ids(b: &[u8]) -> Vec<String> {
    let a: Vec<M> = serde_json::from_slice(b).unwrap();
    let mut v: Vec<String> = a
        .iter()
        .map(|m| m["id"].as_str().unwrap_or("").to_owned())
        .collect();
    v.sort();
    v
}

fn ws_of(r: &RunResult) -> M {
    obj(r.workspace.as_ref().unwrap())
}

fn types(n: &Value, out: &mut Vec<String>) {
    out.push(n["type"].as_str().unwrap().to_owned());
    if let Some(ch) = n.get("children").and_then(Value::as_array) {
        for c in ch {
            types(c, out);
        }
    }
}

// ── 스키마 개명 (FR-EM-2) ──

#[test]
fn run_renames_and_converts() {
    let r = run(V1_BASIC.as_bytes(), PANES_BASIC.as_bytes()).unwrap();
    let ws = ws_of(&r);
    assert!(!ws.contains_key("sessions"));
    assert_eq!(ws["windows"].as_array().unwrap().len(), 1);
    assert_eq!(ws["schemaVersion"], 2);
    let layout = &ws["windows"][0]["layout"];
    assert_eq!(layout["type"], "pane");
    for tab in layout["tabs"].as_array().unwrap() {
        assert!(tab.get("paneId").is_none());
        assert!(tab["toolId"].is_string());
    }
}

// Go json.Marshal(map) 의 바이트: 키 정렬, 공백 없음.
#[test]
fn run_output_bytes() {
    let r = run(V1_BASIC.as_bytes(), PANES_BASIC.as_bytes()).unwrap();
    assert_eq!(
        String::from_utf8(r.workspace.unwrap()).unwrap(),
        r#"{"agentsOrder":["100"],"schemaVersion":2,"windows":[{"id":"s1","layout":{"activeTab":"t1","id":"r1","tabs":[{"id":"t1","name":"Shell","toolId":"100","type":"terminal"},{"id":"t2","name":"Shell","toolId":"101","type":"terminal"}],"type":"pane"},"name":"work"}]}"#
    );
    assert_eq!(
        String::from_utf8(r.tools.unwrap()).unwrap(),
        r#"[{"cwd":"/a","id":"100","name":"Shell #100"},{"cwd":"/b","id":"101","name":"Shell #101"}]"#
    );
}

#[test]
fn run_nested_split_and_unknown_fields() {
    let r = run(V1_SPLIT.as_bytes(), SPLIT_TOOLS.as_bytes()).unwrap();
    let ws = ws_of(&r);
    let root = &ws["windows"][0]["layout"];
    let mut t = Vec::new();
    types(root, &mut t);
    assert_eq!(t, ["split", "pane", "split", "pane", "pane"]);
    assert_eq!(root["direction"], "vertical");
    assert_eq!(root["sizes"], json!([0.61, 0.39]));
    let editor = &root["children"][1]["children"][1]["tabs"][0];
    assert!(editor.get("toolId").is_none());
    assert_eq!(editor["filePath"], "/tmp/a.md");
}

// ── 고아·유령 참조 ──

#[test]
fn run_drops_orphans_and_reports() {
    let r = run(V1_BASIC.as_bytes(), PANES_BASIC.as_bytes()).unwrap();
    assert_eq!(tool_ids(r.tools.as_ref().unwrap()), ["100", "101"]);
    assert_eq!(r.report.orphans, ["999"]);
    let r = run(
        V1_BASIC.as_bytes(),
        br#"[{"id":"100","name":"a","cwd":"/"}]"#,
    )
    .unwrap();
    assert_eq!((r.report.windows, r.report.tools), (1, 1));
    assert_eq!(r.report.broken_refs, ["101"]);
}

#[test]
fn agents_order_ghost_refs_removed() {
    let ws = r#"{"agentsOrder":["100","350"],"sessions":[
      {"id":"s1","name":"w","layout":{"type":"region","id":"r1","activeTab":"t1",
        "tabs":[{"id":"t1","name":"Shell","type":"terminal","paneId":"100"}]}}]}"#;
    let r = run(ws.as_bytes(), br#"[{"id":"100","name":"a","cwd":"/"}]"#).unwrap();
    assert_eq!(ws_of(&r)["agentsOrder"], json!(["100"]));
    assert_eq!(r.report.ghost_refs, ["350"]);
}

// ── 멱등성·경계 ──

#[test]
fn run_is_idempotent() {
    let first = run(V1_BASIC.as_bytes(), PANES_BASIC.as_bytes()).unwrap();
    let second = run(
        first.workspace.as_ref().unwrap(),
        first.tools.as_ref().unwrap(),
    )
    .unwrap();
    assert_eq!(first.workspace, second.workspace);
    assert!(second.report.already_migrated);
}

#[test]
fn run_empty_and_invalid() {
    let r = run(b"", b"  \n").unwrap();
    assert!(r.report.empty && r.workspace.is_none() && r.tools.is_none());
    assert_eq!(
        run(br#"{"sessions":"#, PANES_BASIC.as_bytes())
            .unwrap_err()
            .to_string(),
        "workspace 파싱: unexpected end of JSON input"
    );
    assert!(
        run(V1_BASIC.as_bytes(), b"[{")
            .unwrap_err()
            .to_string()
            .starts_with("panes 파싱: ")
    );
    assert_eq!(
        run(b"[]", b"").unwrap_err().to_string(),
        "workspace 파싱: json: cannot unmarshal array into Go value of type map[string]interface {}"
    );
    assert_eq!(
        run(b"{}", b"{}").unwrap_err().to_string(),
        "panes 파싱: json: cannot unmarshal object into Go value of type []interface {}"
    );
}

#[test]
fn run_unknown_layout_type_preserved() {
    let ws = r#"{"sessions":[{"id":"s1","name":"w","layout":{"type":"future","id":"x1"}}]}"#;
    let r = run(ws.as_bytes(), b"[]").unwrap();
    assert_eq!(ws_of(&r)["windows"][0]["layout"]["type"], "future");
}

// FR-RSP-7: Go 는 workspace.json 이 null 이면 패닉한다. Rust 판은 빈 객체로 다룬다.
#[test]
fn run_null_workspace_is_empty_object() {
    let r = run(b"null", b"").unwrap();
    assert_eq!(r.workspace.unwrap(), br#"{"schemaVersion":2}"#);
}

// ── 식별자 재작성 (묶음 M) ──

const LEGACY_WS: &str = r#"{
  "schemaVersion": 2,
  "activeWindow": "s45",
  "agentsOrder": ["267"],
  "windows": [
    {"id":"s45","name":"dongminal","focusedPane":"r146","layout":{
      "type":"split","direction":"vertical","sizes":[0.5,0.5],
      "children":[
        {"type":"pane","id":"r146","activeTab":"t201","tabs":[
          {"id":"t201","name":"Shell","type":"terminal","toolId":"267"}]},
        {"type":"pane","id":"r147","activeTab":"t202","tabs":[
          {"id":"t202","name":"README.md","type":"editor","filePath":"/tmp/a.md"}]}
      ]}}
  ]
}"#;

const LEGACY_TOOLS: &str = r#"[{"id":"267","name":"Shell","cwd":"/x"}]"#;

fn seq_gen() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("{n:08}-0000-7000-8000-{n:012}")
    }
}

fn rewrite(ws: &[u8], tools: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>, IdentityReport) {
    let mut g = seq_gen();
    rewrite_identifiers(ws, tools, Some(&mut g)).unwrap()
}

fn walk_ids(ws: &M) -> Vec<String> {
    fn node(n: &Value, out: &mut Vec<String>) {
        if let Some(id) = n["id"].as_str() {
            out.push(id.into());
        }
        for tab in n
            .get("tabs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for k in ["id", "toolId"] {
                if let Some(id) = tab[k].as_str() {
                    out.push(id.into());
                }
            }
        }
        for c in n
            .get("children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            node(c, out);
        }
    }
    let mut out = Vec::new();
    for win in ws["windows"].as_array().unwrap() {
        if let Some(id) = win["id"].as_str() {
            out.push(id.into());
        }
        if win.get("layout").is_some() {
            node(&win["layout"], &mut out);
        }
    }
    out
}

#[test]
fn rewrite_all_legacy_ids_and_refs() {
    let (ws, tools, rep) = rewrite(LEGACY_WS.as_bytes(), LEGACY_TOOLS.as_bytes());
    assert_eq!((rep.windows, rep.panes, rep.tabs, rep.tools), (1, 2, 2, 1));
    // 도구가 먼저, 그다음 창·칸·탭 순서로 생성기를 부른다.
    let tools: Vec<M> = serde_json::from_slice(&tools.unwrap()).unwrap();
    assert_eq!(tools[0]["id"], "00000001-0000-7000-8000-000000000001");
    let ws = obj(&ws.unwrap());
    assert!(walk_ids(&ws).iter().all(|id| is_uuid_form(id)));
    let win = &ws["windows"][0];
    assert_eq!(ws["activeWindow"], win["id"]);
    let first = &win["layout"]["children"][0];
    assert_eq!(win["focusedPane"], first["id"]);
    let tab = &first["tabs"][0];
    assert_eq!(first["activeTab"], tab["id"]);
    assert_eq!(tab["toolId"], tools[0]["id"]);
    assert_eq!(ws["agentsOrder"][0], tools[0]["id"]);
    assert_eq!(ws["schemaVersion"], 2);
}

#[test]
fn rewrite_is_idempotent() {
    let (ws1, t1, _) = rewrite(LEGACY_WS.as_bytes(), LEGACY_TOOLS.as_bytes());
    let (ws2, t2, rep) = rewrite(ws1.as_ref().unwrap(), t1.as_ref().unwrap());
    assert_eq!(rep.total(), 0);
    assert_eq!((ws1, t1), (ws2, t2));
}

#[test]
fn rewrite_preserves_existing_uuids() {
    let mixed = r#"{"schemaVersion":2,"windows":[
      {"id":"2d019674-7f90-4c5b-8be7-56f5b7f250a1","name":"chart","layout":{
        "type":"pane","id":"r168","activeTab":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","tabs":[
          {"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","name":"Shell","type":"terminal",
           "toolId":"01a03610-2748-7000-ab60-aa7d580d9673"}]}}]}"#;
    let tools = r#"[{"id":"01a03610-2748-7000-ab60-aa7d580d9673","name":"Shell","cwd":"/x"}]"#;
    let (ws, _, rep) = rewrite(mixed.as_bytes(), tools.as_bytes());
    assert_eq!((rep.windows, rep.panes, rep.tabs, rep.tools), (0, 1, 0, 0));
    let ws = obj(&ws.unwrap());
    assert_eq!(
        ws["windows"][0]["id"],
        "2d019674-7f90-4c5b-8be7-56f5b7f250a1"
    );
    assert_ne!(ws["windows"][0]["layout"]["id"], "r168");
}

#[test]
fn rewrite_dangling_refs_preserved() {
    let d = r#"{"schemaVersion":2,"activeWindow":"s99","windows":[
      {"id":"s45","name":"w","focusedPane":"r777","layout":{
        "type":"pane","id":"r146","activeTab":"t888","tabs":[
          {"id":"t201","name":"Shell","type":"terminal","toolId":"404"}]}}]}"#;
    let (ws, _, rep) = rewrite(d.as_bytes(), b"[]");
    let ws = obj(&ws.unwrap());
    assert_eq!(ws["activeWindow"], "s99");
    assert_eq!(ws["windows"][0]["focusedPane"], "r777");
    assert_eq!(ws["windows"][0]["layout"]["activeTab"], "t888");
    assert_eq!(ws["windows"][0]["layout"]["tabs"][0]["toolId"], "404");
    assert_eq!(rep.dangling, ["s99", "r777", "t888", "404"]);
}

#[test]
fn rewrite_empty_input() {
    let (ws, tools, rep) = rewrite(b"", b"");
    assert!(ws.is_none() && tools.is_none() && rep.total() == 0);
    let (ws, tools, _) = rewrite(b"null", b"null");
    assert!(ws.is_none() && tools.is_none());
}

// ── settings ──

const V1_SETTINGS: &str = r#"{
  "themeName": "nord",
  "statsInterval": 3000,
  "statusBar": {"connection": true, "location": true},
  "shortcuts": {
    "sessionNext": "Alt+Comma", "sessionPrev": "Alt+KeyM",
    "newSession": "Ctrl+Shift+KeyN", "closeSession": "Ctrl+Shift+KeyW",
    "newTab": "Ctrl+Shift+KeyT", "tabNext": "Ctrl+Tab",
    "paneUp": "Ctrl+Shift+ArrowUp", "splitH": "Ctrl+Shift+KeyH"
  },
  "layoutPresets": [
    {"name": "2x1", "layout": {"type": "split", "direction": "horizontal",
      "children": [{"type": "region", "tabCount": 1}, {"type": "region", "tabCount": 2}]}},
    {"name": "single", "layout": {"type": "region", "tabCount": 1}}
  ],
  "defaultPreset": 0
}"#;

const V2_SETTINGS: &str = r#"{
  "themeName": "nord",
  "shortcuts": {
    "windowNext": "Alt+Comma", "newTab": "Ctrl+Shift+KeyT"
  },
  "layoutPresets": [
    {"name": "single", "layout": {"type": "pane", "tabCount": 1}}
  ]
}"#;

#[test]
fn settings_renames_and_converts() {
    let (out, rep) = settings(V1_SETTINGS.as_bytes()).unwrap();
    assert_eq!(
        rep,
        [
            "closeSession -> closeWindow",
            "newSession -> newWindow",
            "sessionNext -> windowNext",
            "sessionPrev -> windowPrev"
        ]
    );
    let out = out.unwrap();
    let m = obj(&out);
    let sc = &m["shortcuts"];
    for old in ["sessionNext", "sessionPrev", "newSession", "closeSession"] {
        assert!(sc.get(old).is_none());
    }
    assert_eq!(sc["windowNext"], "Alt+Comma");
    assert_eq!(sc["closeWindow"], "Ctrl+Shift+KeyW");
    assert_eq!(sc["paneUp"], "Ctrl+Shift+ArrowUp");
    let mut t = Vec::new();
    for p in m["layoutPresets"].as_array().unwrap() {
        types(&p["layout"], &mut t);
    }
    assert_eq!(t, ["split", "pane", "pane", "pane"]);
    assert_eq!(m["themeName"], "nord");
    assert_eq!(m["statsInterval"], 3000);
    assert_eq!(m["defaultPreset"], 0);
    assert_eq!(m["statusBar"]["location"], true);
    assert_eq!(settings(&out).unwrap(), (None, vec![]));
}

#[test]
fn settings_no_change_cases() {
    assert_eq!(settings(b"").unwrap(), (None, vec![]));
    assert_eq!(
        settings(br#"{"themeName":"nord"}"#).unwrap(),
        (None, vec![])
    );
    assert_eq!(settings(V2_SETTINGS.as_bytes()).unwrap(), (None, vec![]));
    assert_eq!(settings(b"null").unwrap(), (None, vec![]));
    assert!(settings(br#"{"shortcuts":"#).is_err());
    let (out, rep) =
        settings(br#"{"layoutPresets":[{"name":"s","layout":{"type":"region"}}]}"#).unwrap();
    assert_eq!(
        out.unwrap(),
        br#"{"layoutPresets":[{"layout":{"type":"pane"},"name":"s"}]}"#
    );
    assert!(rep.is_empty());
}

#[test]
fn settings_respects_existing_new_key() {
    let (out, rep) = settings(br#"{"shortcuts":{"sessionNext":"A","windowNext":"B"}}"#).unwrap();
    assert_eq!(out.unwrap(), br#"{"shortcuts":{"windowNext":"B"}}"#);
    assert_eq!(rep, ["sessionNext -> windowNext"]);
}

// ── apply (파일 IO) ──

fn seed(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

fn exists(dir: &Path, name: &str) -> bool {
    dir.join(name).exists()
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn apply_writes_v2_and_backups() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", V1_BASIC);
    seed(dir, "panes.json", PANES_BASIC);
    let rep = apply(dir, false).unwrap();
    assert_eq!((rep.windows, rep.tools), (1, 2));
    let ws = obj(read(dir, "workspace.json").as_bytes());
    assert_eq!(ws["schemaVersion"], 2);
    assert!(walk_ids(&ws).iter().all(|id| is_uuid_form(id)));
    assert_eq!(
        (
            rep.identity.windows,
            rep.identity.panes,
            rep.identity.tabs,
            rep.identity.tools
        ),
        (1, 1, 2, 2)
    );
    assert!(
        tool_ids(read(dir, "tools.json").as_bytes())
            .iter()
            .all(|id| is_uuid_form(id))
    );
    assert_eq!(read(dir, "workspace.json.v1.bak"), V1_BASIC);
    assert_eq!(read(dir, "panes.json.v1.bak"), PANES_BASIC);
    assert!(!exists(dir, "panes.json"));
}

#[test]
fn apply_rerun_keeps_backup_and_reads_tools() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", V1_BASIC);
    seed(dir, "panes.json", PANES_BASIC);
    apply(dir, false).unwrap();
    let tools_before = read(dir, "tools.json");
    let rep = apply(dir, false).unwrap();
    assert!(rep.already_migrated);
    assert_eq!(rep.tools, 2);
    assert!(rep.broken_refs.is_empty() && rep.orphans.is_empty());
    assert_eq!(read(dir, "tools.json"), tools_before);
    assert_eq!(read(dir, "workspace.json.v1.bak"), V1_BASIC);
}

#[test]
fn apply_dry_run_writes_nothing() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", V1_BASIC);
    seed(dir, "panes.json", PANES_BASIC);
    seed(dir, "settings.json", V1_SETTINGS);
    let rep = apply(dir, true).unwrap();
    assert_eq!(rep.windows, 1);
    assert!(rep.identity.total() > 0);
    assert_eq!(read(dir, "workspace.json"), V1_BASIC);
    assert_eq!(read(dir, "settings.json"), V1_SETTINGS);
    for f in [
        "tools.json",
        "workspace.json.v1.bak",
        "settings.json.v1.bak",
        "workspace.json.preuuid.bak",
    ] {
        assert!(!exists(dir, f), "{f}");
    }
    assert!(exists(dir, "panes.json"));
}

#[test]
fn apply_missing_files_is_noop() {
    let d = tmp();
    let rep = apply(d.path(), false).unwrap();
    assert!(rep.empty);
    assert!(!exists(d.path(), "workspace.json") && !exists(d.path(), "tools.json"));
}

#[test]
fn apply_workspace_only() {
    let d = tmp();
    seed(d.path(), "workspace.json", V1_BASIC);
    let rep = apply(d.path(), false).unwrap();
    assert_eq!(rep.windows, 1);
    assert!(rep.shortcuts_renamed.is_empty());
    assert!(!exists(d.path(), "tools.json"));
    assert!(exists(d.path(), "workspace.json.v1.bak"));
}

#[test]
fn apply_invalid_json_leaves_files_untouched() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", r#"{"sessions":"#);
    seed(dir, "panes.json", PANES_BASIC);
    assert!(apply(dir, false).is_err());
    assert_eq!(read(dir, "workspace.json"), r#"{"sessions":"#);
    assert!(!exists(dir, "tools.json") && !exists(dir, "workspace.json.v1.bak"));
    assert!(exists(dir, "panes.json"));
}

#[test]
fn apply_refuses_while_daemon_alive() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", V1_BASIC);
    seed(dir, "panes.json", PANES_BASIC);
    let pid = std::process::id();
    seed(dir, "paned.pid", &format!("{pid}\n"));
    let e = apply(dir, false).unwrap_err();
    assert!(e.is_daemon_running());
    assert_eq!(
        e.to_string(),
        format!(
            "dongminald 가 실행 중입니다 — `dongminal stop --all` 로 정지한 뒤 다시 실행하세요 (pid={pid})"
        )
    );
    assert!(!exists(dir, "tools.json"));
    assert_eq!(read(dir, "workspace.json"), V1_BASIC);
    assert_eq!(apply(dir, true).unwrap().windows, 1);
    seed(dir, "paned.pid", "4194304\n");
    apply(dir, false).unwrap();
    assert!(exists(dir, "tools.json"));
}

#[test]
fn apply_pre_uuid_backup_on_v2_home() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", LEGACY_WS);
    seed(dir, "tools.json", LEGACY_TOOLS);
    seed(dir, "workspace.json.v1.bak", r#"{"stale":"v1 원본"}"#);
    let rep = apply(dir, false).unwrap();
    assert!(rep.identity.total() > 0);
    assert_eq!(read(dir, "workspace.json.preuuid.bak"), LEGACY_WS);
    assert_eq!(read(dir, "tools.json.preuuid.bak"), LEGACY_TOOLS);
    assert_eq!(read(dir, "workspace.json.v1.bak"), r#"{"stale":"v1 원본"}"#);
}

#[test]
fn apply_settings() {
    let d = tmp();
    let dir = d.path();
    seed(dir, "workspace.json", V1_BASIC);
    seed(dir, "panes.json", PANES_BASIC);
    seed(dir, "settings.json", V1_SETTINGS);
    let rep = apply(dir, false).unwrap();
    assert_eq!(rep.shortcuts_renamed.len(), 4);
    assert_eq!(read(dir, "settings.json.v1.bak"), V1_SETTINGS);
    assert_eq!(
        obj(read(dir, "settings.json").as_bytes())["shortcuts"]["windowNext"],
        "Alt+Comma"
    );

    let d = tmp();
    seed(d.path(), "settings.json", V2_SETTINGS);
    assert!(apply(d.path(), false).unwrap().empty);
    assert_eq!(read(d.path(), "settings.json"), V2_SETTINGS);
    assert!(!exists(d.path(), "settings.json.v1.bak"));
}

#[cfg(unix)]
#[test]
fn apply_read_error_is_go_shaped() {
    let d = tmp();
    std::fs::create_dir(d.path().join("workspace.json")).unwrap();
    assert_eq!(
        apply(d.path(), false).unwrap_err().to_string(),
        format!(
            "workspace.json 읽기: read {}: is a directory",
            d.path().join("workspace.json").display()
        )
    );
}
