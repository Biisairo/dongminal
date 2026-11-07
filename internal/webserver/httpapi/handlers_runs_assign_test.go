package httpapi

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// ISSUE_TREE_OPS_SRS 묶음 A — 서버가 트리 멤버에게 트리 프리앰블을 준다 (TC-ITA-1·2 HTTP 쪽).

func TestRunMember_TreePreambleResolvesParentAndGroup(t *testing.T) {
	home := t.TempDir()
	t.Setenv(dmenv.EnvHome, home)
	s, _, _, _ := runsServer(t, "tool-a")
	ws := newFakeWorkspaceStore()
	ws.raw = []byte(`{"windowGroups":[{"id":"grp-x","name":"x","tree":{"repo":"o/r","root":99}},{"id":"grp-1","name":"ccr","tree":{"repo":"o/r","root":32}}]}`)
	s.Work = ws
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	runID := root["id"].(string)
	code, p := postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"ccr#32","agent":"claude","id":"tab-a","assign":{"issue":"o/r#32","title":"루트"}}`)
	if code != http.StatusOK {
		t.Fatalf("root member %d %v", code, p)
	}
	parent := p["id"].(string)
	code, c := postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"ccr#32›33","agent":"claude","id":"tab-b","assign":{"issue":"o/r#33","parent":"`+parent+`"}}`)
	if code != http.StatusOK {
		t.Fatalf("child member %d %v", code, c)
	}
	pre, _ := c["preamble"].(string)
	doc := filepath.Join(home, dmenv.BinDir, "agent-plugin", "commands", "issue-tree.md")
	for _, want := range []string{"[ISSUE-TREE 배정]", "부모: tool-a", "그룹: grp-1", "맥락 기준: 50%", doc} {
		if !strings.Contains(pre, want) {
			t.Errorf("%q 가 없다:\n%s", want, pre)
		}
	}
	rootPre, _ := p["preamble"].(string)
	if !strings.Contains(rootPre, "부모: 없음") {
		t.Errorf("루트 프리앰블:\n%s", rootPre)
	}
	// 같은 값이 재조회로도 나온다 (FR-PRE-1).
	_, again := getRun(t, s, "/api/runs/preamble?member="+c["id"].(string))
	if again["preamble"] != pre {
		t.Errorf("재조회 프리앰블이 다르다")
	}
}

func TestRunMember_PlainPreambleUnchanged(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	_, rec := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window"}`)
	_, m := postRun(t, s, "/api/runs/members", `{"runId":"`+rec["id"].(string)+`","role":"작가","agent":"claude","id":"tab-a"}`)
	pre, _ := m["preamble"].(string)
	if strings.Contains(pre, "[ISSUE-TREE 배정]") || !strings.Contains(pre, "조정자") {
		t.Errorf("일반 멤버가 트리 프리앰블을 받았다:\n%s", pre)
	}
}

func TestRunAssign_Update(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	_, p := postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#32","agent":"claude","id":"tab-a","assign":{"issue":"o/r#32"}}`)
	id := p["id"].(string)
	who.toolID = "tool-a"
	code, out := postRun(t, s, "/api/runs/assign", `{"memberId":"`+id+`","ctxPct":40,"goal":"35"}`)
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	a := out["member"].(map[string]any)["assign"].(map[string]any)
	if a["ctxPct"] != float64(40) || a["goal"] != "35" {
		t.Fatalf("assign=%v", a)
	}
	who.toolID = "stranger"
	if code, out := postRun(t, s, "/api/runs/assign", `{"memberId":"`+id+`","ctxPct":40}`); code == http.StatusOK {
		t.Fatalf("남이 고쳤다 %v", out)
	}
}

// ISSUE_TREE_CLOSE_SRS TC-ITX-1 (FR-ITX-2): 루트의 부모는 살아 있는 조율이다. 조율이
// 죽으면 「부모: 없음」 으로 돌아간다.
func TestRunMember_RootParentIsLiveCoordinator(t *testing.T) {
	t.Setenv(dmenv.EnvHome, t.TempDir())
	s, _, _, _ := runsServer(t, "tool-a")
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	code, p := postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#32","agent":"claude","id":"tab-b","assign":{"issue":"o/r#32","title":"루트"}}`)
	if code != http.StatusOK {
		t.Fatalf("root member %d %v", code, p)
	}
	if pre, _ := p["preamble"].(string); !strings.Contains(pre, "부모: tool-a — 조율 에이전트") {
		t.Errorf("루트의 부모가 조율이 아니다:\n%s", pre)
	}
	s.ToolIO.(*fakeToolIO).setHas("tool-a", false)
	_, again := getRun(t, s, "/api/runs/preamble?member="+p["id"].(string))
	if pre, _ := again["preamble"].(string); !strings.Contains(pre, "부모: 없음") {
		t.Errorf("죽은 조율을 부모로 준다:\n%s", pre)
	}
}
