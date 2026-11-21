package runtimebin

import (
	"bytes"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS TC-RDG-21 (FR-RDG-23): list-workspace·list-groups 가 워크스페이스
// 모양을 `shared/workspace` 의 것으로 읽은 뒤에도 출력이 종전과 같은지 골든으로 고정한다.
// 골든은 합치기 전 코드가 만든 것이다.

var updateListWSGolden = flag.Bool("update-listws-golden", false, "rewrite testdata/listworkspace.golden")

const listWSGoldenState = `{
  "tools": [
    {"id":"p1","pid":101,"sizeCols":80,"sizeRows":24,"fgName":"vim"},
    {"id":"p2","pid":102,"sizeCols":120,"sizeRows":40},
    {"id":"p3","pid":103,"fgName":"claude"},
    {"id":"p4","pid":104}
  ],
  "fgTabNames": true,
  "workspace": {
    "schemaVersion": 2,
    "activeWindow": "w2",
    "windowGroups": [
      {"id":"g1","name":"이슈","tree":{"repo":"o/r","root":32}},
      {"id":"g0","name":"빈 그룹"}
    ],
    "windows": [
      {"id":"w1","name":"메인","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"11111111-aaaa","tabs":[
        {"id":"11111111-aaaa","name":"Shell","toolId":"p1","type":"terminal"},
        {"id":"short","name":"내작업","toolId":"p2","type":"terminal","nameSource":"manual"}
      ]}},
      {"id":"w2","name":"분할","groupId":"g1","focusedPane":"r3","layout":{"type":"split","direction":"h","children":[
        {"type":"pane","id":"r2","activeTab":"t3","tabs":[{"id":"t3","name":"Shell","toolId":"p3","nameSource":"auto"}]},
        {"type":"split","direction":"v","children":[
          {"type":"pane","id":"r3","activeTab":"t4","tabs":[{"id":"t4","name":"main.go","toolId":"","type":"editor"}]},
          {"type":"pane","id":"r4","activeTab":"t5","tabs":[{"id":"t5","name":"Shell","toolId":"p4","nameSource":"manual"}]}
        ]}
      ]}},
      {"id":"w3","name":"그룹 둘째","groupId":"g1","focusedPane":"r5","layout":{"type":"pane","id":"r5","tabs":[]}},
      {"id":"w4","name":"diff","type":"git","layout":{"type":"pane","id":"r6","activeTab":"t6","tabs":[{"id":"t6","name":"git","type":"git"}]}},
      {"id":"w5","name":"빈 창","focusedPane":"","layout":null}
    ]
  }
}`

func TestListWorkspaceGolden(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listWSGoldenState))
	})
	defer cleanup()
	var b strings.Builder
	for _, args := range [][]string{
		{"list-workspace"}, {"list-workspace", "--json"}, {"list-workspace", "--window", "분할"},
		{"list-workspace", "--tab", "nope", "--json"}, {"list-groups"}, {"list-groups", "--json"},
	} {
		var out, errw bytes.Buffer
		code := runDmctl(args, &out, &errw)
		fmt.Fprintf(&b, "%q\n  code=%d\n  stdout=%s\n  stderr=%q\n", args, code, out.String(), errw.String())
	}
	path := filepath.Join("testdata", "listworkspace.golden")
	if *updateListWSGolden {
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.String(); got != string(want) {
		t.Fatalf("list-workspace golden mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
}
