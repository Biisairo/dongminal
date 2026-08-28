package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// CONVENIENCE_SRS FR-TAN-22: `rename-tab --at <uuid> --auto` 는 탭 이름을
// 자동(전경 프로세스 파생)으로 되돌린다. 이름이 아니라 **출처**를 되돌리는
// 명령이므로 이름 없이 보낸다.
func TestRunDmctlRenameTabAuto(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440007"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	if rc := runDmctl([]string{"rename-tab", "--at", uuid, "--auto"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "renameTab" {
		t.Fatalf("action=%v want renameTab", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["location"] != uuid || args["auto"] != true {
		t.Fatalf("args=%v want location+auto", args)
	}
	// 이름을 실어 보내면 브라우저가 무엇을 원한 것인지 알 수 없다.
	if _, ok := args["name"]; ok {
		t.Fatalf("args 에 name 이 실렸다: %v", args)
	}
}

// --auto 의 거부 경로. 추측하지 않고 usage 로 돌려보낸다.
func TestRunDmctlRenameTabAutoRejects(t *testing.T) {
	for _, args := range [][]string{
		{"rename-tab", "--auto"},                    // --at 누락
		{"rename-tab", "--at", "u1", "--auto", "x"}, // 이름과 동시 사용
		{"rename-window", "--at", "u1", "--auto"},   // 창 이름에는 출처가 없다
	} {
		var stdout, stderr bytes.Buffer
		if rc := runDmctl(args, &stdout, &stderr); rc != 2 {
			t.Errorf("args=%v rc=%d want 2 (stderr=%s)", args, rc, stderr.String())
		}
		if stderr.Len() == 0 {
			t.Errorf("args=%v stderr 가 비었다", args)
		}
	}
}

// FR-TAN-18: `dmctl list-workspace` 의 tab= 컬럼은 **화면에 보이는 이름**이다.
// 규칙이 helpers.js 의 tabName·tabNameSource 와 어긋나면 에이전트가 사용자와
// 다른 것을 보게 된다.
func TestTabDisplayName(t *testing.T) {
	fg := map[string]string{"p1": "vim", "p2": "claude"}
	cases := []struct {
		what    string
		tab     wsTab
		enabled bool
		want    string
	}{
		{"auto 는 파생을 받는다 (V-TAN-1)",
			wsTab{Name: "Shell", Type: "terminal", ToolID: "p1"}, true, "vim"},
		{"전경 프로그램이 없으면 기본 이름 (V-TAN-3/FR-TAN-12)",
			wsTab{Name: "Shell", Type: "terminal", ToolID: "none"}, true, "Shell"},
		{"manual 은 덮이지 않는다 (V-TAN-4/FR-TAN-15)",
			wsTab{Name: "비평가", Type: "terminal", ToolID: "p1", NameSource: "manual"}, true, "비평가"},
		{"설정을 끄면 파생하지 않는다 (V-TAN-12/FR-TAN-20)",
			wsTab{Name: "Shell", Type: "terminal", ToolID: "p1"}, false, "Shell"},
		{"구 워크스페이스: 기본 이름이면 auto (V-TAN-7)",
			wsTab{Name: "Shell", Type: "terminal", ToolID: "p2"}, true, "claude"},
		{"구 워크스페이스: 준 이름이면 manual (V-TAN-8)",
			wsTab{Name: "내작업", Type: "terminal", ToolID: "p1"}, true, "내작업"},
		{"editor 는 대상이 아니다 (FR-TAN-3)",
			wsTab{Name: "main.go", Type: "editor", ToolID: "p1"}, true, "main.go"},
		{"run 은 대상이 아니다 (FR-TAN-3)",
			wsTab{Name: "Run 1234abcd", Type: "run", ToolID: "p1"}, true, "Run 1234abcd"},
		{"명시적 auto 는 이름이 기본값이 아니어도 파생을 받는다",
			wsTab{Name: "내작업", Type: "terminal", ToolID: "p1", NameSource: "auto"}, true, "vim"},
	}
	for _, c := range cases {
		if got := tabDisplayName(c.tab, fg, func() bool { return c.enabled }); got != c.want {
			t.Errorf("%s: tabDisplayName=%q want %q", c.what, got, c.want)
		}
	}
}

// FR-TAN-18 의 배선. 목록 한 행이 실제로 파생 이름을 싣고 나가는지 본다 —
// tabDisplayName 이 맞아도 buildListWorkspaceRows 가 tab.Name 을 그대로 쓰면
// 화면과 어긋난다.
func TestBuildListWorkspaceRowsUsesDisplayName(t *testing.T) {
	ws := &wsTree{
		ActiveWindow: "w1",
		Windows: []wsWindow{{
			ID: "w1", Name: "Main", FocusedPane: "r1",
			Layout: &wsLayout{Type: "pane", ID: "r1", ActiveTab: "t1", Tabs: []wsTab{
				{ID: "t1", Name: "Shell", Type: "terminal", ToolID: "p1"},
				{ID: "t2", Name: "비평가", Type: "terminal", ToolID: "p2", NameSource: "manual"},
			}},
		}},
	}
	fg := map[string]string{"p1": "vim", "p2": "claude"}
	rows := buildListWorkspaceRows(ws, map[string]int{}, map[string][2]int{}, fg, func() bool { return true })
	if len(rows) != 2 {
		t.Fatalf("rows=%d want 2", len(rows))
	}
	if rows[0].Tab != "vim" {
		t.Errorf("auto 탭 tab=%q want vim", rows[0].Tab)
	}
	if rows[1].Tab != "비평가" {
		t.Errorf("manual 탭 tab=%q want 비평가", rows[1].Tab)
	}
}

// 설정 조회는 **결과를 바꿀 수 있을 때만** 나간다. 파생 이름이 쓰일 자리가
// 없으면 /api/settings 를 치지 않는다 — list-workspace 는 에이전트가 자주
// 부르는 명령이고, 아무것도 바꾸지 못할 요청을 매번 얹으면 안 된다.
func TestTabDisplayNameSkipsSettingsWhenNoDerivedName(t *testing.T) {
	asked := 0
	enabled := onceBool(func() bool { asked++; return true })

	// 파생 이름이 없는 도구 / manual 탭 — 둘 다 설정을 물을 이유가 없다.
	tabDisplayName(wsTab{Name: "Shell", Type: "terminal", ToolID: "없음"}, map[string]string{}, enabled)
	tabDisplayName(wsTab{Name: "비평가", Type: "terminal", ToolID: "p1", NameSource: "manual"},
		map[string]string{"p1": "vim"}, enabled)
	if asked != 0 {
		t.Fatalf("설정을 %d회 물었다 — 0이어야 한다", asked)
	}

	// 실제로 파생 이름이 쓰일 때만 묻고, 그 뒤로는 캐시된다.
	tabDisplayName(wsTab{Name: "Shell", Type: "terminal", ToolID: "p1"}, map[string]string{"p1": "vim"}, enabled)
	tabDisplayName(wsTab{Name: "Shell", Type: "terminal", ToolID: "p1"}, map[string]string{"p1": "vim"}, enabled)
	if asked != 1 {
		t.Fatalf("설정을 %d회 물었다 — 1이어야 한다", asked)
	}
}
