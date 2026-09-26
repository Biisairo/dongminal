package runtimebin

import (
	"bytes"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-5 (SHR-31) — list-workspace 는 서버가 `/api/state` 에
// fgTabNames 를 실어 주면 왕복 한 번이다. 모르는 옛 서버에는 종전대로 설정을 묻는다.
func listWorkspaceAgainst(t *testing.T, state string) (paths []string, out string) {
	t.Helper()
	var mu sync.Mutex
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/api/state":
			w.Write([]byte(state))
		case "/api/settings":
			w.Write([]byte(`{"fgTabNames":false}`))
		}
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	if rc := runDmctl([]string{"list-workspace"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	return paths, stdout.String()
}

const lwTools = `"tools":[{"id":"p1","pid":10,"fgName":"vim"}],"toolsKnown":true,` +
	`"workspace":{"activeWindow":"w1","windows":[{"id":"w1","name":"Main","focusedPane":"r1",` +
	`"layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"Shell","type":"terminal","toolId":"p1"}]}}]}`

func TestListWorkspace_OneTripWhenStateCarriesSetting(t *testing.T) {
	paths, out := listWorkspaceAgainst(t, `{`+lwTools+`,"fgTabNames":false}`)
	if len(paths) != 1 || paths[0] != "/api/state" {
		t.Fatalf("요청 = %v, want [/api/state]", paths)
	}
	if !strings.Contains(out, `tab="Shell"`) {
		t.Fatalf("설정(꺼짐)이 반영되지 않았다: %s", out)
	}
}

func TestListWorkspace_OldServerFallsBackToSettings(t *testing.T) {
	paths, out := listWorkspaceAgainst(t, `{`+lwTools+`}`)
	if len(paths) != 2 || paths[1] != "/api/settings" {
		t.Fatalf("요청 = %v — 옛 서버에는 설정을 물어야 한다", paths)
	}
	if !strings.Contains(out, `tab="Shell"`) {
		t.Fatalf("설정(꺼짐)이 반영되지 않았다: %s", out)
	}
}
