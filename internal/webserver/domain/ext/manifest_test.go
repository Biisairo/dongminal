package ext

import (
	"strings"
	"testing"
)

// 온전한 팩 하나. 검사들이 여기서 한 글자씩 바꿔 가며 거절을 잰다.
const packJSON = `{
  "id": "vscode-langservers-extracted",
  "kind": "server",
  "needs": ["node"],
  "source": { "kind":"npm","packages":["vscode-langservers-extracted@4.10.0"] },
  "servers": [
    {"id":"html","langs":["html"],"exts":[".html",".htm"],"exe":"vscode-html-language-server","args":["--stdio"]},
    {"id":"css","langs":["css"],"exts":[".css"],"exe":"vscode-css-language-server","args":["--stdio"]}
  ]
}`

// TC-EXT-1 (FR-EXT-3·4): 매니페스트가 팩과 그것이 내는 서버들로 풀린다.
func TestParseManifest_Pack(t *testing.T) {
	m, err := ParseManifest([]byte(packJSON))
	if err != nil {
		t.Fatalf("온전한 매니페스트가 거절됐다: %v", err)
	}
	if m.ID != "vscode-langservers-extracted" || m.Kind != KindServer {
		t.Fatalf("팩의 머리가 다르다: %+v", m)
	}
	if len(m.Servers) != 2 {
		t.Fatalf("서버가 둘이어야 한다 (FR-EXT-5): %d", len(m.Servers))
	}
	if m.Servers[0].Exe != "vscode-html-language-server" || m.Servers[0].Args[0] != "--stdio" {
		t.Fatalf("서버의 기동 값이 다르다: %+v", m.Servers[0])
	}
	if len(m.Needs) != 1 || m.Needs[0] != "node" {
		t.Fatalf("needs 가 실리지 않았다 (FR-EXT-7): %+v", m.Needs)
	}
	if m.Source.Kind != SourceNPM || m.Source.Packages[0] == "" {
		t.Fatalf("조달 선언이 풀리지 않았다: %+v", m.Source)
	}
}

// TC-EXT-2 (FR-EXT-6): 런타임 플러그인은 servers 대신 provides 를 갖는다.
func TestParseManifest_Runtime(t *testing.T) {
	const js = `{
	  "id": "node",
	  "kind": "runtime",
	  "version": "v24.20.0",
	  "source": { "kind": "archive", "targets": {
	    "darwin-arm64": {
	      "url": "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz",
	      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
	      "strip": 1,
	      "provides": {"node":"bin/node","npm":"lib/node_modules/npm/bin/npm-cli.js"}
	    }
	  }}
	}`
	m, err := ParseManifest([]byte(js))
	if err != nil {
		t.Fatalf("런타임 매니페스트가 거절됐다: %v", err)
	}
	if m.Kind != KindRuntime {
		t.Fatalf("kind 가 runtime 이 아니다: %s", m.Kind)
	}
	tg, ok := m.Source.Targets[TargetName("darwin/arm64")]
	if !ok {
		t.Fatalf("타깃이 풀리지 않았다: %+v", m.Source.Targets)
	}
	if tg.Provides["npm"] == "" {
		t.Fatal("npm 경로가 타깃별 값으로 실려야 한다 (FR-EXT-13)")
	}
}

// TC-EXT-3 (FR-EXT-39): 경로 값이 격리 칸을 벗어날 수 없다.
//
// 아카이브가 우리 칸 밖에 파일을 쓰는 것을 막는 자리이며, 이 거절이 없으면
// 매니페스트 한 줄로 사용자 홈의 파일이 덮인다.
func TestParseManifest_RejectsEscapingPaths(t *testing.T) {
	bad := []string{
		`{"id":"x","kind":"runtime","version":"v1","source":{"kind":"archive","targets":{"darwin-arm64":{"url":"https://e.x/a.tgz","sha256":"` + hex64 + `","provides":{"node":"../../etc/passwd"}}}}}`,
		`{"id":"x","kind":"runtime","version":"v1","source":{"kind":"archive","targets":{"darwin-arm64":{"url":"https://e.x/a.tgz","sha256":"` + hex64 + `","provides":{"node":"/usr/bin/node"}}}}}`,
		`{"id":"x","kind":"server","source":{"kind":"toolchain","tool":"go","args":["install","x"],"bin":"../gopls"},"servers":[{"id":"a","exe":"gopls","exts":[".go"],"langs":["go"]}]}`,
	}
	for i, js := range bad {
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Fatalf("[%d] 격리 칸을 벗어나는 경로가 통과했다 (FR-EXT-39)", i)
		}
	}
}

