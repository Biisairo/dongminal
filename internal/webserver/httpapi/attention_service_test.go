package httpapi

import (
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// FR-OPT-9-3 (HTTP-13): attention/activity 종단은 모드를 묻지 않는다 — 서버가 고른
// attentionService 하나를 부른다. 모드 판정은 attention() 한 자리다.
func TestAttentionService_PicksByMode(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	tr := hub.NewAttnTracker(hub.NewCommandHub(), 0)

	if _, ok := (&Server{Deps: Deps{Tools: m, AttnTracker: tr}}).attention().(trackerAttention); !ok {
		t.Fatal("AttnTracker 가 있으면 데몬 모드 서비스여야 한다")
	}
	if _, ok := (&Server{Deps: Deps{Tools: m}}).attention().(directAttention); !ok {
		t.Fatal("AttnTracker 가 없으면 직접 모드 서비스여야 한다")
	}
}

// 도구 허브가 없을 때의 종전 동작: 목록은 빈 배열, 신호·해제·보고는 무동작.
func TestAttentionService_DirectWithoutTools(t *testing.T) {
	a := (&Server{}).attention()
	if ids := a.AttentionIDs(); ids == nil || len(ids) != 0 {
		t.Fatalf("AttentionIDs = %#v, want []", ids)
	}
	if acts := a.ActivitySnapshot(); acts == nil || len(acts) != 0 {
		t.Fatalf("ActivitySnapshot = %#v, want []", acts)
	}
	a.SignalAttention("x", "r")
	a.Attend("x", true)
	a.ReportActivity("x", "done", "", "", true, true)
	a.Forget("x")
	if a.ClearAllAttention() != 0 || a.Activity("x") != nil || a.LastOutputAt("x") != 0 {
		t.Fatal("도구 허브 없이 상태가 생겼다")
	}
}

// 데몬 모드의 신호는 모르는 도구에 무동작이다(존재를 먼저 본다). 해제는 보지 않는다 —
// 해제가 SSE 보다 먼저 닿을 수 있어서 추적기가 상태를 만들어 둔다.
func TestAttentionService_TrackerSignalChecksExistence(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	tr := hub.NewAttnTracker(hub.NewCommandHub(), 0)
	a := (&Server{Deps: Deps{Tools: m, AttnTracker: tr}}).attention()
	a.SignalAttention("ghost", "done")
	if tr.Attention("ghost") {
		t.Fatal("모르는 도구에 주의가 섰다")
	}
}
