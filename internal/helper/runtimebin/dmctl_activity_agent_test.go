package runtimebin

import (
	"strings"
	"testing"
)

// AGENT_EVENT_ABSTRACTION_SRS V-AEV-4a — 활동 보고의 `agent` 필드.
//
// 서버는 이 값으로 그 에이전트의 **이벤트 선언**을 찾아 `done` 알람의 판정을
// 정한다 (FR-AEV-10·12). 그래서 싣는가 / 싣지 않는가가 곧 알람의 동작이다.

// 활동 보고는 에이전트 id 를 싣는다. 이것이 없으면 서버는 보고자가 턴의 출처를
// 말할 수 있는 에이전트인지 알 수 없고, omp 의 알람이 다시 사라진다.
func TestActivityReportCarriesAgentID(t *testing.T) {
	cap := startCapture(t, "7")
	if code := runDmctlActivity([]string{"omp"}, strings.NewReader(`{"event":"agent_end"}`),
		discard{}, discard{}); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	body := strings.Join(cap.activitySnapshot(), "\n")
	if !strings.Contains(body, `"agent":"omp"`) {
		t.Fatalf("활동 보고에 agent 가 없다 — 알람 판정의 재료가 사라진다 (FR-AEV-10):\n%s", body)
	}
}

// codex 는 **싣지 않는다** (FR-AEV-21). codex 의 알람은 `dmctl notify codex` 가
// 이미 내므로, 여기서 id 를 실으면 `Signals.UserTurn=false` 의 무조건 갈래가
// 알람을 한 번 더 만들어 **같은 턴이 두 번 운다.**
//
// 이 검사가 있는 이유는 그 중복이 조용하기 때문이다 — 두 번 우는 것은 로그에
// 남지 않고 사용자에게만 보인다.
func TestCodexActivityReportOmitsAgentID(t *testing.T) {
	cap := startCapture(t, "7")
	reportNotifyActivity("codex", []string{`{"type":"agent-turn-complete"}`}, "7")
	body := strings.Join(cap.activitySnapshot(), "\n")
	if body == "" {
		t.Fatal("codex 활동 보고가 아예 가지 않았다")
	}
	if strings.Contains(body, `"agent"`) {
		t.Fatalf("codex 보고에 agent 가 실렸다 — notify 와 겹쳐 두 번 운다 (FR-AEV-21):\n%s", body)
	}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
