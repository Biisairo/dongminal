package run

import "testing"

// UX_BATCH6_SRS 묶음 C — 실측 토큰이 바이트 추정을 대체한다 (FR-CTX-1·4·6·7).

// 열린 Run 하나와 그 멤버 하나. `openRunWithMember`(store_context_test.go)를 그대로
// 쓰되 저장소를 함께 돌려준다 — 이 파일의 검사는 관측을 여러 번 먹인다.
func storeWithMember(t *testing.T, toolID string) *Store {
	t.Helper()
	s := newTestStore(t, "e-ctx")
	openRunWithMember(t, s, toolID, nil)
	return s
}

// V-CTX-1: 실측 토큰이 있으면 비율은 그것으로 계산된다 — 파일 크기가 아니다.
func TestObserveContext_UsesMeasuredTokens(t *testing.T) {
	s := storeWithMember(t, "t1")
	// 바이트로 재면 134% 가 나오는 크기다 (SRS §2.7 실측과 같은 비).
	m, _, ok := s.ObserveContext("t1", ContextObservation{
		Bytes: 968757, HasBytes: true,
		Tokens: 202185, HasTokens: true,
		Model: "claude-opus-5",
	}, DefaultContextPolicy())
	if !ok {
		t.Fatal("관측이 멤버에 닿지 않았다")
	}
	if m.ContextTokens != 202185 {
		t.Errorf("실측 토큰이 기록되지 않았다: %d", m.ContextTokens)
	}
	// 모델이 답하지 못했지만 관측이 200k 를 넘었으므로 창은 1M 이다 (FR-CTX-6).
	if m.ContextLimit != 1000000 {
		t.Errorf("창을 넓히지 않았다: %v", m.ContextLimit)
	}
	if r := m.ContextRatio; r < 0.20 || r > 0.21 {
		t.Errorf("사용률 = %v, want ~0.202 (바이트 추정이면 1.34 였다)", r)
	}
	if m.ContextLevel != LevelOK {
		t.Errorf("등급 = %q, want ok", m.ContextLevel)
	}
}

// V-CTX-3: 모델이 답하면 관측을 기다리지 않는다 — 첫 관측부터 옳다.
func TestObserveContext_ModelDecidesWindowUpFront(t *testing.T) {
	s := storeWithMember(t, "t1")
	m, _, _ := s.ObserveContext("t1", ContextObservation{
		Tokens: 150000, HasTokens: true, Model: "claude-opus-5[1m]", Agent: "claude",
	}, DefaultContextPolicy())
	if m.ContextLimit != 1000000 {
		t.Fatalf("모델이 말한 창을 쓰지 않았다: %v", m.ContextLimit)
	}
	if r := m.ContextRatio; r < 0.14 || r > 0.16 {
		t.Errorf("사용률 = %v, want ~0.15 (200k 로 재면 0.75 였다)", r)
	}
}

// V-CTX-4 (FR-CTX-7): 한 번 넓힌 창은 좁아지지 않는다. 압축으로 사용량이 내려가도
// 창 크기는 그대로다.
func TestObserveContext_WidenedWindowSticks(t *testing.T) {
	s := storeWithMember(t, "t1")
	s.ObserveContext("t1", ContextObservation{Tokens: 400000, HasTokens: true}, DefaultContextPolicy())
	m, _, _ := s.ObserveContext("t1", ContextObservation{Tokens: 90000, HasTokens: true}, DefaultContextPolicy())
	if m.ContextLimit != 1000000 {
		t.Fatalf("창이 도로 좁아졌다: %v", m.ContextLimit)
	}
	if r := m.ContextRatio; r < 0.08 || r > 0.10 {
		t.Errorf("사용률 = %v, want ~0.09", r)
	}
}

// V-CTX-1 (FR-CTX-4): 실측을 얻지 못하면 종전의 바이트 추정으로 떨어진다 —
// 관측 층이 통째로 멎지 않는다.
func TestObserveContext_FallsBackToBytes(t *testing.T) {
	s := storeWithMember(t, "t1")
	// 3.6 B/토큰 · 200k 창에서 70% 가 되는 크기.
	bytes := int64(0.70 * 3.6 * 200000)
	m, entered, _ := s.ObserveContext("t1", ContextObservation{Bytes: bytes, HasBytes: true},
		DefaultContextPolicy())
	if m.ContextTokens != 0 {
		t.Errorf("재지 못한 토큰이 값으로 적혔다: %d", m.ContextTokens)
	}
	if m.ContextLevel != LevelWarn || entered != LevelWarn {
		t.Errorf("등급 = %q entered = %q, want warn", m.ContextLevel, entered)
	}
}
