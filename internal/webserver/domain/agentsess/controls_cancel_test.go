package agentsess

import (
	"testing"

	"dongminal/internal/shared/agentadapter"
)

// V-M12-13 (M12_SRS FR-M12-5) — **어댑터의 능력은 선언으로 말한다.**
//
// 화면의 `_abandon()` 은 언제나 `choice:'deny'` 를 보냈고, 그 근거가 주석에
// *"claude 에는 답 없이 닫는 프레임이 없다"* 로 적혀 있었다 (누수 L12). **claude 의
// 사정이 모든 에이전트의 동작이 된 자리다** — `ompProto.Cancel` 은 있는데 부르는
// 곳이 없었다.
//
// 여기서 재는 것은 그 능력이 **와이어에 선언되는가**다.
func TestControls_CancelIsDeclaredPerAdapter(t *testing.T) {
	want := map[string]bool{}
	for _, id := range agentadapter.IDs() {
		ad, err := agentadapter.Get(id)
		if err != nil || ad.Proto == nil {
			continue
		}
		want[id] = ad.Proto.Cancel != nil
	}
	if len(want) == 0 {
		t.Fatal("프로토콜 표면을 가진 어댑터가 없다")
	}
	// 실측한 사실: omp 만 답 없이 닫는 프레임을 갖는다 (§9.1 U-7).
	if !want["omp"] {
		t.Error("omp 는 Cancel 이 있어야 한다")
	}
	if want["claude"] {
		t.Error("claude 에는 답 없이 닫는 프레임이 없다 — stdin EOF 가 곧 종료다")
	}
	for id, w := range want {
		ad, _ := agentadapter.Get(id)
		got := Controls{
			Interrupt: ad.Proto.Interrupt != nil, Control: ad.Proto.Control != nil,
			TUIResume: ad.Proto.TUIResume != nil, Attachments: ad.Proto.Attachments,
			Cancel: ad.Proto.Cancel != nil,
		}
		if got.Cancel != w {
			t.Errorf("%s: Controls.Cancel=%v, 기대 %v", id, got.Cancel, w)
		}
	}
}
