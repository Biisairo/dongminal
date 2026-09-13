package workspace

import (
	"encoding/json"
	"testing"
)

// M8 D-A-13 (GO-17): Run 표식(`tab.runId`·`window.ownerRunId`)의 트리 조작은 이
// 패키지의 것이다 — 모르는 필드는 그대로 살아남고, 바꿀 것이 없으면 false 다.
func TestApplyRunMarks(t *testing.T) {
	blob := []byte(`{"windows":[{"id":"w1","extra":1,"layout":{"type":"split","children":[
	  {"type":"pane","id":"p1","tabs":[{"id":"t1","toolId":"x","foo":"bar"},{"id":"t2"}]},
	  {"type":"pane","id":"p2","tabs":[{"id":"t3","runId":"old"}]}]}},
	  {"id":"w2","layout":{"type":"pane","id":"p3","tabs":[{"id":"t4"}]}}]}`)
	var tree map[string]any
	if err := json.Unmarshal(blob, &tree); err != nil {
		t.Fatal(err)
	}
	tabs := map[string]bool{"t1": true, "t3": true}
	if !ApplyRunMarks(tree, tabs, "w1", true, "run-1") {
		t.Fatal("바꿀 것이 있었다")
	}
	out, _ := json.Marshal(tree)
	for _, want := range []string{`{"foo":"bar","id":"t1","runId":"run-1","toolId":"x"}`, `{"id":"t3","runId":"run-1"}`, `"ownerRunId":"run-1"`, `"extra":1`} {
		if !contains(out, want) {
			t.Fatalf("%s 가 없다:\n%s", want, out)
		}
	}
	if !contains(out, `{"id":"t2"}`) || !contains(out, `{"id":"t4"}`) {
		t.Fatalf("대상 밖의 탭에 표식이 붙었다:\n%s", out)
	}
	// 같은 값을 다시 쓰면 바뀐 것이 없다 — 저장을 일으키지 않는다.
	if ApplyRunMarks(tree, tabs, "w1", true, "run-1") {
		t.Fatal("같은 표식인데 changed")
	}
	// 지우기: runId=="" 는 탭과 창 표식을 뗀다 — markWindow 가 거짓이어도 windowID 가 있으면 창 표식은 지운다.
	if !ApplyRunMarks(tree, tabs, "w1", false, "") {
		t.Fatal("지울 것이 있었다")
	}
	out, _ = json.Marshal(tree)
	if contains(out, `runId`) || contains(out, `ownerRunId`) {
		t.Fatalf("표식이 남았다:\n%s", out)
	}
	// 깨진 모양(windows 가 배열이 아님)은 조용히 false.
	if ApplyRunMarks(map[string]any{"windows": "x"}, tabs, "w1", true, "r") {
		t.Fatal("깨진 트리에서 changed")
	}
}

func contains(b []byte, s string) bool {
	return len(s) > 0 && len(b) >= len(s) && indexOf(string(b), s) >= 0
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
