package hub

import "testing"

// OWNER_HANDBACK_SRS 묶음 S — 주인이 비면 직전 주인에게 돌아간다 (FR-OHB-1~8).
//
// 반납(Release)이 소유권을 비우는 동사라면, 돌려주기는 **비는 순간 누가
// 채우는가** 의 답이다. 답이 없던 동안, 상대가 놓아도 이쪽 화면은 떠난 화면이
// 남긴 PTY 폭을 계속 따랐다 (SRS §2.2 실측).
//
// 적는 계기가 **떠남**이라는 것이 이 묶음의 요점이다. 밀려난 순간만 적으면
// 실측의 순서(반납 → 남이 주장)를 잡지 못한다 (SRS §2.3 ①).

// V-OHB-1: 실측의 순서 그대로다 — A 가 **놓은 뒤에** B 가 가져갔고, B 가 놓으면
// A 에게 돌아와야 한다. 주장 때만 직전 주인을 적는 구현은 여기서 진다.
func TestHandback_ReturnsToPriorOwnerAfterReleaseThenClaim(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Release("cliA") // 11:37:49 — A 가 blur 로 놓는다
	f.Claim("cliB", "W1")

	if !f.Release("cliB") { // 11:37:56 — B 가 놓는다
		t.Fatal("반납이 변화를 알리지 않았다")
	}
	if owner := f.Snapshot()["W1"]; owner != "cliA" {
		t.Fatalf("owner[W1]=%q want cliA — 직전 주인에게 돌아가야 한다 (FR-OHB-3)", owner)
	}
}

// V-OHB-1: 해제(구독 끊김)도 같은 문을 지난다. 상대 기기가 창을 닫는 것과
// blur 하는 것은 이쪽 화면에서 구별되지 않아야 한다.
func TestHandback_AlsoOnDetach(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	epB := f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Release("cliA")
	f.Claim("cliB", "W1")

	if !f.Detach("cliB", epB) {
		t.Fatal("해제가 변화를 알리지 않았다")
	}
	if owner := f.Snapshot()["W1"]; owner != "cliA" {
		t.Fatalf("owner[W1]=%q want cliA — 해제도 돌려준다 (FR-OHB-3)", owner)
	}
}

// V-OHB-2: 직전 주인이 자기 자신이면 돌려주지 않는다. 그러지 않으면 반납이
// 아무 일도 하지 않는 동사가 된다 (FR-OHB-4).
func TestHandback_NotToSelf(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Claim("cliA", "W1")

	if !f.Release("cliA") {
		t.Fatal("첫 반납은 변화다")
	}
	if owner := f.Snapshot()["W1"]; owner != "" {
		t.Fatalf("owner[W1]=%q — 자기 자신에게 돌려주면 반납이 무력해진다 (FR-OHB-4)", owner)
	}
}

// V-OHB-3: 직전 주인의 구독이 없으면 빈 채로 둔다. 죽은 신원에게 돌려주면 그
// 창은 아무도 크기를 정하지 못하는 채로 잠긴다 (FR-OHB-7).
func TestHandback_SkipsDeadPriorOwner(t *testing.T) {
	f := NewFocusRegistry()
	epA := f.Attach("cliA")
	f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Detach("cliA", epA) // A 의 구독이 끊긴다
	f.Claim("cliB", "W1")
	f.Release("cliB")

	if owner := f.Snapshot()["W1"]; owner != "" {
		t.Fatalf("owner[W1]=%q — 구독 없는 직전 주인에게는 돌려주지 않는다 (FR-OHB-7)", owner)
	}
}

// V-OHB-4: 돌려주기도 **한 신원은 창 하나**를 지킨다. 직전 주인이 다른 창을
// 쥐고 있으면 돌려주지 않는다 — 뺏어 오면 그 자리에서 또 돌려주기가 서고
// 창이 고리를 이루면 끝나지 않는다 (FR-OHB-5 · D-OHB-4).
func TestHandback_SkipsWhenPriorOwnerHoldsAnotherWindow(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Release("cliA")
	f.Claim("cliB", "W1")
	f.Claim("cliA", "W2") // A 는 이제 W2 의 주인이다

	f.Release("cliB")

	snap := f.Snapshot()
	if owner := snap["W1"]; owner != "" {
		t.Fatalf("owner[W1]=%q — 직전 주인이 다른 창을 쥐면 돌려주지 않는다 (FR-OHB-5)", owner)
	}
	if owner := snap["W2"]; owner != "cliA" {
		t.Fatalf("owner[W2]=%q want cliA — 돌려주기가 남의 창을 건드렸다", owner)
	}
}

// V-OHB-5: 돌려준 뒤 직전 주인은 **방금 놓은 신원**이다. 주고받기가 반복되어도
// 기억은 늘 한 칸 뒤를 가리킨다 (FR-OHB-6).
func TestHandback_PriorOwnerBecomesTheOneWhoJustLetGo(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Release("cliA")
	f.Claim("cliB", "W1")
	f.Release("cliB") // → A 에게 돌아간다. 직전 주인은 이제 B 다

	if owner := f.Snapshot()["W1"]; owner != "cliA" {
		t.Fatalf("선행 조건이 깨졌다: owner[W1]=%q want cliA", owner)
	}
	if !f.Release("cliA") {
		t.Fatal("반납이 변화를 알리지 않았다")
	}
	if owner := f.Snapshot()["W1"]; owner != "cliB" {
		t.Fatalf("owner[W1]=%q want cliB — 이번 직전 주인은 B 다 (FR-OHB-6)", owner)
	}
}

// V-OHB-6: 반환값 규약은 그대로다 — 변화가 있을 때만 참이고, 참일 때만 방송이
// 붙는다 (FR-OHB-8 · FR-XDF-14 멱등).
func TestHandback_KeepsChangedContract(t *testing.T) {
	f := NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")

	f.Claim("cliA", "W1")
	f.Release("cliA")
	f.Claim("cliB", "W1")

	if !f.Release("cliB") {
		t.Fatal("돌려주기가 일어난 반납은 변화다")
	}
	// B 는 이제 아무 창도 쥐고 있지 않다. 같은 반납의 반복은 변화가 아니다.
	if f.Release("cliB") {
		t.Fatal("둘째 반납은 변화가 아니다 — 방송이 따라붙으면 폭주가 된다")
	}
}
