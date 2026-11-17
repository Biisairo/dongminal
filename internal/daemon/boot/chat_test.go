package boot

import (
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
)

// PEER_CHAT_SRS §3.10 (FR-PCH-61): 쉬는 중은 idle·done 뿐이다. 보고가 없으면 쉬는 중이 아니다.
func TestResting(t *testing.T) {
	for state, want := range map[string]bool{
		activity.Idle: true, activity.Done: true,
		activity.Working: false, activity.Waiting: false, activity.Ended: false,
	} {
		if got := resting(&toolhub.ActivityState{State: state}); got != want {
			t.Fatalf("%s: %v, want %v", state, got, want)
		}
	}
	if resting(nil) {
		t.Fatal("보고 없음을 쉬는 중으로 봤다")
	}
}
