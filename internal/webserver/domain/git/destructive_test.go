package git

import "testing"

// 묶음 J — 파괴적 동작 목록 (GIT_SRS §3A.3 FR-GIT-89, 검증 V37).

// FR-GIT-89 가 열거한 동작이 전부 목록에 있다. 목록이 진실이므로 여기서 빠진
// 동작은 확인 절차도 recovery hint 도 거치지 않는다.
func TestDestructiveActions_CoversFR89(t *testing.T) {
	want := []string{
		ActionDiscard, ActionBranchDelete, ActionStashDrop, ActionTagDelete,
		ActionResetHard, ActionForcePush, ActionRemoteRefDelete,
		// FR-GIT-224: 충돌 파일을 한쪽으로 덮는다 — 워킹 트리의 손대던 내용을
		// 잃고 되살릴 값이 없다.
		ActionResolveSide,
	}
	if len(DestructiveActions) != len(want) {
		t.Fatalf("DestructiveActions = %v, want %v", DestructiveActions, want)
	}
	seen := map[string]bool{}
	for _, a := range DestructiveActions {
		if a == "" {
			t.Fatal("빈 동작 이름이 있다")
		}
		if seen[a] {
			t.Fatalf("%q 가 중복이다", a)
		}
		seen[a] = true
	}
	for _, a := range want {
		if !seen[a] {
			t.Fatalf("%q 가 목록에 없다", a)
		}
	}
}
