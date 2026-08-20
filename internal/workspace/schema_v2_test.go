package workspace

import (
	"errors"
	"strings"
	"testing"
)

// sampleV1은 마이그레이션 전 스키마다. 게이트 검증 전용으로 이 파일에만 둔다
// — 공용 픽스처(sampleWS)는 v2 로 이동했다.
const sampleV1 = `{
  "activeSession": "s1",
  "sessions": [
    {"id":"s1","name":"main","focusedRegion":"r1","layout":{
      "type":"region","id":"r1","activeTab":"t1",
      "tabs":[{"id":"t1","name":"build","toolId":"10"}]}}
  ]
}`

// sampleV2는 v2 스키마의 정상 입력이다. sampleV1 과 동일 구조를 신 키로 표현.
const sampleV2 = `{
  "schemaVersion": 2,
  "activeWindow": "s1",
  "windows": [
    {
      "id": "s1",
      "name": "main",
      "focusedPane": "r1",
      "layout": {
        "type": "split",
        "direction": "row",
        "children": [
          {
            "type": "pane",
            "id": "r1",
            "activeTab": "t1",
            "tabs": [
              {"id": "t1", "name": "build", "toolId": "10"},
              {"id": "t2", "name": "run",   "toolId": "11"}
            ]
          },
          {
            "type": "pane",
            "id": "r2",
            "activeTab": "t3",
            "tabs": [
              {"id": "t3", "name": "logs", "toolId": "12"}
            ]
          }
        ]
      }
    }
  ]
}`

// ── FR-EM-2a: schemaVersion 게이트 ──────────────────────────────────────

func TestNew_RejectsV1Schema(t *testing.T) {
	// 구 스키마(schemaVersion 없음, sessions 키)는 조용히 성공해서는 안 된다.
	store := &memPersister{data: []byte(sampleV1)}
	_, err := New(newFakeLive("10", "11", "12"), store)
	if err == nil {
		t.Fatal("구 스키마에 오류가 없음 — 조용한 성공")
	}
	if !errors.Is(err, ErrSchemaTooOld) {
		t.Errorf("err = %v, want ErrSchemaTooOld", err)
	}
	if !strings.Contains(err.Error(), "migrate") {
		t.Errorf("오류 메시지에 마이그레이션 안내 없음: %v", err)
	}
}

func TestNew_AcceptsV2Schema(t *testing.T) {
	store := &memPersister{data: []byte(sampleV2)}
	m, err := New(newFakeLive("10", "11", "12"), store)
	if err != nil {
		t.Fatalf("v2 스키마 거부됨: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 3 {
		t.Errorf("entries = %d, want 3", got)
	}
}

func TestNew_MissingFileIsNotAnError(t *testing.T) {
	// 신규 사용자: 파일 없음 → 빈 인덱스, 오류 없음.
	m, err := New(newFakeLive(), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("파일 없음이 오류로 처리됨: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 0 {
		t.Errorf("entries = %d, want 0", got)
	}
}

func TestNew_MalformedJSONStaysTolerant(t *testing.T) {
	// 파싱 불가 파일은 기존 동작(빈 인덱스) 유지 — 버전 게이트와 구분된다.
	m, err := New(newFakeLive(), &memPersister{data: []byte(`{"windows":`)})
	if err != nil {
		t.Fatalf("깨진 JSON 이 오류로 처리됨: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 0 {
		t.Errorf("entries = %d, want 0", got)
	}
}

func TestSave_RejectsV1Schema(t *testing.T) {
	m, err := New(newFakeLive("10"), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if _, err := m.Save([]byte(sampleV1), ""); !errors.Is(err, ErrSchemaTooOld) {
		t.Errorf("Save(v1) err = %v, want ErrSchemaTooOld", err)
	}
}

func TestSave_RejectsMissingSchemaVersion(t *testing.T) {
	m, err := New(newFakeLive("10"), &memPersister{empty: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	blob := `{"windows":[{"id":"s1","name":"w","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}`
	if _, err := m.Save([]byte(blob), ""); !errors.Is(err, ErrSchemaTooOld) {
		t.Errorf("schemaVersion 누락 Save err = %v, want ErrSchemaTooOld", err)
	}
}

// ── FR-EM-3: 좌표계 W ──────────────────────────────────────────────────

func TestLabels_UseWPrefix(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{data: []byte(sampleV2)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	want := map[string]string{"10": "W1.P1.T1", "11": "W1.P1.T2", "12": "W1.P2.T1"}
	got := m.Labels()
	for id, label := range want {
		if got[id] != label {
			t.Errorf("labels[%s] = %q, want %q", id, got[id], label)
		}
	}
}

func TestResolve_AcceptsWLabel(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{data: []byte(sampleV2)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if id, err := m.Resolve("W1.P2.T1"); err != nil || id != "12" {
		t.Errorf("Resolve(W1.P2.T1) = %q, %v; want 12, nil", id, err)
	}
}

func TestResolve_RejectsOldSLabel(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{data: []byte(sampleV2)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if _, err := m.Resolve("S1.P2.T1"); err == nil {
		t.Error("구 접두사 S 라벨이 해석됨 — alias 미제공 원칙 위반")
	}
}

// ── 신 키 인식 ─────────────────────────────────────────────────────────

func TestBuildIndex_ReadsFocusedPaneAndActiveWindow(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{data: []byte(sampleV2)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	var active *TabEntry
	for i := range m.Entries() {
		if m.Entries()[i].IsActive {
			active = &m.Entries()[i]
		}
	}
	if active == nil {
		t.Fatal("activeWindow/focusedPane 로 활성 탭이 판정되지 않음")
	}
	if active.ToolID != "10" {
		t.Errorf("활성 탭 = %s, want 10", active.ToolID)
	}
}

func TestBuildIndex_PaneTypeReplacesRegion(t *testing.T) {
	// type:"region" 은 더 이상 탭 보유자로 인식되지 않아야 한다.
	blob := `{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"region","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}`
	m, err := New(newFakeLive("10"), &memPersister{data: []byte(blob)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 0 {
		t.Errorf("구 type region 이 여전히 인식됨: entries = %d, want 0", got)
	}
}
