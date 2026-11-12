package runtimebin

import (
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-70 — 활동 보고가 브리지의 곁들이 값을 싣는다 (FR-TGB-80·81).

func TestActivityReportCarriesBridgeFields(t *testing.T) {
	cap := startCapture(t, "7")
	payload := `{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_9","session_id":"s1","transcript_path":"/t/s1.jsonl",` +
		`"tool_input":{"questions":[{"question":"색?","options":[{"label":"red"}]}]}}`
	if code := runDmctlActivity([]string{"claude"}, strings.NewReader(payload), discard{}, discard{}); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	body := strings.Join(cap.activitySnapshot(), "\n")
	for _, want := range []string{`"hook":"PreToolUse"`, `"toolUseId":"toolu_9"`, `"transcript":"/t/s1.jsonl"`, `"input":{"questions":[{"question":"색?"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("활동 보고에 %s 가 없다:\n%s", want, body)
		}
	}
}

// 값이 없는 훅은 그 필드를 싣지 않는다. 빈 값을 실으면 서버가 "있는데 비었다" 로 읽는다.
func TestActivityReportOmitsEmptyBridgeFields(t *testing.T) {
	cap := startCapture(t, "7")
	if code := runDmctlActivity([]string{"claude"}, strings.NewReader(`{"hook_event_name":"Stop"}`), discard{}, discard{}); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	body := strings.Join(cap.activitySnapshot(), "\n")
	if !strings.Contains(body, `"hook":"Stop"`) {
		t.Fatalf("hook 이 없다:\n%s", body)
	}
	for _, no := range []string{`"toolUseId"`, `"input"`, `"inputOver"`, `"source"`, `"transcript"`} {
		if strings.Contains(body, no) {
			t.Fatalf("빈 값 %s 가 실렸다:\n%s", no, body)
		}
	}
}
