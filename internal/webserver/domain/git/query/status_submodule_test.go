package query

import "testing"

// REFACTOR3_FE_REST1_SRS TC-FR1-3 (FU-17): 안쪽만 바뀐 서브모듈(SUBMODULE_DIRTY_NOTICE_SRS 상태 B)은
// `git add` 가 index 에 올릴 것이 없다. 근거는 sub 필드 하나다.
func TestFileEntrySubmoduleInnerOnly(t *testing.T) {
	cases := []struct {
		sub  string
		want bool
	}{
		{"S.M.", true},
		{"S..U", true},
		{"S.MU", true},
		{"SC..", false},
		{"SCM.", false},
		{"SC.U", false},
		{"S...", false},
		{"", false},
		{"N...", false},
		{"S", false},
	}
	for _, c := range cases {
		if got := (FileEntry{Path: "sub", Sub: c.sub}).SubmoduleInnerOnly(); got != c.want {
			t.Errorf("sub %q: got %v, want %v", c.sub, got, c.want)
		}
	}
}
