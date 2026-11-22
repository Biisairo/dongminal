use super::*;
use crate::manifest::{KIND_RUNTIME, KIND_SERVER, SOURCE_NPM, target_name};

#[test]
fn parse_manifest_pack() {
    let m = must_parse(PACK_JSON);
    assert_eq!(m.id, "vscode-langservers-extracted");
    assert_eq!(m.kind, KIND_SERVER);
    assert_eq!(m.servers.len(), 2, "서버가 둘이어야 한다 (FR-EXT-5)");
    assert_eq!(m.servers[0].exe, "vscode-html-language-server");
    assert_eq!(m.servers[0].args[0], "--stdio");
    assert_eq!(m.needs, vec!["node"], "needs 가 실리지 않았다 (FR-EXT-7)");
    assert_eq!(m.source.kind, SOURCE_NPM);
    assert!(!m.source.packages[0].is_empty());
}

#[test]
fn parse_manifest_runtime() {
    let js = format!(
        r#"{{
	  "id": "node", "kind": "runtime", "version": "v24.20.0",
	  "source": {{ "kind": "archive", "targets": {{
	    "darwin-arm64": {{
	      "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz",
	      "sha256": "{HEX64}", "strip": 1,
	      "provides": {{"node":"bin/node","npm":"lib/node_modules/npm/bin/npm-cli.js"}}
	    }}
	  }}}}
	}}"#
    );
    let m = must_parse(&js);
    assert_eq!(m.kind, KIND_RUNTIME);
    let tg = &m.source.targets[&target_name("darwin/arm64")];
    assert!(
        !tg.provides["npm"].is_empty(),
        "npm 경로가 타깃별 값으로 실려야 한다 (FR-EXT-13)"
    );
}

#[test]
fn parse_manifest_rejects_escaping_paths() {
    let bad = [
        format!(
            r#"{{"id":"x","kind":"runtime","version":"v1","source":{{"kind":"archive","targets":{{"darwin-arm64":{{"url":"https://e.x/a.tgz","sha256":"{HEX64}","provides":{{"node":"../../etc/passwd"}}}}}}}}}}"#
        ),
        format!(
            r#"{{"id":"x","kind":"runtime","version":"v1","source":{{"kind":"archive","targets":{{"darwin-arm64":{{"url":"https://e.x/a.tgz","sha256":"{HEX64}","provides":{{"node":"/usr/bin/node"}}}}}}}}}}"#
        ),
        r#"{"id":"x","kind":"server","source":{"kind":"toolchain","tool":"go","args":["install","x"],"bin":"../gopls"},"servers":[{"id":"a","exe":"gopls","exts":[".go"],"langs":["go"]}]}"#.to_owned(),
    ];
    for (i, js) in bad.iter().enumerate() {
        assert!(
            parse_manifest(js.as_bytes()).is_err(),
            "[{i}] 격리 칸을 벗어나는 경로가 통과했다 (FR-EXT-39)"
        );
    }
}

#[test]
fn parse_manifest_rejects_non_https() {
    for u in ["http://e.x/a.tgz", "file:///tmp/a.tgz", "ftp://e.x/a.tgz"] {
        let js = format!(
            r#"{{"id":"x","kind":"runtime","version":"v1","source":{{"kind":"archive","targets":{{"darwin-arm64":{{"url":"{u}","sha256":"{HEX64}","provides":{{"node":"bin/node"}}}}}}}}}}"#
        );
        assert!(
            parse_manifest(js.as_bytes()).is_err(),
            "{u} 가 통과했다 (FR-EXT-40)"
        );
    }
}

