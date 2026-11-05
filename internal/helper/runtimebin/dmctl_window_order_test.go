package runtimebin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// REFACTOR PROD2 §7: window 순서 규칙의 골든. JS winOrderItems 가 같은 표본을 읽는다
// (web/js/test/window-order.test.mjs). 한쪽 규칙만 바뀌면 그쪽 시험이 실패한다.
func TestWindowPositions_SharedVectors(t *testing.T) {
	blob, err := os.ReadFile(filepath.Join("testdata", "window_order_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vec struct {
		Cases []struct {
			Name    string           `json:"name"`
			Windows []wsWindow       `json:"windows"`
			Want    map[string][]any `json:"want"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(blob, &vec); err != nil {
		t.Fatal(err)
	}
	if len(vec.Cases) == 0 {
		t.Fatal("표본이 없다")
	}
	for _, c := range vec.Cases {
		got := windowPositions(&wsTree{Windows: c.Windows})
		if len(got) != len(c.Want) {
			t.Errorf("%s: 창 수 %d, 기대 %d (%+v)", c.Name, len(got), len(c.Want), got)
		}
		for id, w := range c.Want {
			p, ok := got[id]
			if !ok || p.container != w[0] || float64(p.index) != w[1] || float64(p.count) != w[2] {
				t.Errorf("%s: %s = %+v, 기대 %v", c.Name, id, p, w)
			}
		}
	}
}
