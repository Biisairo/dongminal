package migrate

import (
	"encoding/json"
	"fmt"
	"testing"
)

// seqGen은 결정적 uuid 형태 생성기다 (TC-MGU-8). canonical 8-4-4-4-12 를 지켜야
// 멱등 검사(FR-MGU-3)가 산출물을 "이미 uuid" 로 인식한다.
func seqGen() func() string {
	n := 0
	return func() string {
		n++
		return fmt.Sprintf("%08d-0000-7000-8000-%012d", n, n)
	}
}

// legacyWS: 구 id 만 든 v2 워크스페이스. 참조 4종(activeWindow/activeTab/
// focusedPane/agentsOrder)과 중첩 split 을 모두 담는다.
const legacyWS = `{
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
}`

const legacyTools = `[{"id":"267","name":"Shell","cwd":"/x"}]`

func parseWS(t *testing.T, blob []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(blob, &m); err != nil {
		t.Fatalf("workspace 파싱: %v", err)
	}
	return m
}

// walkIDs는 산출물의 모든 id 계열 값을 수집한다.
func walkIDs(ws map[string]interface{}) []string {
	var out []string
	var walkNode func(n map[string]interface{})
	walkNode = func(n map[string]interface{}) {
		if id, ok := n["id"].(string); ok {
			out = append(out, id)
		}
		if tabs, ok := n["tabs"].([]interface{}); ok {
			for _, raw := range tabs {
				if tab, ok := raw.(map[string]interface{}); ok {
					if id, ok := tab["id"].(string); ok {
						out = append(out, id)
					}
					if id, ok := tab["toolId"].(string); ok {
						out = append(out, id)
					}
				}
			}
		}
		if ch, ok := n["children"].([]interface{}); ok {
			for _, raw := range ch {
				if c, ok := raw.(map[string]interface{}); ok {
					walkNode(c)
				}
			}
		}
	}
	for _, raw := range ws["windows"].([]interface{}) {
		win := raw.(map[string]interface{})
		if id, ok := win["id"].(string); ok {
			out = append(out, id)
		}
		if l, ok := win["layout"].(map[string]interface{}); ok {
			walkNode(l)
		}
	}
	return out
}

// TC-MGU-1: 구 id 전량 재작성 + 참조 무결성 (FR-MGU-1/5/7)
func TestRewrite_AllLegacyIDsAndRefs(t *testing.T) {
	wsOut, toolsOut, rep, err := RewriteIdentifiers([]byte(legacyWS), []byte(legacyTools), seqGen())
	if err != nil {
		t.Fatalf("RewriteIdentifiers: %v", err)
	}
	if rep.Windows != 1 || rep.Panes != 2 || rep.Tabs != 2 || rep.Tools != 1 {
		t.Errorf("report = %+v, want Windows=1 Panes=2 Tabs=2 Tools=1", rep)
	}

	ws := parseWS(t, wsOut)
	for _, id := range walkIDs(ws) {
		if !isUUIDForm(id) {
			t.Errorf("구 형식 id 잔존: %q", id)
		}
	}

	// 참조가 새 id 를 정확히 가리키는가.
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	if ws["activeWindow"] != win["id"] {
		t.Errorf("activeWindow=%v, window.id=%v", ws["activeWindow"], win["id"])
	}
	layout := win["layout"].(map[string]interface{})
	first := layout["children"].([]interface{})[0].(map[string]interface{})
	if win["focusedPane"] != first["id"] {
		t.Errorf("focusedPane=%v, pane.id=%v", win["focusedPane"], first["id"])
	}
	tab := first["tabs"].([]interface{})[0].(map[string]interface{})
	if first["activeTab"] != tab["id"] {
		t.Errorf("activeTab=%v, tab.id=%v", first["activeTab"], tab["id"])
	}

	// toolId 는 tools.json 의 id 와 같은 매핑을 공유한다 (FR-MGU-5).
	var tools []map[string]interface{}
	if err := json.Unmarshal(toolsOut, &tools); err != nil {
		t.Fatalf("tools 파싱: %v", err)
	}
	if tab["toolId"] != tools[0]["id"] {
		t.Errorf("tab.toolId=%v, tools[0].id=%v", tab["toolId"], tools[0]["id"])
	}
	order := ws["agentsOrder"].([]interface{})
	if order[0] != tools[0]["id"] {
		t.Errorf("agentsOrder[0]=%v, tools[0].id=%v", order[0], tools[0]["id"])
	}
}

