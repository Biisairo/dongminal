package hub

import (
	"testing"

	"dongminal/internal/shared/toolhub"
)

// 데몬 `Tool` 과 서버 추적기의 BEL 허용은 **같은 근거**로 정해진다
// (HOST_PARITY_SRS 묶음 F, FR-HPR-17).
//
// `attnPaneState.allowBell` 을 설정하는 코드가 없어서 서버 추적기는
// `DONGMINAL_ATTENTION_BELL=1` 을 무성 무시했다. `Tool` 은 읽는다 —
// `attn_tracker.go` 머리말이 스스로 약속한 동형성(FR-ATF-12·NFR-4)이 이 필드에서
// 깨져 있었다 (§2.6).
func TestAttnTrackerHonorsBellSetting(t *testing.T) {
	// V-HPR-10
	t.Setenv("DONGMINAL_ATTENTION_BELL", "1")
	tr := NewAttnTracker(&fakeBroker{}, 0)

	var got string
	tr.onAttention = func(id, reason string) { got = reason }
	tr.FeedOutput("t1", []byte("\a"))

	if got != "signaled" {
		t.Fatalf("BEL 이 알람이 되지 않았다 (reason=%q) — `Tool` 과 갈렸다", got)
	}
}

func TestAttnTrackerBellOffByDefault(t *testing.T) {
	t.Setenv("DONGMINAL_ATTENTION_BELL", "")
	tr := NewAttnTracker(&fakeBroker{}, 0)

	fired := false
	tr.onAttention = func(id, reason string) { fired = true }
	tr.FeedOutput("t1", []byte("\a"))

	if fired {
		t.Fatal("BEL 은 기본으로 알람이 아니다 — 탭 완성 등으로 시끄럽다")
	}
}

// 그 값이 실제로 `Tool` 과 같은 자리에서 온다는 것을 붙든다. 두 벌로 적으면
// 한쪽만 고쳐지는 날이 온다.
func TestAttnTrackerBellMatchesTool(t *testing.T) {
	t.Setenv("DONGMINAL_ATTENTION_BELL", "1")
	tr := NewAttnTracker(&fakeBroker{}, 0)
	if got := tr.state("t1").allowBell; got != toolhub.AttentionAllowBell() {
		t.Fatalf("allowBell = %v, Tool 은 %v", got, toolhub.AttentionAllowBell())
	}
}
