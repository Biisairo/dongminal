package migrate

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

// ── helpers ─────────────────────────────────────────────────────────────

func mustJSON(t *testing.T, b []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("결과 JSON 파싱 실패: %v\n%s", err, b)
	}
	return m
}

func mustJSONArr(t *testing.T, b []byte) []interface{} {
	t.Helper()
	var a []interface{}
	if err := json.Unmarshal(b, &a); err != nil {
		t.Fatalf("결과 JSON 배열 파싱 실패: %v\n%s", err, b)
	}
	return a
}

func toolIDs(t *testing.T, b []byte) []string {
	t.Helper()
	out := []string{}
	for _, it := range mustJSONArr(t, b) {
		m, ok := it.(map[string]interface{})
		if !ok {
			t.Fatalf("tools 항목이 객체가 아님: %#v", it)
		}
		id, _ := m["id"].(string)
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// v1Basic: region 1개 + terminal 탭 2개.
const v1Basic = `{
  "agentsOrder": ["100"],
  "sessions": [
    {"id":"s1","name":"work","layout":{
      "type":"region","id":"r1","activeTab":"t1",
      "tabs":[
        {"id":"t1","name":"Shell","type":"terminal","paneId":"100"},
        {"id":"t2","name":"Shell","type":"terminal","paneId":"101"}
      ]}}
  ]
}`

// v1Split: 중첩 split — sizes/direction 등 미지 필드 보존 확인용.
const v1Split = `{
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
}`

const panesBasic = `[
  {"id":"100","name":"Shell #100","cwd":"/a"},
  {"id":"101","name":"Shell #101","cwd":"/b"},
  {"id":"999","name":"Shell #999","cwd":"/orphan"}
]`

// ── FR-EM-2: 스키마 개명 ────────────────────────────────────────────────

func TestWorkspace_RenamesTopLevelKey(t *testing.T) {
	res, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	if _, ok := ws["sessions"]; ok {
		t.Error("구 키 sessions 가 남아 있음")
	}
	wins, ok := ws["windows"].([]interface{})
	if !ok {
		t.Fatalf("windows 배열 없음: %#v", ws)
	}
	if len(wins) != 1 {
		t.Fatalf("windows 길이 = %d, want 1", len(wins))
	}
}

func TestWorkspace_AddsSchemaVersion2(t *testing.T) {
	res, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	v, ok := ws["schemaVersion"].(float64)
	if !ok || int(v) != 2 {
		t.Errorf("schemaVersion = %#v, want 2", ws["schemaVersion"])
	}
}

func TestWorkspace_RegionBecomesPane(t *testing.T) {
	res, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	layout := win["layout"].(map[string]interface{})
	if got := layout["type"]; got != "pane" {
		t.Errorf("layout.type = %v, want pane", got)
	}
}

func TestWorkspace_PaneIDBecomesToolID(t *testing.T) {
	res, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	tabs := win["layout"].(map[string]interface{})["tabs"].([]interface{})
	for i, raw := range tabs {
		tab := raw.(map[string]interface{})
		if _, ok := tab["paneId"]; ok {
			t.Errorf("tabs[%d]: 구 키 paneId 남아 있음", i)
		}
		if _, ok := tab["toolId"].(string); !ok {
			t.Errorf("tabs[%d]: toolId 없음 — %#v", i, tab)
		}
	}
}

func TestWorkspace_NestedSplitConvertedRecursively(t *testing.T) {
	res, err := Run([]byte(v1Split), []byte(`[{"id":"200","name":"a","cwd":"/"},{"id":"201","name":"b","cwd":"/"}]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})

	var types []string
	var walk func(n map[string]interface{})
	walk = func(n map[string]interface{}) {
		types = append(types, n["type"].(string))
		if ch, ok := n["children"].([]interface{}); ok {
			for _, c := range ch {
				walk(c.(map[string]interface{}))
			}
		}
	}
	walk(win["layout"].(map[string]interface{}))
	want := []string{"split", "pane", "split", "pane", "pane"}
	if !reflect.DeepEqual(types, want) {
		t.Errorf("type 순회 = %v, want %v", types, want)
	}
}

func TestWorkspace_PreservesUnknownFields(t *testing.T) {
	res, err := Run([]byte(v1Split), []byte(`[{"id":"200","name":"a","cwd":"/"},{"id":"201","name":"b","cwd":"/"}]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	root := win["layout"].(map[string]interface{})
	if root["direction"] != "vertical" {
		t.Errorf("direction 소실: %#v", root["direction"])
	}
	sizes, ok := root["sizes"].([]interface{})
	if !ok || len(sizes) != 2 {
		t.Errorf("sizes 소실: %#v", root["sizes"])
	}
}

func TestWorkspace_EditorTabHasNoToolID(t *testing.T) {
	res, err := Run([]byte(v1Split), []byte(`[{"id":"200","name":"a","cwd":"/"},{"id":"201","name":"b","cwd":"/"}]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	inner := win["layout"].(map[string]interface{})["children"].([]interface{})[1].(map[string]interface{})
	editorPane := inner["children"].([]interface{})[1].(map[string]interface{})
	tab := editorPane["tabs"].([]interface{})[0].(map[string]interface{})
	if _, ok := tab["toolId"]; ok {
		t.Errorf("editor 탭에 toolId 가 생성됨: %#v", tab)
	}
	if tab["filePath"] != "/tmp/a.md" {
		t.Errorf("filePath 소실: %#v", tab["filePath"])
	}
}

// ── 고아·유령 참조 정리 ─────────────────────────────────────────────────

func TestTools_DropsOrphans(t *testing.T) {
	res, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got, want := toolIDs(t, res.Tools), []string{"100", "101"}; !reflect.DeepEqual(got, want) {
		t.Errorf("tools = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(res.Report.Orphans, []string{"999"}) {
		t.Errorf("Report.Orphans = %v, want [999]", res.Report.Orphans)
	}
}

func TestReport_CountsAndBrokenRefs(t *testing.T) {
	// 101 을 panes 에서 제거 → workspace 가 참조하나 도구 없음.
	res, err := Run([]byte(v1Basic), []byte(`[{"id":"100","name":"a","cwd":"/"}]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Report.Windows != 1 {
		t.Errorf("Report.Windows = %d, want 1", res.Report.Windows)
	}
	if res.Report.Tools != 1 {
		t.Errorf("Report.Tools = %d, want 1", res.Report.Tools)
	}
	if !reflect.DeepEqual(res.Report.BrokenRefs, []string{"101"}) {
		t.Errorf("Report.BrokenRefs = %v, want [101]", res.Report.BrokenRefs)
	}
}

func TestAgentsOrder_GhostRefsRemoved(t *testing.T) {
	in := `{"agentsOrder":["100","350"],"sessions":[
      {"id":"s1","name":"w","layout":{"type":"region","id":"r1","activeTab":"t1",
        "tabs":[{"id":"t1","name":"Shell","type":"terminal","paneId":"100"}]}}]}`
	res, err := Run([]byte(in), []byte(`[{"id":"100","name":"a","cwd":"/"}]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	order, ok := ws["agentsOrder"].([]interface{})
	if !ok {
		t.Fatalf("agentsOrder 소실: %#v", ws)
	}
	if len(order) != 1 || order[0] != "100" {
		t.Errorf("agentsOrder = %#v, want [100]", order)
	}
	if !reflect.DeepEqual(res.Report.GhostRefs, []string{"350"}) {
		t.Errorf("Report.GhostRefs = %v, want [350]", res.Report.GhostRefs)
	}
}

// ── 멱등성·경계 ─────────────────────────────────────────────────────────

func TestRun_IsIdempotent(t *testing.T) {
	first, err := Run([]byte(v1Basic), []byte(panesBasic))
	if err != nil {
		t.Fatalf("1차 Run: %v", err)
	}
	second, err := Run(first.Workspace, first.Tools)
	if err != nil {
		t.Fatalf("2차 Run: %v", err)
	}
	if !reflect.DeepEqual(mustJSON(t, first.Workspace), mustJSON(t, second.Workspace)) {
		t.Errorf("workspace 재실행 결과 불일치\n1차: %s\n2차: %s", first.Workspace, second.Workspace)
	}
	if !second.Report.AlreadyMigrated {
		t.Error("2차 Run 이 AlreadyMigrated 를 보고하지 않음")
	}
}

func TestRun_EmptyInputIsNoop(t *testing.T) {
	res, err := Run(nil, nil)
	if err != nil {
		t.Fatalf("Run(nil,nil): %v", err)
	}
	if res.Workspace != nil || res.Tools != nil {
		t.Errorf("빈 입력에 산출물이 생성됨: ws=%s tools=%s", res.Workspace, res.Tools)
	}
	if !res.Report.Empty {
		t.Error("Report.Empty 가 false")
	}
}

func TestRun_InvalidWorkspaceJSONErrors(t *testing.T) {
	if _, err := Run([]byte(`{"sessions":`), []byte(panesBasic)); err == nil {
		t.Error("깨진 workspace JSON 에 오류가 없음")
	}
}

func TestRun_InvalidPanesJSONErrors(t *testing.T) {
	if _, err := Run([]byte(v1Basic), []byte(`[{`)); err == nil {
		t.Error("깨진 panes JSON 에 오류가 없음")
	}
}

func TestRun_UnknownLayoutTypePreserved(t *testing.T) {
	in := `{"sessions":[{"id":"s1","name":"w","layout":{"type":"future","id":"x1"}}]}`
	res, err := Run([]byte(in), []byte(`[]`))
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ws := mustJSON(t, res.Workspace)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	if got := win["layout"].(map[string]interface{})["type"]; got != "future" {
		t.Errorf("미지 type 이 변형됨: %v", got)
	}
}
