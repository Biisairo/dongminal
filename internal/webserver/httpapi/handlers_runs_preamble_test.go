package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

// 묶음 P — 프리앰블의 서버 계층 (RUN_ORCHESTRATION_SRS FR-PRE-1/3/4).

// FR-PRE-1: 멤버 생성 응답이 프리앰블을 함께 낸다. 조정자가 uuid 를 손으로
// 옮겨 적을 일이 없어야 그 계열의 결함이 사라진다.
func TestApiRunMember_ReturnsAssembledPreamble(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)

	code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+jsonQ(runID)+`,"role":"writer","agent":"claude","id":"tool-b","brief":"초안을 쓴다"}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	p, _ := out["preamble"].(string)
	if p == "" {
		t.Fatalf("프리앰블이 응답에 없다: %+v", out)
	}
	memberID, _ := out["id"].(string)
	for _, want := range []string{runID, memberID, "tool-a", "초안을 쓴다", "dmctl run report"} {
		if !strings.Contains(p, want) {
			t.Fatalf("프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
	if out["brief"] != "초안을 쓴다" {
		t.Fatalf("brief 가 기록되지 않았다: %+v", out)
	}
}

// FR-PRE-1: 프리앰블은 재조회 가능해야 한다 — 붙여넣기가 실패했거나 조정자가
// 컨텍스트를 잃었을 때 기록에서 같은 텍스트를 다시 만들 수 있어야 한다.
func TestApiRunPreamble_IsRederivableFromTheRecord(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)
	_, created := postRun(t, s, "/api/runs/members",
		`{"runId":`+jsonQ(runID)+`,"role":"writer","agent":"claude","id":"tool-b","brief":"초안을 쓴다"}`)
	memberID, _ := created["id"].(string)

	code, out := getRun(t, s, "/api/runs/preamble?member="+memberID)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	if out["preamble"] != created["preamble"] {
		t.Fatalf("재조회 결과가 생성 시점과 다르다:\n%v\n---\n%v", out["preamble"], created["preamble"])
	}
	for _, k := range []string{"runId", "memberId", "agent", "tabId"} {
		if out[k] == nil || out[k] == "" {
			t.Fatalf("%q 가 응답에 없다 — 조정자가 location 으로 쓴다: %+v", k, out)
		}
	}
}

// 알 수 없는 멤버는 열거된 사유로 거부한다. 조용한 성공도, 빈 프리앰블도 아니다.
func TestApiRunPreamble_UnknownMemberIsRefused(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	code, out := getRun(t, s, "/api/runs/preamble?member=no-such")
	if code == http.StatusOK {
		t.Fatalf("없는 멤버가 성공했다: %+v", out)
	}
	if code != http.StatusNotFound {
		t.Fatalf("조회 실패는 404 여야 한다: %d", code)
	}
	// 보고 권한의 사유(sender_not_member)를 재사용하면 조정자가 권한 문제로 오진한다.
	if out["error"] != "unknown_member" {
		t.Fatalf("거부 사유가 조회 실패를 가리키지 않는다: %+v", out)
	}
}

// TC-ADP-2 / FR-ADP-3: 알 수 없는 에이전트 id 는 기록 경계에서 거부된다.
// 조용히 성공하거나 기본 에이전트로 폴백하지 않는다.
func TestApiRunMember_UnknownAgentIsRefused(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)

	code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+jsonQ(runID)+`,"role":"writer","agent":"gpt-9","id":"tool-b"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("알 수 없는 에이전트 want 400, got %d (%+v)", code, out)
	}
	detail, _ := out["detail"].(string)
	if !strings.Contains(detail, "gpt-9") || !strings.Contains(detail, "claude") {
		t.Fatalf("무엇이 틀렸고 무엇이 가능한지 말하지 않는다: %+v", out)
	}
	// 거부됐으면 도구가 묶여서도 안 된다 — 같은 도구로 다시 등록할 수 있어야 한다.
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+jsonQ(runID)+`,"role":"writer","agent":"claude","id":"tool-b"}`); code != http.StatusOK {
		t.Fatalf("거부된 시도가 도구를 묶어 버렸다: %d (%+v)", code, out)
	}
}

// 목록·상태 조회에는 프리앰블을 싣지 않는다 — 멤버 수만큼 응답이 부풀고,
// 그 조회의 쓰임(누가 무엇을 하고 있나)과 무관하다.
func TestApiRunStatus_OmitsPreamble(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)
	_, _ = postRun(t, s, "/api/runs/members",
		`{"runId":`+jsonQ(runID)+`,"role":"writer","agent":"claude","id":"tool-b","brief":"초안"}`)

	_, out := getRun(t, s, "/api/runs?id="+runID)
	members, _ := out["members"].([]any)
	if len(members) != 1 {
		t.Fatalf("멤버가 조회되지 않았다: %+v", out)
	}
	m, _ := members[0].(map[string]any)
	if _, has := m["preamble"]; has {
		t.Fatalf("상태 조회에 프리앰블이 실렸다: %+v", m)
	}
}