// TC-MGU-2: 멱등 (FR-MGU-3)
func TestRewrite_Idempotent(t *testing.T) {
	ws1, tools1, _, err := RewriteIdentifiers([]byte(legacyWS), []byte(legacyTools), seqGen())
	if err != nil {
		t.Fatalf("1회차: %v", err)
	}
	ws2, tools2, rep, err := RewriteIdentifiers(ws1, tools1, seqGen())
	if err != nil {
		t.Fatalf("2회차: %v", err)
	}
	if rep.Total() != 0 {
		t.Errorf("2회차 재작성 %d건, want 0 (%+v)", rep.Total(), rep)
	}
	if string(ws1) != string(ws2) || string(tools1) != string(tools2) {
		t.Error("2회차가 산출물을 변경했다")
	}
}

// TC-MGU-3: uuid 와 구 id 혼재 (FR-MGU-3)
func TestRewrite_PreservesExistingUUIDs(t *testing.T) {
	const mixed = `{
	  "schemaVersion": 2,
	  "windows": [
	    {"id":"2d019674-7f90-4c5b-8be7-56f5b7f250a1","name":"chart","layout":{
	      "type":"pane","id":"r168","activeTab":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","tabs":[
	        {"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","name":"Shell","type":"terminal",
	         "toolId":"01a03610-2748-7000-ab60-aa7d580d9673"}]}}
	  ]
	}`
	const tools = `[{"id":"01a03610-2748-7000-ab60-aa7d580d9673","name":"Shell","cwd":"/x"}]`

	wsOut, _, rep, err := RewriteIdentifiers([]byte(mixed), []byte(tools), seqGen())
	if err != nil {
		t.Fatalf("RewriteIdentifiers: %v", err)
	}
	// 구 형식은 pane id `r168` 하나뿐이다.
	if rep.Panes != 1 || rep.Windows != 0 || rep.Tabs != 0 || rep.Tools != 0 {
		t.Errorf("report = %+v, want Panes=1 나머지 0", rep)
	}
	ws := parseWS(t, wsOut)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	if win["id"] != "2d019674-7f90-4c5b-8be7-56f5b7f250a1" {
		t.Errorf("기존 uuid 가 재발급됐다: %v", win["id"])
	}
	layout := win["layout"].(map[string]interface{})
	if layout["id"] == "r168" {
		t.Error("구 pane id 가 재작성되지 않았다")
	}
}

// TC-MGU-4: 끊어진 참조는 보존하고 보고한다 (FR-MGU-6)
func TestRewrite_DanglingRefsPreserved(t *testing.T) {
	const dangling = `{
	  "schemaVersion": 2,
	  "activeWindow": "s99",
	  "windows": [
	    {"id":"s45","name":"w","focusedPane":"r777","layout":{
	      "type":"pane","id":"r146","activeTab":"t888","tabs":[
	        {"id":"t201","name":"Shell","type":"terminal","toolId":"404"}]}}
	  ]
	}`
	wsOut, _, rep, err := RewriteIdentifiers([]byte(dangling), []byte(`[]`), seqGen())
	if err != nil {
		t.Fatalf("RewriteIdentifiers: %v", err)
	}
	ws := parseWS(t, wsOut)
	win := ws["windows"].([]interface{})[0].(map[string]interface{})
	if ws["activeWindow"] != "s99" {
		t.Errorf("끊어진 activeWindow 가 변경됐다: %v", ws["activeWindow"])
	}
	if win["focusedPane"] != "r777" {
		t.Errorf("끊어진 focusedPane 이 변경됐다: %v", win["focusedPane"])
	}
	layout := win["layout"].(map[string]interface{})
	if layout["activeTab"] != "t888" {
		t.Errorf("끊어진 activeTab 이 변경됐다: %v", layout["activeTab"])
	}
	tab := layout["tabs"].([]interface{})[0].(map[string]interface{})
	if tab["toolId"] != "404" {
		t.Errorf("끊어진 toolId 가 변경됐다: %v", tab["toolId"])
	}
	want := map[string]bool{"s99": true, "r777": true, "t888": true, "404": true}
	if len(rep.Dangling) != len(want) {
		t.Errorf("Dangling = %v, want %d건", rep.Dangling, len(want))
	}
	for _, d := range rep.Dangling {
		if !want[d] {
			t.Errorf("예상 밖 Dangling 항목: %q", d)
		}
	}
}

// TC-MGU-9: schemaVersion 은 올라가지 않는다 (FR-MGU-9)
func TestRewrite_KeepsSchemaVersion(t *testing.T) {
	wsOut, _, _, err := RewriteIdentifiers([]byte(legacyWS), []byte(legacyTools), seqGen())
	if err != nil {
		t.Fatalf("RewriteIdentifiers: %v", err)
	}
	ws := parseWS(t, wsOut)
	if v, _ := ws["schemaVersion"].(float64); int(v) != SchemaVersion {
		t.Errorf("schemaVersion = %#v, want %d", ws["schemaVersion"], SchemaVersion)
	}
}

