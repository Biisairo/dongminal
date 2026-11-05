package run

import "testing"

// ISSUE_AGENT_TREE_SRS FR-SLP-11: statusLine 의 공식 창 크기가 모델 이름의 추측을 이긴다.
// 한 번 공식 값을 받으면, 뒤에 온 transcript 관측의 추측이 그것을 덮지 않는다.
func TestContext_OfficialWindowWins(t *testing.T) {
	var cs ContextState
	p := DefaultContextPolicy()
	applyContextObservation(&cs, ContextObservation{Tokens: 60000, HasTokens: true, Window: 500000}, p, 1)
	if cs.ContextLimit != 500000 || cs.ContextRatio != 0.12 || !cs.WindowOfficial {
		t.Fatalf("공식 관측 뒤 %+v", cs)
	}
	// transcript 관측: claude 어댑터는 모델 이름에서 1M 을 추측한다.
	applyContextObservation(&cs, ContextObservation{Tokens: 80000, HasTokens: true, Agent: "claude", Model: "claude-haiku-4-5-20251001"}, p, 2)
	if cs.ContextLimit != 500000 {
		t.Fatalf("추측이 공식 창을 덮었다: %+v", cs)
	}
	if cs.ContextRatio != 0.16 {
		t.Fatalf("ratio=%v", cs.ContextRatio)
	}
}

func TestContext_NoOfficialKeepsGuess(t *testing.T) {
	var cs ContextState
	applyContextObservation(&cs, ContextObservation{Tokens: 50000, HasTokens: true}, DefaultContextPolicy(), 1)
	if cs.WindowOfficial || cs.ContextLimit != DefaultWindowTokens {
		t.Fatalf("%+v", cs)
	}
}
