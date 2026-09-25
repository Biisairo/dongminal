package ext

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-6-4 — 탐색 비용과 경로 표 키. 재는 것은 `LookPath` 횟수다.

// countingService 는 선언들을 격리 칸에 놓고 LookPath 를 세는 Service 다.
func countingService(t *testing.T, onPath map[string]string, decls ...string) (*Service, *atomic.Int32) {
	t.Helper()
	root := t.TempDir()
	for _, d := range decls {
		m := mustParse(t, d)
		dir := PluginDir(root, m.ID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(d), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var n atomic.Int32
	return &Service{Root: root, LookPath: func(name string) (string, error) {
		n.Add(1)
		if p, ok := onPath[name]; ok {
			return p, nil
		}
		return "", errors.New("not found")
	}}, &n
}

// DOM-11: 세션 계층의 Resolve 는 실행 파일을 찾으면 조달 가능성을 따지지 않는다.
func TestResolve_FoundStopsLooking(t *testing.T) {
	svc, n := countingService(t, map[string]string{"gopls": "/p/gopls", "go": "/p/go"}, goPack)
	_, _, st, ok := svc.Resolve(".go", nil)
	if !ok || !st.Found {
		t.Fatalf("못 찾았다: %+v", st)
	}
	// PATH 조회 한 번(gopls). 이전 동작: + 도구(go) 조회 한 번 = 2.
	if got := n.Load(); got != 1 {
		t.Fatalf("LookPath %d 번 — 찾은 뒤에 더 보지 않아야 한다 (1)", got)
	}
	// 못 찾으면 사유가 있어야 한다.
	svc, _ = countingService(t, nil, goPack)
	_, _, st, _ = svc.Resolve(".go", nil)
	if st.Found || st.Missing == nil || st.Missing.Kind != MissingTool {
		t.Fatalf("없는 것의 사유가 없다: %+v", st)
	}
}

// DOM-11: Status 는 조달 가능성을 팩마다 한 번 판정한다 — 서버 둘인 팩이 두 번 묻지 않는다.
func TestStatus_ReadinessOncePerPack(t *testing.T) {
	svc, n := countingService(t, map[string]string{"node": "/p/node"}, packJSON)
	sts, _ := svc.Status(nil)
	if len(sts) != 2 {
		t.Fatalf("서버 %d 개", len(sts))
	}
	for _, st := range sts {
		if st.Found || !st.CanInstall || st.Missing == nil || st.Missing.Kind != MissingNotFetched {
			t.Fatalf("관측이 달라졌다: %+v", st)
		}
	}
	// 서버마다 PATH 조회 1 + 팩 판정(node) 1 = 3. 이전 동작: 서버마다 판정 = 4.
	if got := n.Load(); got != 3 {
		t.Fatalf("LookPath %d 번 — 판정은 팩마다 한 번이어야 한다 (3)", got)
	}
}

// DOM-13: 경로 표의 키는 팩/서버다. 다른 팩의 같은 서버 id 에 번지지 않는다.
func TestLocate_OverridesKeyedByPackServer(t *testing.T) {
	root := t.TempDir()
	a := mustParse(t, goPack)
	b := mustParse(t, `{
  "id":"other","kind":"server",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]
}`)
	cfg := filepath.Join(root, "mine"+exeSuffix())
	mustExec(t, cfg)
	l := testLocator(root, nil, map[string]string{"gopls/gopls": cfg})
	if st := l.Locate(a, a.Servers[0]); st.Origin != OriginConfig || st.Exe != cfg {
		t.Fatalf("그 팩의 경로가 쓰이지 않았다: %+v", st)
	}
	if st := l.Locate(b, b.Servers[0]); st.Found {
		t.Fatalf("다른 팩의 같은 서버 id 에 경로가 번졌다: %+v", st)
	}
}

// DOM-12: 아는 서술자 id 는 선언만으로 안다 — 탐색하지 않는다.
func TestServerIDs_NoLocate(t *testing.T) {
	svc, n := countingService(t, nil, goPack, packJSON)
	ids := svc.ServerIDs()
	for _, want := range []string{"gopls/gopls", "vscode-langservers-extracted/html", "vscode-langservers-extracted/css"} {
		if !ids[want] {
			t.Fatalf("%s 가 없다: %v", want, ids)
		}
	}
	if len(ids) != 3 {
		t.Fatalf("ids = %v", ids)
	}
	if got := n.Load(); got != 0 {
		t.Fatalf("LookPath %d 번 — id 를 얻는 데 탐색하지 않아야 한다", got)
	}
}
