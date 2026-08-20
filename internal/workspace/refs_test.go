package workspace

import (
	"reflect"
	"sort"
	"testing"
)

// FR-EM-14: 부팅 시 도구 컬렉션과 workspace 참조를 교차 검증하기 위한 참조 추출.

func sorted(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestReferencedToolIDs_FlatPane(t *testing.T) {
	got, err := ReferencedToolIDs([]byte(sampleV2))
	if err != nil {
		t.Fatalf("ReferencedToolIDs: %v", err)
	}
	if want := []string{"10", "11", "12"}; !reflect.DeepEqual(sorted(got), want) {
		t.Errorf("= %v, want %v", sorted(got), want)
	}
}

func TestReferencedToolIDs_NestedSplits(t *testing.T) {
	blob := `{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":{
	  "type":"split","children":[
	    {"type":"tool","id":"r1","tabs":[{"id":"t1","toolId":"1"}]},
	    {"type":"split","children":[
	      {"type":"tool","id":"r2","tabs":[{"id":"t2","toolId":"2"}]},
	      {"type":"tool","id":"r3","tabs":[{"id":"t3","toolId":"3"}]}]}]}}]}`
	got, err := ReferencedToolIDs([]byte(blob))
	if err != nil {
		t.Fatalf("ReferencedToolIDs: %v", err)
	}
	if want := []string{"1", "2", "3"}; !reflect.DeepEqual(sorted(got), want) {
		t.Errorf("= %v, want %v", sorted(got), want)
	}
}

func TestReferencedToolIDs_SkipsTabsWithoutTool(t *testing.T) {
	// editor/markdown 탭은 도구 id 가 없다 (FR-EM-11: 참조 0개도 유효).
	blob := `{"schemaVersion":2,"windows":[{"id":"s1","name":"w","layout":
	  {"type":"tool","id":"r1","tabs":[
	    {"id":"t1","type":"editor","filePath":"/a.md"},
	    {"id":"t2","type":"terminal","toolId":"7"}]}}]}`
	got, err := ReferencedToolIDs([]byte(blob))
	if err != nil {
		t.Fatalf("ReferencedToolIDs: %v", err)
	}
	if want := []string{"7"}; !reflect.DeepEqual(sorted(got), want) {
		t.Errorf("= %v, want %v", sorted(got), want)
	}
}

func TestReferencedToolIDs_EmptyBlob(t *testing.T) {
	got, err := ReferencedToolIDs(nil)
	if err != nil {
		t.Fatalf("ReferencedToolIDs(nil): %v", err)
	}
	if len(got) != 0 {
		t.Errorf("= %v, want 빈 집합", sorted(got))
	}
}

func TestReferencedToolIDs_RejectsV1(t *testing.T) {
	// 구 스키마는 조용히 빈 집합을 주면 안 된다 — 전량 고아로 오판해
	// 모든 도구를 폐기하게 된다.
	if _, err := ReferencedToolIDs([]byte(sampleV1)); err == nil {
		t.Error("구 스키마에 오류가 없음")
	}
}

func TestReferencedToolIDs_MalformedJSONErrors(t *testing.T) {
	if _, err := ReferencedToolIDs([]byte(`{"windows":`)); err == nil {
		t.Error("깨진 JSON 에 오류가 없음")
	}
}
