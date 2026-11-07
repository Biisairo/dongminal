package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// SERVER_DRIVEN_ACTIONS_SRS K-j ⑤ (K16): 서버가 재생분에서 지우는 질의와, 그 질의에 xterm 이
// 내는 응답의 짝. 화면 쪽(`TERM_REPORT_RE` 가 응답을 보고로 안다)은
// `web/js/test/shared-vectors.test.mjs` 가 같은 표본으로 잰다.
func TestStripSnapshotQueries_SharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "term_query_report_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct {
		Name   string `json:"name"`
		Query  string `json:"query"`
		Report string `json:"report"`
	}
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) < 8 {
		t.Fatalf("표본이 %d 개뿐이다", len(vs))
	}
	for _, v := range vs {
		if v.Query == "" || v.Report == "" {
			t.Fatalf("%s: 질의와 응답이 다 있어야 한다", v.Name)
		}
		if got := stripSnapshotQueries([]byte(v.Query)); len(got) != 0 {
			t.Errorf("%s: 질의 %q 가 남았다: %q", v.Name, v.Query, got)
		}
	}
}
