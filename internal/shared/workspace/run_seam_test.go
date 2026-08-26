package workspace

import "testing"

// FR-EM-18: Run 접합 필드는 없거나 비어 있어도 모든 동작이 정상이어야 한다.
// 이 단계에서 이 필드를 읽는 동작은 없다 — 왕복만 보장한다.

func TestRunSeam_AbsentFieldsAreFine(t *testing.T) {
	m, err := New(newFakeLive("10", "11", "12"), &memPersister{data: []byte(sampleV2)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 3 {
		t.Errorf("entries = %d, want 3", got)
	}
}

func TestRunSeam_FieldsRoundTrip(t *testing.T) {
	blob := `{"schemaVersion":2,"windows":[{"id":"s1","name":"team","ownerRunId":"run-7",
	  "layout":{"type":"pane","id":"r1","activeTab":"t1",
	    "tabs":[{"id":"t1","name":"writer","toolId":"10","runId":"run-7"}]}}]}`
	m, err := New(newFakeLive("10"), &memPersister{data: []byte(blob)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 1 {
		t.Fatalf("entries = %d, want 1", got)
	}
	// 접합 필드가 있어도 참조 추출은 평소와 같아야 한다.
	refs, err := ReferencedToolIDs([]byte(blob))
	if err != nil {
		t.Fatalf("ReferencedToolIDs: %v", err)
	}
	if _, ok := refs["10"]; !ok || len(refs) != 1 {
		t.Errorf("refs = %v, want {10}", sorted(refs))
	}
}

// LayoutTypePane는 브라우저가 workspace.json 에 쓰는 값과 반드시 같아야 한다.
// P5 의 식별자 일괄 개명이 이 문자열까지 바꿔 Go 는 "tool", 브라우저는 "pane"
// 을 쓰는 상태가 됐고, 테스트 픽스처도 같이 바뀌어 자기 정합적으로 틀린
// 계약이 되어 회귀가 통과했다. 값 자체를 고정해 재발을 막는다.
func TestLayoutTypeConstant_MatchesBrowser(t *testing.T) {
	blob := `{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}`
	m, err := New(newFakeLive("10"), &memPersister{data: []byte(blob)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer m.Close()
	if got := len(m.Entries()); got != 1 {
		t.Fatalf(`type:"pane" 인 레이아웃에서 entries = %d, want 1 — Go 와 브라우저의 스키마 값이 어긋났다`, got)
	}
	// 구 값은 인식되지 않아야 한다 (P2 에서 폐기).
	old := `{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"region","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"10"}]}}]}`
	m2, err := New(newFakeLive("10"), &memPersister{data: []byte(old)})
	if err != nil {
		t.Fatalf("New(old): %v", err)
	}
	defer m2.Close()
	if got := len(m2.Entries()); got != 0 {
		t.Errorf(`구 값 type:"region" 이 인식됨: entries = %d`, got)
	}
}
