package agentsess

import (
	"testing"

	"dongminal/internal/shared/agentadapter"
)

// V-M11-13·14 (M11_SRS FR-M11-6 / M11-B3): **기동 옵션이 진실의 한 겹이다.**
//
// 프로토콜이 현재 모델을 말하는 것은 `set_model` 이나 첫 턴의 프레임이고,
// `initialize` 응답에는 그 스칼라가 아예 없다(실측 — SRS §2.5). 그래서 턴을 돌리기
// 전에는 화면이 빈 채로 섰고, 그것이 접수한 "하단에 정보들이 없다" 의 한 겹이다.
//
// `recordLocked` 는 이미 같은 사다리를 쓴다 — 이 검사는 **State() 도 같은 답을
// 하는가**를 잰다. 두 자리가 다른 답을 하면 디스크 기록과 화면이 어긋난다.

func openWithOpts(t *testing.T, m *Manager, opts agentadapter.LaunchOpts) *Session {
	t.Helper()
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	s, err := m.Open("tool-1", ad, opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestState_ModelFallsBackToLaunchOpts(t *testing.T) {
	m, _ := newMgr(t)
	s := openWithOpts(t, m, agentadapter.LaunchOpts{Model: "opus-x", PermissionMode: "auto"})

	st := s.State()
	if st.Status.Model != "opus-x" {
		t.Fatalf("턴 전에도 아는 값인데 화면이 빈 채로 선다: model=%q", st.Status.Model)
	}
	if st.Status.PermissionMode != "auto" {
		t.Fatalf("권한 모드도 같은 사다리를 써야 한다: mode=%q", st.Status.PermissionMode)
	}
}

func TestState_ProtocolWins(t *testing.T) {
	m, _ := newMgr(t)
	s := openWithOpts(t, m, agentadapter.LaunchOpts{Model: "opus-x", PermissionMode: "auto"})

	// 프로토콜이 말하면 그쪽이 진실이다 — 옵션은 **모를 때만** 답한다.
	s.mu.Lock()
	s.status.Model = "sonnet-y"
	s.status.PermissionMode = "acceptEdits"
	s.mu.Unlock()

	st := s.State()
	if st.Status.Model != "sonnet-y" || st.Status.PermissionMode != "acceptEdits" {
		t.Fatalf("옵션이 프로토콜을 덮었다: %+v", st.Status)
	}
}

func TestState_UnknownStaysUnknown(t *testing.T) {
	m, _ := newMgr(t)
	s := openWithOpts(t, m, agentadapter.LaunchOpts{})

	// 모르는 것을 지어내지 않는다 (FR-CBG-5) — 옵션도 비어 있으면 빈 채로 둔다.
	if st := s.State(); st.Status.Model != "" || st.Status.PermissionMode != "" {
		t.Fatalf("모르는 것을 값으로 말했다: %+v", st.Status)
	}
}
