package agentrec

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/statusline"
)

// AGENT_RECORD_DAEMON_SRS §3.2a — 데몬과 서버가 함께 쓰는 보고 해석.

func TestSocketPath_BesideDaemonSocket(t *testing.T) {
	home := filepath.Join("x", "home")
	want := filepath.Join(filepath.Dir(platform.Current().IPC.Endpoint(home)), SocketFile)
	if got := SocketPath(home); got != want {
		t.Fatalf("SocketPath = %q, want %q", got, want)
	}
}

func TestKnownMethod_OnlyFour(t *testing.T) {
	for _, m := range []string{MethodActivity, MethodUsage, MethodSubagents, MethodNotify} {
		if !KnownMethod(m) {
			t.Fatalf("%s 를 모른다", m)
		}
	}
	for _, m := range []string{"", "write", "report.write", "recordset"} {
		if KnownMethod(m) {
			t.Fatalf("%q 를 받는다", m)
		}
	}
}

// NFR-AAP-3: 제어 문자를 지우고 길이를 묶는다. 글자 중간을 끊지 않는다 (IPC-27).
func TestSanitize(t *testing.T) {
	in := "a" + string(rune(0x07)) + "b" + string(rune(0x7f)) + "c"
	if got := Sanitize(in, DetailMax); got != "abc" {
		t.Fatalf("제어 문자가 남았다: %q", got)
	}
	if got := Sanitize(strings.Repeat("x", DetailMax+88), DetailMax); len(got) != DetailMax {
		t.Fatalf("len = %d, want %d", len(got), DetailMax)
	}
	got := Sanitize(strings.Repeat("가", 200), DetailMax)
	if !utf8.ValidString(got) || len(got) != 510 {
		t.Fatalf("len = %d valid=%v, want 510", len(got), utf8.ValidString(got))
	}
	if got := Sanitize("abc", 2); got != "ab" {
		t.Fatalf("ASCII = %q", got)
	}
}

func TestNotifyReason_DefaultsToSignaled(t *testing.T) {
	if NotifyReason("") != "signaled" || NotifyReason("done") != "done" {
		t.Fatal("사유의 기본값이 틀렸다")
	}
}

func TestValidSubagentState(t *testing.T) {
	for _, s := range []string{activity.Working, activity.Waiting, activity.Done} {
		if !ValidSubagentState(s) {
			t.Fatalf("%s 를 거절한다", s)
		}
	}
	for _, s := range []string{activity.Idle, activity.Ended, "x"} {
		if ValidSubagentState(s) {
			t.Fatalf("%s 를 받는다", s)
		}
	}
}

// FR-ASV-11: 도구마다 상한을 넘으면 가장 오래 갱신되지 않은 것을 버린다.
func TestPutSubagentActivity_CapsOldestOut(t *testing.T) {
	base := time.Unix(1000, 0)
	var m map[string]SubagentActivity
	for i := 0; i <= statusline.SubagentMaxTasks; i++ {
		m = PutSubagentActivity(m, string(rune('A'+i)), SubagentActivity{State: activity.Working}, base.Add(time.Duration(i)*time.Second))
	}
	if len(m) != statusline.SubagentMaxTasks {
		t.Fatalf("len = %d, want %d", len(m), statusline.SubagentMaxTasks)
	}
	if _, ok := m["A"]; ok {
		t.Fatal("가장 오래된 A 가 남았다")
	}
	if got := m[string(rune('A'+statusline.SubagentMaxTasks))].UpdatedAt; !got.Equal(base.Add(time.Duration(statusline.SubagentMaxTasks) * time.Second)) {
		t.Fatalf("UpdatedAt = %v", got)
	}
}

// FR-ASV-20: 비어 있지 않은 한도만 그 에이전트의 값을 덮는다. 다른 에이전트는 남는다.
func TestMergeLimits(t *testing.T) {
	pct := 40.0
	w := map[string]statusline.RateWindow{"five_hour": {UsedPct: &pct}}
	at := time.UnixMilli(5000)
	m := MergeLimits(map[string]LimitRecord{"other": {ObservedAt: 1}}, "claude-x", w, at)
	if got := m["claude-x"]; got.ObservedAt != 5000 || got.Windows["five_hour"].UsedPct == nil {
		t.Fatalf("합친 값 = %+v", got)
	}
	if _, ok := m["other"]; !ok {
		t.Fatal("다른 에이전트의 한도가 사라졌다")
	}
	if got := MergeLimits(m, "claude-x", nil, time.UnixMilli(9000)); got["claude-x"].ObservedAt != 5000 {
		t.Fatal("빈 한도가 값을 덮었다")
	}
}

// 기록 값의 JSON 모양은 단계 1 의 것과 같아야 한다 — 이미 데몬에 쓰인 값을 읽는다.
func TestRecordShapes_KeepStage1JSON(t *testing.T) {
	raw, _ := json.Marshal(SubagentList{ObservedAt: 7})
	if string(raw) != `{"tasks":null,"observedAt":7}` {
		t.Fatalf("SubagentList = %s", raw)
	}
	raw, _ = json.Marshal(LimitRecord{ObservedAt: 7})
	if string(raw) != `{"windows":null,"observedAt":7}` {
		t.Fatalf("LimitRecord = %s", raw)
	}
	raw, _ = json.Marshal(SubagentActivity{State: "done", UpdatedAt: time.Unix(0, 0).UTC()})
	if string(raw) != `{"state":"done","updatedAt":"1970-01-01T00:00:00Z"}` {
		t.Fatalf("SubagentActivity = %s", raw)
	}
	raw, _ = json.Marshal(Usage{ObservedAt: 7})
	if !strings.HasSuffix(string(raw), `"observedAt":7}`) {
		t.Fatalf("Usage = %s", raw)
	}
}

func TestUsageContextTokens(t *testing.T) {
	var u Usage
	if _, ok := u.ContextTokens(); ok {
		t.Fatal("값이 없는데 ok")
	}
	a, b := 10.0, 5.0
	u.ContextWindow = &statusline.ContextWindow{CurrentUsage: &statusline.CurrentUsage{InputTokens: &a, CacheReadInputTokens: &b}}
	if got, ok := u.ContextTokens(); !ok || got != 15 {
		t.Fatalf("ContextTokens = %v %v", got, ok)
	}
}
