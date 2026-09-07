package sandbox

import "testing"

// V-SBM-4 (UX_BATCH6_SRS FR-SBM-6): 격리 등급은 **작업 방식을 보지 않는다.**
//
// 작업 방식은 창을 여는 사람이 고르는 값이 됐다 (FR-SBM-1). 고르는 값이 프로파일의
// 등급을 정하면 같은 프로파일이 누를 때마다 다른 등급으로 보인다.
func TestInfo_IsolatedIgnoresWorkKind(t *testing.T) {
	base := Profile{Name: "x", Image: "i", Network: "none"}
	for _, w := range []WorkKind{WorkNone, WorkCopy, WorkMount} {
		p := base
		p.Work = w
		if !p.Info().Isolated {
			t.Errorf("work=%q 가 등급을 낮췄다", w)
		}
	}
}

// 등급의 근거 셋은 그대로다 — 헬퍼·네트워크·기본 마운트.
func TestInfo_IsolatedStillFollowsPolicy(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    Profile
		want bool
	}{
		{"기본", Profile{Network: "none"}, true},
		{"헬퍼", Profile{Network: "none", Helper: true}, false},
		{"네트워크", Profile{Network: "bridge"}, false},
		{"기본 마운트", Profile{Network: "none", BaseMounts: []Mount{{Host: "/h", Container: "/c"}}}, false},
	} {
		if got := tc.p.Info().Isolated; got != tc.want {
			t.Errorf("%s: isolated=%v want=%v", tc.name, got, tc.want)
		}
	}
}

// 지금 있는 두 프로파일의 값이 이 개정으로 바뀌지 않는다는 사실을 고정한다.
func TestInfo_ScratchStaysIsolated(t *testing.T) {
	if !Scratch().Info().Isolated {
		t.Fatal("scratch 가 격리 경계가 아니게 됐다")
	}
}
