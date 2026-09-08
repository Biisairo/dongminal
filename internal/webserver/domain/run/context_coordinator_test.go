package run

import "testing"

// ALERT_MOBILE_CONTEXT_SRS §3.3 — 조정자의 컨텍스트 관측 (FR-RCX-6~12).
//
// 접수한 물음은 "조정자 스스로의 context 사용량은 확인 못하나?" 다. 훅은 조정자
// 에게도 붙어 실측 토큰과 모델을 이미 보내고 있었고, 서버가 그 `toolId` 를 멤버
// 목록에서만 찾다 못 찾으면 **그대로 버렸다.** 신호는 도착해 있었고 앉을 자리가
// 없었다.

// V-13: 조정자 `toolId` 로 넣은 관측이 Run 의 조정자 자리에 앉고, 등급이 멤버와
// **같은 정책**으로 매겨진다 (FR-RCX-6·7·8).
func TestObserveContext_CoordinatorGetsItsOwnSlot(t *testing.T) {
	s := newTestStore(t, "e-coord")
	rec, _ := openRunWithMember(t, s, "member-tool", nil)

	m, entered, ok := s.ObserveContext("coord", ContextObservation{
		Tokens: 202185, HasTokens: true, Model: "claude-opus-5",
	}, DefaultContextPolicy())
	if !ok {
		t.Fatal("조정자 관측이 버려졌다 — FR-RCX-6")
	}
	// 조정자는 멤버가 아니다. 그 사실을 빈 멤버 id 가 말한다.
	if m.ID != "" {
		t.Errorf("조정자에게 멤버 id 가 붙었다: %q", m.ID)
	}
	if m.RunID != rec.ID {
		t.Errorf("RunID = %q, want %q", m.RunID, rec.ID)
	}
	// FR-RCX-10 / D-14: 조정자에게는 등급 통지를 보내지 않으므로 전이를 내지 않는다.
	if entered != "" {
		t.Errorf("조정자 관측이 등급 전이를 냈다: %q", entered)
	}

	got, found := s.Get(rec.ID)
	if !found {
		t.Fatal("Run 을 다시 읽지 못했다")
	}
	if got.Coordinator == nil {
		t.Fatal("조정자 자리가 비어 있다 — FR-RCX-7")
	}
	// FR-RCX-8: 멤버와 같은 어휘·같은 정책. 창 넓히기(FR-CTX-6)도 그대로 돈다.
	if got.Coordinator.ContextTokens != 202185 {
		t.Errorf("실측 토큰 = %d", got.Coordinator.ContextTokens)
	}
	if got.Coordinator.ContextLimit != 1000000 {
		t.Errorf("창을 넓히지 않았다: %v", got.Coordinator.ContextLimit)
	}
	if got.Coordinator.ContextLevel != LevelOK {
		t.Errorf("등급 = %q, want ok", got.Coordinator.ContextLevel)
	}

	// D-13: 멤버 배열에 가짜 멤버가 생기지 않았다 — 멤버 수·승계·라우팅이 전부
	// 그 배열을 딛고 있다.
	if len(got.Members) != 1 {
		t.Errorf("멤버 수 = %d, want 1 (조정자가 멤버로 들어갔다)", len(got.Members))
	}
}

// V-15: 조정자 관측이 critical 이어도 전이를 내지 않는다 (FR-RCX-10 / D-14).
//
// 통지는 호출자가 `entered` 를 보고 보내므로, 여기서 빈 값이면 통지 경로 자체를
// 지나지 않는다 — 조정자 자신의 등급을 조정자에게 알리면 그 통지가 조정자의
// 컨텍스트를 더 먹는다.
func TestObserveContext_CoordinatorNeverEntersAlert(t *testing.T) {
	s := newTestStore(t, "e-coord-crit")
	rec, _ := openRunWithMember(t, s, "member-tool", nil)
	p := DefaultContextPolicy()

	_, entered, ok := s.ObserveContext("coord", ContextObservation{
		Bytes: bytesForRatio(p, 0.99), HasBytes: true,
	}, p)
	if !ok {
		t.Fatal("조정자 관측이 버려졌다")
	}
	if entered != "" {
		t.Errorf("조정자가 등급 전이를 냈다: %q", entered)
	}
	got, _ := s.Get(rec.ID)
	// 기록은 남는다 — 알리지 않는 것과 재지 않는 것은 다르다.
	if got.Coordinator == nil || got.Coordinator.ContextLevel == "" {
		t.Fatal("등급을 매기지 않았다 — 알리지 않는 것과 재지 않는 것은 다르다")
	}
}

// V-16: 아무에게도 속하지 않는 `toolId` 는 오류 없이 무시된다 (FR-RCX-12).
//
// 이 훅은 Run 과 무관한 claude 전부에서 돈다. 멤버도 조정자도 아닌 것은 실패가
// 아니라 정상이다.
func TestObserveContext_UnknownToolStillIgnored(t *testing.T) {
	s := newTestStore(t, "e-coord-unknown")
	openRunWithMember(t, s, "member-tool", nil)

	if _, _, ok := s.ObserveContext("nobody", ContextObservation{
		Tokens: 1000, HasTokens: true,
	}, DefaultContextPolicy()); ok {
		t.Error("남의 toolId 가 어딘가에 앉았다")
	}
	if _, _, ok := s.ObserveContext("", ContextObservation{}, DefaultContextPolicy()); ok {
		t.Error("빈 toolId 가 앉았다")
	}
}

// FR-RCX-11: 필드가 없던 옛 레코드는 빈 값이다 — 관측 전의 Run 에는 조정자
// 자리가 아예 없고, 그래서 화면이 아무것도 그리지 않는다.
func TestRun_CoordinatorAbsentUntilObserved(t *testing.T) {
	s := newTestStore(t, "e-coord-absent")
	rec, _ := openRunWithMember(t, s, "member-tool", nil)
	got, _ := s.Get(rec.ID)
	if got.Coordinator != nil {
		t.Error("관측 전인데 조정자 자리가 있다")
	}
}

// 멤버 경로는 종전 그대로다 — 공통 함수로 뽑았다고 등급 전이가 사라지면 안 된다
// (FR-CBG-6 회귀).
func TestObserveContext_MemberStillEnters(t *testing.T) {
	s := newTestStore(t, "e-member-enters")
	openRunWithMember(t, s, "member-tool", nil)
	p := DefaultContextPolicy()

	_, entered, ok := s.ObserveContext("member-tool", ContextObservation{
		Bytes: bytesForRatio(p, 0.99), HasBytes: true,
	}, p)
	if !ok {
		t.Fatal("멤버 관측이 닿지 않았다")
	}
	if entered != LevelCritical {
		t.Errorf("전이 = %q, want critical", entered)
	}
}