// 빈 입력은 통과시킨다 — 신규 사용자 경로.
func TestRewrite_EmptyInput(t *testing.T) {
	ws, tools, rep, err := RewriteIdentifiers(nil, nil, seqGen())
	if err != nil {
		t.Fatalf("RewriteIdentifiers: %v", err)
	}
	if ws != nil || tools != nil || rep.Total() != 0 {
		t.Errorf("빈 입력에서 산출 발생: ws=%v tools=%v rep=%+v", ws, tools, rep)
	}
}

// ── Apply 통합 (파일 IO 경로) ────────────────────────────────

// TC-MGU-5: 이미 `.v1.bak` 이 있는 v2 홈에서도 재작성 직전 상태가 남는다 (FR-MGU-8)
func TestApply_PreUUIDBackupOnAlreadyV2Home(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", legacyWS)
	seed(t, dir, "tools.json", legacyTools)
	// 1차 v1→v2 마이그레이션이 이미 끝난 홈을 흉내낸다.
	seed(t, dir, "workspace.json.v1.bak", `{"stale":"v1 원본"}`)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if rep.Identity.Total() == 0 {
		t.Fatalf("재작성이 일어나지 않았다: %+v", rep.Identity)
	}
	if !exists(dir, "workspace.json.preuuid.bak") {
		t.Fatal("workspace.json.preuuid.bak 미생성")
	}
	if !exists(dir, "tools.json.preuuid.bak") {
		t.Fatal("tools.json.preuuid.bak 미생성")
	}
	// .preuuid.bak 은 재작성 **직전** 내용이어야 한다.
	if got := read(t, dir, "workspace.json.preuuid.bak"); got != legacyWS {
		t.Errorf("preuuid 백업이 직전 내용이 아니다:\n%s", got)
	}
	// 기존 .v1.bak 은 건드리지 않는다.
	if got := read(t, dir, "workspace.json.v1.bak"); got != `{"stale":"v1 원본"}` {
		t.Errorf(".v1.bak 이 덮어써졌다: %s", got)
	}
	// 산출물에 구 형식 id 가 없다.
	for _, id := range walkIDs(parseWS(t, []byte(read(t, dir, "workspace.json")))) {
		if !isUUIDForm(id) {
			t.Errorf("구 형식 id 잔존: %q", id)
		}
	}
}

// TC-MGU-6: v1 입력은 1회 실행으로 스키마 변환과 id 재작성이 함께 끝난다 (FR-MGU-1)
func TestApply_V1InputSingleRun(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	ws := parseWS(t, []byte(read(t, dir, "workspace.json")))
	if v, _ := ws["schemaVersion"].(float64); int(v) != SchemaVersion {
		t.Errorf("schemaVersion = %#v", ws["schemaVersion"])
	}
	for _, id := range walkIDs(ws) {
		if !isUUIDForm(id) {
			t.Errorf("구 형식 id 잔존: %q", id)
		}
	}
	// v1Basic: 창 1 + pane 1 + 탭 2, panesBasic 중 참조된 도구 2개(999는 고아).
	if rep.Identity.Windows != 1 || rep.Identity.Panes != 1 || rep.Identity.Tabs != 2 || rep.Identity.Tools != 2 {
		t.Errorf("Identity = %+v, want Windows=1 Panes=1 Tabs=2 Tools=2", rep.Identity)
	}
	var tools []map[string]interface{}
	if err := json.Unmarshal([]byte(read(t, dir, "tools.json")), &tools); err != nil {
		t.Fatalf("tools 파싱: %v", err)
	}
	for _, tl := range tools {
		if id, _ := tl["id"].(string); !isUUIDForm(id) {
			t.Errorf("도구 id 가 재작성되지 않았다: %q", id)
		}
	}
}

// TC-MGU-7: dry-run 은 리포트만 내고 파일을 건드리지 않는다 (FR-MGU-10)
func TestApply_DryRunLeavesFilesUntouched(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", legacyWS)
	seed(t, dir, "tools.json", legacyTools)

	rep, err := Apply(dir, true)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if rep.Identity.Total() == 0 {
		t.Error("dry-run 리포트에 재작성 건수가 없다")
	}
	if got := read(t, dir, "workspace.json"); got != legacyWS {
		t.Error("dry-run 이 workspace.json 을 변경했다")
	}
	if got := read(t, dir, "tools.json"); got != legacyTools {
		t.Error("dry-run 이 tools.json 을 변경했다")
	}
	if exists(dir, "workspace.json.preuuid.bak") {
		t.Error("dry-run 이 백업을 만들었다")
	}
}
