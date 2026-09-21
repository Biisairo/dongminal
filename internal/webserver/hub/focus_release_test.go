package hub

import "testing"

// UX_BATCH10_SRS 묶음 F — 반납 (FR-UXB-20~22 · V-UXB-6).
//
// 반납은 **해제(Detach)와 다른 동사**다 (D-UXB-3). 해제는 구독이 끊긴 것이고,
// 반납은 구독을 든 채로 "지금은 내 차례가 아니다" 를 말한다. 둘을 하나로 두면
// blur 한 번에 SSE 가 끊겨 명령·이벤트가 멎는다.

// V-UXB-6: 반납하면 소유권이 비고, 구독은 살아 있다.
func TestRelease_ClearsOwnershipKeepsSubscription(t *testing.T) {
	f := NewFocusRegistry()
	ep := f.Attach("cliA")
	f.Claim("cliA", "W1")

	if !f.Release("cliA") {
		t.Fatal("반납이 변화를 알리지 않았다")
	}
	if owner := f.Snapshot()["W1"]; owner != "" {
		t.Fatalf("owner[W1]=%q — 비어야 한다", owner)
	}
	if n := f.LiveCount(); n != 1 {
		t.Fatalf("LiveCount=%d — 반납은 구독을 끊지 않는다 (FR-UXB-21)", n)
	}
	// 실행자 선출의 후보로 남는다 — 보고 있는 사람이 사라진 것이 아니다.
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor=%q want cliA", got)
	}
	// 해제는 여전히 그 구독의 것이다.
	if f.Detach("cliA", ep) {
		t.Fatal("이미 빈 소유권의 해제가 변화를 알렸다")
	}
}

// V-UXB-6: 같은 반납의 반복은 방송을 만들지 않는다 (FR-UXB-22 · FR-XDF-14 멱등).
func TestRelease_SecondTimeReportsNoChange(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Claim("cliA", "W1")

	if !f.Release("cliA") {
		t.Fatal("첫 반납은 변화다")
	}
	if f.Release("cliA") {
		t.Fatal("둘째 반납은 변화가 아니다 — 방송이 따라붙으면 폭주가 된다")
	}
}

// 반납은 **자기 것만** 놓는다. 한 클라이언트의 blur 가 다른 화면의 소유권을
// 건드리면 그것이 곧 새로운 도둑질이다.
func TestRelease_LeavesOtherClients(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")
	f.Claim("cliA", "W1")
	f.Claim("cliB", "W2")

	f.Release("cliA")
	if owner := f.Snapshot()["W2"]; owner != "cliB" {
		t.Fatalf("owner[W2]=%q want cliB", owner)
	}
}

// 빈 clientId 는 아무 일도 하지 않는다 — 본문이 비어 온 요청이 전체를 비우면 안 된다.
func TestRelease_EmptyClientIsNoop(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Claim("cliA", "W1")

	if f.Release("") {
		t.Fatal("빈 clientId 가 변화를 알렸다")
	}
	if owner := f.Snapshot()["W1"]; owner != "cliA" {
		t.Fatalf("owner[W1]=%q want cliA", owner)
	}
}
