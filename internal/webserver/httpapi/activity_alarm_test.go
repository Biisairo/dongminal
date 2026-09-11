package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// AGENT_EVENT_ABSTRACTION_SRS 묶음 A — 알람을 활동 이벤트에서 파생한다
// (V-AEV-1~6).
//
// 접수한 증상은 하나다: **omp 는 상태가 바뀌는데 알람이 울리지 않는다.** 원인은
// omp 가 아니라 배선이 에이전트마다 손으로 쓰여 있다는 것이었다 (SRS §2.1).

// activityPost 는 `dmctl activity` 가 보내는 본문 하나다. `agent` 가 실리는 것이
// 이 문서가 더하는 자리다 — 서버가 그 에이전트의 **이벤트 선언**을 볼 수 있어야
// `FR-AEV-12` 를 판정할 수 있다.
func activityPost(t *testing.T, s *Server, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(body)))
	return rec.Code
}

func alarmTool(t *testing.T) (*Server, *toolhub.Tool) {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	var mu sync.Mutex
	var events []string
	p := newActivityPane("1", &mu, &events)
	m.Adopt(p)
	return &Server{Deps: Deps{Tools: m}}, p
}

// V-AEV-1: **접수한 증상 그대로.** omp 가 턴을 시작했다가 끝내면 알람이 선다.
// 지금 코드에서는 서지 않는다 — omp shim 은 `dmctl notify` 를 보내지 않는다.
func TestActivityAlarm_OmpDoneRaises(t *testing.T) {
	s, p := alarmTool(t)
	activityPost(t, s, `{"toolId":"1","agent":"omp","state":"working","userPrompt":true}`)
	if p.Attention() {
		t.Fatal("일을 시작했을 뿐인데 알람이 섰다")
	}
	activityPost(t, s, `{"toolId":"1","agent":"omp","state":"done"}`)
	if !p.Attention() {
		t.Fatal("omp 가 턴을 끝냈는데 알람이 서지 않았다 — 접수한 증상이 이것이다 (FR-AEV-10)")
	}
}

// V-AEV-2: claude 도 `notify` 없이 활동 보고만으로 같게 동작한다 (FR-AEV-20).
func TestActivityAlarm_ClaudeDoneRaisesWithoutNotify(t *testing.T) {
	s, p := alarmTool(t)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"working","userPrompt":true}`)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"done"}`)
	if !p.Attention() {
		t.Fatal("claude 의 done 이 알람이 되지 않았다")
	}
}

// V-AEV-3: **FR-ATN-4 는 무변경이다.** 사용자 턴이 아니었던 턴의 종료는 사건이
// 아니다 — 배경 알림이 깨운 턴이 그 자리이며, 그것을 알람으로 읽던 것이
// `FR-ATN-3a` 가 고친 결함이다.
func TestActivityAlarm_DoneWithoutUserTurnIsSilent(t *testing.T) {
	s, p := alarmTool(t)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"working"}`) // userPrompt 없음
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"done"}`)
	if p.Attention() {
		t.Fatal("사용자 턴이 아니었는데 알람이 섰다 — FR-ATN-4 가 깨졌다")
	}
}

// V-AEV-4: 턴 출처 이벤트가 **없는** 에이전트의 done 은 무조건 알람이다
// (FR-AEV-12). codex 가 그 자리다 — 모르는 것을 "아니다" 로 읽으면 영원히 침묵한다.
func TestActivityAlarm_UnknownTurnOriginAlwaysRaises(t *testing.T) {
	s, p := alarmTool(t)
	activityPost(t, s, `{"toolId":"1","agent":"codex","state":"done"}`)
	if !p.Attention() {
		t.Fatal("codex 의 done 이 조용하다 — 턴 출처를 모르는 것과 아닌 것은 다르다 (FR-CBG-5)")
	}
}

// V-AEV-5: waiting 의 규칙은 무변경이다 (FR-ATN-6·15) — 턴이 진행 중일 때만이고,
// 되풀이는 한 번만 운다.
func TestActivityAlarm_WaitingRulesUnchanged(t *testing.T) {
	s, p := alarmTool(t)
	// 턴이 진행 중이 아니면 입력 유휴다 — 알람이 아니다.
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"waiting"}`)
	if p.Attention() {
		t.Fatal("턴이 진행 중이 아닌데 waiting 이 알람이 됐다 (FR-ATN-6)")
	}
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"working","userPrompt":true}`)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"waiting"}`)
	if !p.Attention() {
		t.Fatal("권한 요청이 알람이 되지 않았다")
	}
	// 되풀이는 새 사건이 아니다 — 주목으로 내린 뒤에도 다시 서지 않는다.
	p.Attend()
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"waiting"}`)
	if p.Attention() {
		t.Fatal("같은 대기가 두 번 울었다 (FR-ATN-15)")
	}
}

// V-AEV-6: 같은 사건이 두 경로로 와도 알람은 **한 번**이다 (FR-AEV-13).
// claude 의 배선을 걷는 동안 둘이 겹쳐 도는 판이 있을 수 있고, 소비 의미론이
// 그것을 흡수해야 한다.
func TestActivityAlarm_NotifyAndActivityRaiseOnce(t *testing.T) {
	s, p := alarmTool(t)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"working","userPrompt":true}`)
	activityPost(t, s, `{"toolId":"1","agent":"claude","state":"done"}`)
	if !p.Attention() {
		t.Fatal("첫 알람이 서지 않았다")
	}
	p.Attend() // 사용자가 보았다 — 알람이 내려간다
	// 같은 사건의 다른 경로(`dmctl notify done`)가 뒤늦게 도착한다.
	p.SignalAttention("done")
	if p.Attention() {
		t.Fatal("같은 done 이 두 번 울었다 — 표시가 소비되지 않았다 (FR-AEV-13)")
	}
}
