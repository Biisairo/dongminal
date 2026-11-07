package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
)

// ISSUE_AGENT_TREE_SRS 묶음 U·D — 트리 중복 방지(TC-ITU-1 HTTP 쪽)와 트리 조회(TC-ITD-1·2).

func TestRunStart_TreeOpenCarriesStale(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	code, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	if code != http.StatusOK {
		t.Fatalf("root code=%d %v", code, root)
	}
	// 멤버가 없는 열린 트리는 멈춘 트리다.
	code, out := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	if code != http.StatusConflict || out["error"] != "tree_open" || out["runId"] != root["id"] || out["stale"] != true {
		t.Fatalf("code=%d out=%v", code, out)
	}
	// 살아 있는 멤버가 있으면 멈추지 않았다.
	if code, out := postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#32","agent":"claude","assign":{"issue":"o/r#32"},"id":"tab-a"}`); code != http.StatusOK {
		t.Fatalf("member code=%d %v", code, out)
	}
	_, out = postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	if out["stale"] != false {
		t.Fatalf("stale=%v", out["stale"])
	}
}

func TestRunStart_BranchAndNodeTaken(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	if code, out := postRun(t, s, "/api/runs", `{"objective":"b","projection":"dedicated-window","tree":"o/r#32","treeBranch":true}`); code != http.StatusConflict || out["error"] != "tree_not_open" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	_, br := postRun(t, s, "/api/runs", `{"objective":"b","projection":"dedicated-window","tree":"o/r#32","treeBranch":true}`)
	postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#32›33","agent":"claude","assign":{"issue":"o/r#33"},"id":"tab-a"}`)
	code, out := postRun(t, s, "/api/runs/members", `{"runId":"`+br["id"].(string)+`","role":"ccr#32›33","agent":"claude","assign":{"issue":"o/r#33"},"id":"tab-b"}`)
	if code != http.StatusConflict || out["error"] != "node_taken" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

func TestRunsTree_NodesAndParents(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`)
	_, br := postRun(t, s, "/api/runs", `{"objective":"b","projection":"dedicated-window","tree":"o/r#32","treeBranch":true}`)
	postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#32","agent":"claude","assign":{"issue":"o/r#32"},"id":"tab-a"}`)
	// 중간 노드(ccr#32›33)는 없다 — 끝났거나 migration 중. 가장 가까운 조상에 붙는다.
	postRun(t, s, "/api/runs/members", `{"runId":"`+br["id"].(string)+`","role":"ccr#32›33›35","agent":"claude","assign":{"issue":"o/r#35"},"id":"tab-b"}`)
	postRun(t, s, "/api/runs", `{"objective":"other","projection":"dedicated-window","tree":"o/r#99"}`)

	code, out := getRun(t, s, "/api/runs/tree?ref=o/r%2332")
	if code != http.StatusOK {
		t.Fatalf("code=%d out=%v", code, out)
	}
	runs, _ := out["runs"].([]any)
	if len(runs) != 2 {
		t.Fatalf("같은 트리의 열린 Run 만: %v", out["runs"])
	}
	nodes, _ := out["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("nodes=%v", out["nodes"])
	}
	by := map[string]map[string]any{}
	for _, n := range nodes {
		m := n.(map[string]any)
		by[m["role"].(string)] = m
	}
	if by["ccr#32"]["parent"] != "" || by["ccr#32"]["leaf"] != false {
		t.Errorf("root=%v", by["ccr#32"])
	}
	leaf := by["ccr#32›33›35"]
	if leaf["parent"] != "ccr#32" || leaf["leaf"] != true || leaf["toolId"] != "tool-b" || leaf["state"] == nil || leaf["runId"] != br["id"] {
		t.Errorf("leaf=%v", leaf)
	}
	if code, _ := getRun(t, s, "/api/runs/tree"); code != http.StatusBadRequest {
		t.Errorf("ref 없는 조회 code=%d", code)
	}
}

// NFR-RVZ-3: 트리 노드에 brief 같은 본문이 실리지 않는다.
func TestRunsTree_NoBrief(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#5"}`)
	postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"x#5","agent":"claude","id":"tab-a","brief":"비밀-본문"}`)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, apiTestRequest(http.MethodGet, "/api/runs/tree?ref=o/r%235", nil))
	if strings.Contains(rec.Body.String(), "비밀-본문") || strings.Contains(rec.Body.String(), "brief") {
		t.Fatalf("brief 가 샜다: %s", rec.Body.String())
	}
	_, g := getRun(t, s, "/api/runs/"+root["id"].(string)+"/graph")
	if g["tree"] != "o/r#5" {
		t.Fatalf("graph 에 tree 가 없다: %v", g["tree"])
	}
}

// TC-ITD-4 (FR-ITD-7): 트리 Run 의 run_changed 는 tree 를 싣고, 트리 아닌 Run 은 싣지 않는다.
func TestRunChanged_CarriesTree(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       any
	}{
		{"tree", `{"objective":"t","projection":"dedicated-window","tree":"o/r#32"}`, "o/r#32"},
		{"plain", `{"objective":"t","projection":"dedicated-window"}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _, _ := runsServer(t, "tool-a")
			fb := &fakeCommandBroker{}
			s.Commands = fb
			code, out := postRun(t, s, "/api/runs", tc.body)
			if code != http.StatusOK {
				t.Fatalf("run start %d (%+v)", code, out)
			}
			runID, _ := out["id"].(string)
			assign := ""
			if strings.Contains(tc.body, `"tree"`) {
				assign = `,"assign":{"issue":"o/r#32"}`
			}
			if code, out := postRun(t, s, "/api/runs/members",
				`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tool-b"`+assign+`}`); code != http.StatusOK {
				t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
			}
			if code, out := postRun(t, s, "/api/tools/message",
				`{"to":"tool-b","from":"tool-a","message":"x"}`); code != http.StatusOK {
				t.Fatalf("msg 실패 %d (%+v)", code, out)
			}
			sent := publishedActions(fb, "run_changed")
			if len(sent) == 0 {
				t.Fatal("run_changed 가 나가지 않았다")
			}
			args, _ := sent[len(sent)-1]["args"].(map[string]any)
			if args["runId"] != runID || args["tree"] != tc.want {
				t.Fatalf("payload=%+v, tree 는 %v 여야 한다", args, tc.want)
			}
		})
	}
}