// TC-EXT-4 (FR-EXT-40): https 가 아닌 조달처는 거절된다.
func TestParseManifest_RejectsNonHTTPS(t *testing.T) {
	for _, u := range []string{"http://e.x/a.tgz", "file:///tmp/a.tgz", "ftp://e.x/a.tgz"} {
		js := `{"id":"x","kind":"runtime","version":"v1","source":{"kind":"archive","targets":{"darwin-arm64":{"url":"` + u +
			`","sha256":"` + hex64 + `","provides":{"node":"bin/node"}}}}}`
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Fatalf("%s 가 통과했다 (FR-EXT-40)", u)
		}
	}
}

// TC-EXT-5 (FR-EXT-2·39): id 는 경로 한 칸이 되므로 구분자를 담을 수 없다.
func TestParseManifest_RejectsBadID(t *testing.T) {
	// `a\\b` 는 JSON 이 `a\b` 로 푼다 — 한 겹 덜 쓰면 JSON 이 그것을 백스페이스
	// 이스케이프로 읽어, 재려던 것과 다른 것(제어문자 id)을 재게 된다.
	// 마지막 둘이 그 제어문자 갈래이며 이것도 이름이 될 수 없다.
	for _, id := range []string{"", "..", "a/b", `a\\b`, ".", `a\bb`, `a\tb`} {
		js := strings.Replace(packJSON, `"id": "vscode-langservers-extracted"`, `"id": "`+id+`"`, 1)
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Fatalf("id=%q 가 통과했다", id)
		}
	}
}

// TC-EXT-6 (FR-EXT-3·4): 서버를 하나도 내지 않는 server 팩은 뜻이 없다.
func TestParseManifest_RejectsEmptyServers(t *testing.T) {
	const js = `{"id":"x","kind":"server","source":{"kind":"npm","packages":["x@1"]},"servers":[]}`
	if _, err := ParseManifest([]byte(js)); err == nil {
		t.Fatal("서버가 빈 server 팩이 통과했다")
	}
}

// TC-EXT-7 (FR-EXT-4): 확장자는 소문자·점 포함으로 정규화된다.
//
// 화면이 이 표로 "이 파일의 서버가 있는가" 를 판정하므로(FR-LSP-44) 표기가
// 흔들리면 그 언어에서 제안이 뜨지 않는다.
func TestParseManifest_NormalizesExts(t *testing.T) {
	const js = `{"id":"x","kind":"server","source":{"kind":"npm","packages":["x@1"]},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":["GO",".TS"]}]}`
	m, err := ParseManifest([]byte(js))
	if err != nil {
		t.Fatalf("거절됐다: %v", err)
	}
	got := m.Servers[0].Exts
	if len(got) != 2 || got[0] != ".go" || got[1] != ".ts" {
		t.Fatalf("확장자가 정규화되지 않았다: %+v", got)
	}
}

// TC-EXT-8 (FR-EXT-1): 매니페스트 없이는 아는 서버가 없다.
//
// 이 검사가 지키는 것은 "Go 코드에 목록이 없다" 이다 — 기본 셋이 코드로 돌아오면
// 여기가 먼저 깨진다.
func TestParseManifest_RejectsUnknownSourceKind(t *testing.T) {
	const js = `{"id":"x","kind":"server","source":{"kind":"curl","package":"x@1"},
	  "servers":[{"id":"a","exe":"a","langs":["go"],"exts":[".go"]}]}`
	if _, err := ParseManifest([]byte(js)); err == nil {
		t.Fatal("모르는 조달 방법이 통과했다")
	}
}

const hex64 = "0000000000000000000000000000000000000000000000000000000000000000"
