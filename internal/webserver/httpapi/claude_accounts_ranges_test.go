package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"

	"dongminal/internal/webserver/domain/claudeacct"
)

// REFACTOR3_FE_FIX_SRS TC-FFX-16 (FX-7, FR-FFX-22): 계정 목록 응답이 계정 행 칸의 범위를 싣는다 —
// 판정의 원천(`claudeacct.AccountRanges`)과 같은 값이다.
func TestClaudeAccountsList_Ranges(t *testing.T) {
	e := newCAEnv(t)
	rec, _ := e.do("GET", "/api/claude-accounts", "")
	var out struct {
		Ranges map[string]claudeacct.AutoRange `json:"ranges"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Ranges, claudeacct.AccountRanges) {
		t.Fatalf("ranges = %v, want %v (%s)", out.Ranges, claudeacct.AccountRanges, rec.Body)
	}
}
