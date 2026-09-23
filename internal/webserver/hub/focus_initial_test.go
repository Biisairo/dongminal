package hub

import "testing"

// FOCUS_INITIAL_RESTORE_SRS — 소유권은 초기 문서(USER_CHECKLIST_FIXES_SRS §3.5,
// FR-XDF-1~14)대로다.
//
// 비는 계기는 구독 끊김 하나이고(FR-XDF-9), 빈자리는 누구에게도 돌려주지 않는다.
// 다음 주인은 **다음에 포커스한 쪽**이다(FR-XDF-2 last-focus-wins).

// V-FIR-1: 밀어낸 쪽이 떠나도 밀려난 쪽에게 돌아가지 않는다.
//
// 돌려주기가 있던 동안에는 여기서 A 에게 돌아갔고, 그 결과 다른 앱으로 alt-tab
// 할 때마다 PTY 가 뒤에 있던 화면의 폭으로 뒤집혔다 (사용자, 2026-09-24:
// *"해당 동작이 있으니 사용하기 어렵다"*).
func TestDetach_DoesNotHandBack(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	epB := f.Attach("cliB")
	f.Claim("cliA", "W1")
	f.Claim("cliB", "W1") // A 를 밀어낸다

	if !f.Detach("cliB", epB) {
		t.Fatal("해제가 변화를 알리지 않았다")
	}
	if owner := f.Snapshot()["W1"]; owner != "" {
		t.Fatalf("owner[W1]=%q — 비어야 한다. 다음 주인은 다음에 포커스한 쪽이다 (FR-XDF-2·9)", owner)
	}
}
