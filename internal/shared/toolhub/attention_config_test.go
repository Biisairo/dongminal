package toolhub

import (
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/dmenv"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-32 — 데몬의 판정 설정과 시험용 표면 (§3.3a).

func configPM(t *testing.T) *ToolManager {
	t.Helper()
	t.Setenv(dmenv.EnvAttentionBell, "")
	t.Setenv(dmenv.EnvAttentionIdleMS, "0")
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	return m
}

func TestAdoptDetached_CarriesManagerHooks(t *testing.T) {
	m := configPM(t)
	got := make(chan string, 4)
	m.SetAttentionNotifier(func(id, reason string) { got <- id + ":" + reason }, func(id string) { got <- id + ":clear" })
	p := m.AdoptDetached("t1")
	if m.Get("t1") != p {
		t.Fatal("관리자에 실리지 않았다")
	}
	p.ObserveOutput([]byte("\x1b]9;hi\x07"))
	if r := <-got; r != "t1:signaled" {
		t.Fatalf("알림=%q", r)
	}
	p.Attend()
	if r := <-got; r != "t1:clear" {
		t.Fatalf("해제=%q", r)
	}
}

func TestSetAttentionConfig_BellAppliesToExistingTools(t *testing.T) {
	m := configPM(t)
	got := make(chan string, 4)
	m.SetAttentionNotifier(func(_, reason string) { got <- reason }, func(string) {})
	p := m.AdoptDetached("t1")

	p.ObserveOutput([]byte{0x07})
	if p.Attention() {
		t.Fatal("BEL 허용이 꺼진 채 맨 BEL 이 알람을 세웠다")
	}
	m.SetAttentionConfig(0, true)
	p.ObserveOutput([]byte{0x07})
	if !p.Attention() || <-got != "signaled" {
		t.Fatal("BEL 허용이 이미 있는 도구에 적용되지 않았다")
	}
	if q := m.AdoptDetached("t2"); !q.allowBell.Load() {
		t.Fatal("새 도구가 BEL 허용을 받지 않았다")
	}
}

// 문턱 0 으로 시작한 스위퍼도 돈다 — 문턱은 나중에 attnconfig 로 온다.
func TestRunAttentionSweeper_ThresholdGivenLater(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	m := configPM(t)
	got := make(chan string, 4)
	m.SetAttentionNotifier(func(_, reason string) { got <- reason }, func(string) {})

	var now atomic.Int64
	defer stubAttnNow(now.Load)()
	p := m.AdoptDetached("t1")
	p.ReportActivity(activity.Working, "Bash", "", true, true)
	p.SetActivity(activity.Idle, "", "")
	p.ObserveOutput([]byte("x"))

	stop := make(chan struct{})
	defer close(stop)
	tick := make(chan time.Time)
	m.RunAttentionSweeper(stop, tick)

	now.Store(int64(time.Hour))
	tick <- time.Now()
	select {
	case r := <-got:
		t.Fatalf("문턱이 0 인데 울었다: %q", r)
	case <-time.After(50 * time.Millisecond):
	}

	m.SetAttentionConfig(time.Second, false)
	p.ObserveOutput([]byte("x"))
	now.Add(int64(2 * time.Second))
	tick <- time.Now()
	select {
	case r := <-got:
		if r != "idle" {
			t.Fatalf("사유=%q", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("문턱을 준 뒤에도 유휴가 판정되지 않았다")
	}
}
