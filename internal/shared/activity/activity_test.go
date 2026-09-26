package activity_test

import (
	"reflect"
	"testing"

	"dongminal/internal/shared/activity"
)

// FR-OPT-10-1 (SHR-14): 어휘는 다섯이고 값은 훅 표면의 것과 한 글자도 다르지 않다.
func TestStates(t *testing.T) {
	want := []string{"working", "waiting", "done", "idle", "ended"}
	if got := activity.States(); !reflect.DeepEqual(got, want) {
		t.Fatalf("States() = %v, want %v", got, want)
	}
	for _, s := range want {
		if !activity.Valid(s) {
			t.Errorf("Valid(%q) = false", s)
		}
	}
	for _, s := range []string{"", "Working", "busy", "ready"} {
		if activity.Valid(s) {
			t.Errorf("Valid(%q) = true", s)
		}
	}
}

// States 는 부를 때마다 새 조각이다 — 받은 쪽이 고쳐도 어휘가 바뀌지 않는다.
func TestStatesCopy(t *testing.T) {
	s := activity.States()
	s[0] = "x"
	if activity.States()[0] != activity.Working {
		t.Fatal("States() 가 내부 조각을 내줬다")
	}
}