fn with_id(id: &str) -> String {
    PACK_JSON.replacen(
        r#""id": "vscode-langservers-extracted""#,
        &format!(r#""id": "{id}""#),
        1,
    )
}

#[test]
fn parse_manifest_rejects_bad_id() {
    for id in ["", "..", "a/b", r"a\\b", ".", r"a\bb", r"a\tb"] {
        assert!(
            parse_manifest(with_id(id).as_bytes()).is_err(),
            "id={id:?} 가 통과했다"
        );
    }
}

#[test]
fn parse_manifest_rejects_staging_suffix_id() {
    for id in ["x.new", "vscode.new"] {
        assert!(
            parse_manifest(with_id(id).as_bytes()).is_err(),
            "id={id:?} 가 통과했다"
        );
    }
    parse_manifest(with_id("x.newer").as_bytes()).unwrap();
}

#[test]
fn parse_manifest_rejects_empty_servers() {
    let js =
        r#"{"id":"x","kind":"server","source":{"kind":"npm","packages":["x@1"]},"servers":[]}"#;
    assert!(parse_manifest(js.as_bytes()).is_err());
}

#[test]
fn parse_manifest_normalizes_exts() {
    let js = r#"{"id":"x","kind":"server","source":{"kind":"npm","packages":["x@1"]},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":["GO",".TS"]}]}"#;
    assert_eq!(must_parse(js).servers[0].exts, vec![".go", ".ts"]);
}

#[test]
fn parse_manifest_rejects_unknown_source_kind() {
    let js = r#"{"id":"x","kind":"server","source":{"kind":"curl","package":"x@1"},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":[".go"]}]}"#;
    let e = parse_manifest(js.as_bytes()).unwrap_err();
    assert_eq!(e.to_string(), r#"x: 모르는 조달 방법입니다: "curl""#);
}

#[test]
fn parse_manifest_raw_target() {
    let js = |target: &str| {
        format!(
            r#"{{"id":"x","kind":"server","version":"v1","source":{{"kind":"archive","targets":{{"darwin-arm64":{target}}}}},"servers":[{{"id":"a","exe":"a","exts":[".x"],"langs":["x"]}}]}}"#
        )
    };
    let ok = format!(r#"{{"url":"https://e.x/a","sha256":"{HEX64}","raw":true,"bin":"a"}}"#);
    parse_manifest(js(&ok).as_bytes()).unwrap();
    let bad = [
        format!(r#"{{"url":"https://e.x/a","sha256":"{HEX64}","raw":true}}"#),
        format!(r#"{{"url":"https://e.x/a","sha256":"{HEX64}","raw":true,"bin":"../a"}}"#),
        format!(r#"{{"url":"https://e.x/a","sha256":"{HEX64}","raw":true,"bin":"a","strip":1}}"#),
    ];
    for (i, b) in bad.iter().enumerate() {
        assert!(
            parse_manifest(js(b).as_bytes()).is_err(),
            "[{i}] 잘못된 raw 타깃이 통과했다: {b}"
        );
    }
}

/// 오류 문구는 Go 와 같다 — 화면의 "깨진 선언" 사유로 나간다 (FR-EXT-8).
#[test]
fn parse_errors_match_go_text() {
    let cases = [
        (with_id("a/b"), r#"id 가 경로 한 칸이 아닙니다: "a/b""#.to_owned()),
        (with_id("x.new"), r#"id 는 ".new" 로 끝날 수 없습니다: "x.new""#.to_owned()),
        (
            r#"{"id":"x","kind":"plugin"}"#.to_owned(),
            r#"x: 모르는 kind 입니다: "plugin""#.to_owned(),
        ),
        (
            r#"{"id":"x","kind":"server","source":{"kind":"npm","packages":["-g"]},"servers":[{"id":"a","exe":"a"}]}"#.to_owned(),
            r#"x: 패키지 명세가 옵션처럼 보입니다: "-g""#.to_owned(),
        ),
        (
            r#"{"id":"x","kind":"server","source":{"kind":"toolchain","tool":"go","args":["i"],"bin":"../o"},"servers":[{"id":"a","exe":"a"}]}"#.to_owned(),
            r#"x: bin 이 격리 칸을 벗어납니다: 상위로 올라갑니다: "../o""#.to_owned(),
        ),
        (
            format!(
                r#"{{"id":"x","kind":"server","source":{{"kind":"archive","targets":{{"t":{{"url":"https://e/a","sha256":"{HEX64}","strip":-1}}}}}},"servers":[{{"id":"a","exe":"a"}}]}}"#
            ),
            "x[t]: strip 이 음수입니다: -1".to_owned(),
        ),
        (
            r#"{"id":"x","kind":"server","source":{"kind":"npm","packages":["a"]},"servers":[{"id":"a","exe":"b/c"}]}"#.to_owned(),
            r#"x/a: exe 는 이름이지 경로가 아닙니다: "b/c""#.to_owned(),
        ),
    ];
    for (js, want) in cases {
        let e = parse_manifest(js.as_bytes()).unwrap_err();
        assert_eq!(e.to_string(), want);
    }
    let e = parse_manifest(b"{ this is not json").unwrap_err();
    assert!(
        e.to_string().starts_with("선언을 해석할 수 없습니다: "),
        "{e}"
    );
}

#[test]
fn target_name_table() {
    let want = [
        ("darwin/arm64", "darwin-arm64"),
        ("darwin/amd64", "darwin-x64"),
        ("linux/amd64", "linux-x64"),
        ("linux/arm64", "linux-arm64"),
        ("linux/arm", "linux-armhf"),
        ("windows/amd64", "win32-x64"),
        ("windows/arm64", "win32-arm64"),
    ];
    for (input, exp) in want {
        assert_eq!(target_name(input), exp, "{input}");
    }
    assert_eq!(target_name("plan9/386"), "", "모르는 대상이 풀렸다");
    assert_eq!(target_name("linux"), "");
}
