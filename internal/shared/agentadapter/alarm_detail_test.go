package agentadapter

import "testing"

// V-AEV-15 (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-15): **알람에도 내용이 실린다.**
//
// 종전에는 세 어댑터 전부가 `done`·`waiting` 에서 `Detail` 을 비웠다. 인터페이스가
// 자리를 안 준 것이 아니라 **모든 구현이 그 자리를 안 채운 것**이었고, 그래서
// 데스크톱 알림 본문에 자리(창 · 탭)만 실렸다.
//
// 어댑터마다 싣는 필드가 다르므로(§2.5 의 능력 차이) 한 표로 묶어 고정한다.
func TestAdapters_AlarmCarriesDetail(t *testing.T) {
	cases := []struct {
		name    string
		parse   func([]byte) (Report, bool)
		payload string
		want    string
		state   string
	}{
		{
			name:    "claude waiting — Notification 의 본문",
			parse:   parseClaudeHook,
			payload: `{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}`,
			want:    "Claude needs your permission to use Bash",
			state:   "waiting",
		},
		{
			name:    "codex done — 마지막 어시스턴트 메시지",
			parse:   parseCodexHook,
			payload: `{"type":"agent-turn-complete","last-assistant-message":"빌드를 고쳤다"}`,
			want:    "빌드를 고쳤다",
			state:   "done",
		},
		{
			name:    "omp done — shim 이 실어 보낸 detail",
			parse:   parseOmpHook,
			payload: `{"event":"agent_end","detail":"작업 완료"}`,
			want:    "작업 완료",
			state:   "done",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, ok := tc.parse([]byte(tc.payload))
			if !ok {
				t.Fatalf("파싱하지 못했다: %s", tc.payload)
			}
			if rep.State != tc.state {
				t.Fatalf("State=%q, want %q", rep.State, tc.state)
			}
			if rep.Detail != tc.want {
				t.Fatalf("Detail=%q, want %q — 알람이 무엇에 대한 것인지 말하지 못한다",
					rep.Detail, tc.want)
			}
		})
	}
}

// 내용을 싣지 않는 에이전트도 있다. 없는 필드는 **빈 값**이어야 하며, 그것이 이
// 변경이 종전 동작을 깨지 않는다는 근거다 (FR-AEV-15).
func TestAdapters_MissingDetailStaysEmpty(t *testing.T) {
	rep, ok := parseCodexHook([]byte(`{"type":"agent-turn-complete"}`))
	if !ok || rep.State != "done" {
		t.Fatalf("done 이 아니다: %+v ok=%v", rep, ok)
	}
	if rep.Detail != "" {
		t.Fatalf("Detail=%q, want 빈 값", rep.Detail)
	}
}
