package ext

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

func mustParse(t *testing.T, js string) Manifest {
	t.Helper()
	m, err := ParseManifest([]byte(js))
	if err != nil {
		t.Fatalf("매니페스트가 거절됐다: %v", err)
	}
	return m
}

func testLocator(root string, onPath map[string]string, overrides map[string]string, runtimes ...Manifest) *Locator {
	return &Locator{
		Root: root,
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
		Overrides: overrides,
		Runtimes:  runtimes,
	}
}

// 조달물을 놓는다. 자리는 **구현과 같은 함수**로 얻는다 — 검사가 자리를 따로 적으면
// 배치가 바뀔 때 검사가 먼저 통과하고 실제로는 못 찾는다 (FR-EXT-19 의 근거).
func putManaged(t *testing.T, root string, m Manifest, s Server) string {
	t.Helper()
	p := ManagedExe(root, m, s)
	if p == "" {
		t.Fatal("조달물의 자리를 얻지 못했다")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	mustExec(t, p)
	return p
}

// exeSuffix 는 이 플랫폼의 실행 파일 확장자다 (FR-EXT-41 / FR-LWP-1).
//
// 검사가 만드는 가짜 배포본도 **실제 배포본과 같은 이름 규칙**을 따라야 한다 —
// Windows 의 node 아카이브가 `node.exe` 를 담는 것처럼(`builtin/node.json` 의
// win32-* 타깃), 확장자 없는 파일은 그 OS 에서 실행 파일이 아니다. 이름을 그대로
// 두면 검사는 **제품이 옳게 판정한 것**을 실패로 읽는다.
func exeSuffix() string { return platform.Current().Paths.ExeSuffix() }

func mustExec(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

const npmPack = `{
  "id":"yaml","kind":"server","needs":["node"],
  "source":{"kind":"npm","packages":["yaml-language-server@1.24.0"]},
  "servers":[{"id":"yaml","langs":["yaml"],"exts":[".yaml",".yml"],"exe":"yaml-language-server","args":["--stdio"]}]
}`

const goPack = `{
  "id":"gopls","kind":"server",
  "source":{"kind":"toolchain","tool":"go","args":["install","golang.org/x/tools/gopls@latest"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]
}`

const nodeRuntime = `{
  "id":"node","kind":"runtime","version":"v24.20.0",
  "source":{"kind":"archive","targets":{
    "darwin-arm64":{"url":"https://nodejs.org/dist/x.tar.gz","sha256":"` + hex64 + `","strip":1,"provides":{"node":"bin/node","npm":"bin/npm"}},
    "darwin-x64":{"url":"https://nodejs.org/dist/x.tar.gz","sha256":"` + hex64 + `","strip":1,"provides":{"node":"bin/node","npm":"bin/npm"}},
    "linux-x64":{"url":"https://nodejs.org/dist/x.tar.gz","sha256":"` + hex64 + `","strip":1,"provides":{"node":"bin/node","npm":"bin/npm"}},
    "linux-arm64":{"url":"https://nodejs.org/dist/x.tar.gz","sha256":"` + hex64 + `","strip":1,"provides":{"node":"bin/node","npm":"bin/npm"}},
    "win32-x64":{"url":"https://nodejs.org/dist/x.zip","sha256":"` + hex64 + `","strip":1,"provides":{"node":"node.exe","npm":"node_modules/npm/bin/npm-cli.js"}}
  }}
}`

// TC-EXT-10 (FR-EXT-11 / D-P5): 타깃 표기는 VS Code 의 것이다. 우리 표기를 만들면
// 매니페스트를 쓰는 사람이 그것을 따로 배워야 한다.
func TestTargetName(t *testing.T) {
	want := map[string]string{
		"darwin/arm64":  "darwin-arm64",
		"darwin/amd64":  "darwin-x64",
		"linux/amd64":   "linux-x64",
		"linux/arm64":   "linux-arm64",
		"linux/arm":     "linux-armhf",
		"windows/amd64": "win32-x64",
		"windows/arm64": "win32-arm64",
	}
	for in, exp := range want {
		if got := TargetName(in); got != exp {
			t.Errorf("TargetName(%q)=%q want %q", in, got, exp)
		}
	}
	// 모르는 것은 조용히 틀린 타깃을 만들지 않는다 — 빈 값이어야 조달이 멈춘다.
	if got := TargetName("plan9/386"); got != "" {
		t.Errorf("모르는 대상이 %q 로 풀렸다 — 조달이 엉뚱한 것을 받는다", got)
	}
}

// TC-EXT-11 (FR-EXT-27): 탐색 순서는 ①설정 ②PATH ③격리 칸이다.
func TestLocate_Order(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	s := m.Servers[0]

	// ③ 격리 칸만 있을 때
	managed := putManaged(t, root, m, s)
	st := testLocator(root, nil, nil).Locate(m, s)
	if !st.Found || st.Origin != OriginManaged || st.Exe != managed {
		t.Fatalf("격리 칸의 것을 못 찾았다: %+v", st)
	}

	// ② PATH 가 격리 칸을 이긴다 — 사용자가 이미 자기 방식으로 깐 것이 앞선다
	onPath := map[string]string{"gopls": filepath.Join(root, "from-path")}
	st = testLocator(root, onPath, nil).Locate(m, s)
	if st.Origin != OriginPath {
		t.Fatalf("PATH 가 격리 칸을 이기지 않았다: %+v", st)
	}

	// ① 설정이 전부를 이긴다 — 적었다는 것 자체가 의사표시다
	cfg := filepath.Join(root, "from-config"+exeSuffix())
	mustExec(t, cfg)
	st = testLocator(root, onPath, map[string]string{"gopls": cfg}).Locate(m, s)
	if st.Origin != OriginConfig || st.Exe != cfg {
		t.Fatalf("설정 경로가 이기지 않았다: %+v", st)
	}
}

// TC-EXT-12 (FR-EXT-28): PATH 로 찾은 것은 **격리되지 않았음**이 드러나야 한다.
//
// 사용자가 자기 것을 쓰는 것은 정당하지만, 그것이 우리 격리의 예외라는 사실까지
// 조용하면 "격리했다" 는 말이 거짓이 된다.
func TestLocate_IsolatedFlag(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	s := m.Servers[0]

	putManaged(t, root, m, s)
	if st := testLocator(root, nil, nil).Locate(m, s); !st.Isolated {
		t.Fatalf("격리 칸의 것이 격리되지 않았다고 보고됐다: %+v", st)
	}

	onPath := map[string]string{"gopls": filepath.Join(root, "elsewhere")}
	st := testLocator(root, onPath, nil).Locate(m, s)
	if st.Isolated {
		t.Fatalf("PATH 의 것이 격리됐다고 보고됐다 (FR-EXT-28): %+v", st)
	}
}

// TC-EXT-13 (FR-EXT-5): 팩 하나가 서버 여럿을 낸다. 조달물은 하나를 나눠 쓴다.
func TestLocate_PackYieldsAllServers(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, packJSON)
	if len(m.Servers) != 2 {
		t.Fatalf("이 검사는 서버 둘인 팩을 전제한다: %d", len(m.Servers))
	}
	for _, s := range m.Servers {
		putManaged(t, root, m, s)
	}
	// 같은 팩의 두 서버는 **같은 디렉터리**에서 나온다 — 팩마다 따로 받으면
	// 같은 패키지를 두 번 받는다.
	a := filepath.Dir(ManagedExe(root, m, m.Servers[0]))
	b := filepath.Dir(ManagedExe(root, m, m.Servers[1]))
	if a != b {
		t.Fatalf("한 팩의 서버들이 다른 자리를 쓴다: %s vs %s", a, b)
	}
	node := mustParse(t, nodeRuntime)
	putRuntime(t, root, node)
	for _, s := range m.Servers {
		if st := testLocator(root, nil, nil, node).Locate(m, s); !st.Found {
			t.Fatalf("%s 를 못 찾았다: %+v", s.ID, st)
		}
	}
}

// TC-EXT-14 (FR-EXT-19 / FR-LWP-6): 조달 방법마다 산출물의 자리가 다르다.
// 한 자리만 보면 받아 두고도 못 찾는다.
func TestLocate_ManagedLayoutPerSource(t *testing.T) {
	root := t.TempDir()
	npm := mustParse(t, npmPack)
	tool := mustParse(t, goPack)

	npmDir := filepath.Dir(ManagedExe(root, npm, npm.Servers[0]))
	if want := filepath.Join(PluginDir(root, npm.ID), "node_modules", ".bin"); npmDir != want {
		t.Fatalf("npm 조달물의 자리가 다르다: %s (기대 %s)", npmDir, want)
	}
	toolDir := filepath.Dir(ManagedExe(root, tool, tool.Servers[0]))
	if want := filepath.Join(PluginDir(root, tool.ID), "bin"); toolDir != want {
		t.Fatalf("toolchain 조달물의 자리가 다르다: %s (기대 %s)", toolDir, want)
	}
	if npmDir == toolDir {
		t.Fatal("두 조달 방법이 같은 자리를 쓴다 — 한쪽이 다른 쪽을 가린다")
	}
}

// TC-EXT-15 (FR-EXT-41): 실행할 수 없는 동명 파일을 서버로 삼지 않는다.
func TestLocate_NeedsExecutable(t *testing.T) {
	if platform.Current().OS == platform.Windows {
		t.Skip("Windows 는 권한 비트를 갖지 않는다 (FR-LWP-3)")
	}
	root := t.TempDir()
	m := mustParse(t, goPack)
	s := m.Servers[0]
	p := ManagedExe(root, m, s)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("not exec"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := testLocator(root, nil, nil).Locate(m, s); st.Found {
		t.Fatalf("실행할 수 없는 파일을 서버로 삼았다: %+v", st)
	}
}

// TC-EXT-16 (FR-EXT-7·29): 런타임이 없으면 그 사실을 **런타임의 이름으로** 알린다.
func TestLocate_MissingRuntime(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, npmPack)
	s := m.Servers[0]
	node := mustParse(t, nodeRuntime)

	st := testLocator(root, nil, nil, node).Locate(m, s)
	if st.Found {
		t.Fatalf("조달하지도 않은 서버를 찾았다: %+v", st)
	}
	if st.Missing == nil || st.Missing.Kind != MissingRuntime || st.Missing.Name != "node" {
		t.Fatalf("없는 것이 런타임 이름으로 알려지지 않았다 (FR-EXT-29): %+v", st.Missing)
	}

	// 호스트 PATH 의 node 도 런타임을 채운다 — 대개의 개발 기계가 이 갈래다.
	st = testLocator(root, map[string]string{"node": "/usr/bin/node"}, nil, node).Locate(m, s)
	if st.Missing == nil || st.Missing.Kind != MissingNotFetched {
		t.Fatalf("런타임이 있으면 남는 것은 '아직 안 받음' 뿐이다: %+v", st.Missing)
	}
}

// TC-EXT-17 (FR-EXT-14·29): 호스트 도구가 없으면 도구 이름으로 알린다.
//
// gopls 가 이 갈래다 — prebuilt 가 어디에도 없으므로(§2.3) 받을 URL 이 없다.
func TestLocate_MissingTool(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	s := m.Servers[0]

	st := testLocator(root, nil, nil).Locate(m, s)
	if st.Missing == nil || st.Missing.Kind != MissingTool || st.Missing.Name != "go" {
		t.Fatalf("없는 도구가 이름으로 알려지지 않았다: %+v", st.Missing)
	}
	if st.CanInstall {
		t.Fatal("도구가 없는데 조달할 수 있다고 했다 (FR-EXT-14)")
	}

	st = testLocator(root, map[string]string{"go": "/usr/bin/go"}, nil).Locate(m, s)
	if !st.CanInstall {
		t.Fatalf("도구가 있는데 조달할 수 없다고 했다: %+v", st)
	}
	if st.Missing == nil || st.Missing.Kind != MissingNotFetched {
		t.Fatalf("도구가 있으면 남는 것은 '아직 안 받음' 뿐이다: %+v", st.Missing)
	}
}

// TC-EXT-18 (FR-EXT-33): 상태는 캐시가 아니라 관측이다. 지우면 다음 조회가 없음을 낸다.
func TestLocate_IsObservationNotCache(t *testing.T) {
	root := t.TempDir()
	m := mustParse(t, goPack)
	s := m.Servers[0]
	l := testLocator(root, nil, nil)

	p := putManaged(t, root, m, s)
	if st := l.Locate(m, s); !st.Found {
		t.Fatal("놓은 것을 못 찾았다")
	}
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if st := l.Locate(m, s); st.Found {
		t.Fatalf("지운 것을 있다고 우겼다 (FR-EXT-33): %+v", st)
	}
}

// putRuntime 은 런타임의 provides 를 실제 파일로 놓는다.
func putRuntime(t *testing.T, root string, m Manifest) {
	t.Helper()
	tg, ok := m.Source.Targets[CurrentTarget()]
	if !ok {
		t.Skipf("이 타깃(%s)의 런타임 선언이 검사 매니페스트에 없다", CurrentTarget())
	}
	for _, rel := range tg.Provides {
		p := filepath.Join(RuntimeDir(root, m), rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		mustExec(t, p)
	}
}
