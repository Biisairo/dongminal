package httpapi

import (
	"testing"
)

// FR-STA-4a 개정 — 정적 폴백은 어댑터가 훅으로 준비완료를 말하지 **않을 때만**
// 적용한다.
//
// 실측으로 밟은 결함이다. Claude Code 를 멤버로 띄우자 폴더 신뢰 확인 모달이
// 떴는데, 그 상태에서 화면은 조용하고(quietMs=21023) 훅은 아무것도 보고하지
// 않아(state=unknown) 정적 폴백이 **준비완료로 오인**했다 — `dmctl wait --for
// ready` 가 waitedMs=0 으로 rc=0 을 냈다. 거기서 Kickoff 를 보내면 모달이
// 삼킨다. 시작 모달은 시간이 지난다고 풀리지 않으므로, 훅을 주는 에이전트는
// 훅을 기다리다 타임아웃(체크포인트)으로 돌아가는 편이 정직하다.

func quietStatus(state string) toolStatus {
	return toolStatus{ToolID: "t1", Live: true, State: state, QuietMs: readyQuietMS + 5000}
}

func TestEvaluateWait_QuiescenceNotUsedForHookBasedAgents(t *testing.T) {
	st := quietStatus(activityStateUnknown)

	// 훅을 주는 에이전트: 침묵은 근거가 아니다. 계속 기다린다.
	if status, reason, settled := evaluateWait("ready", st, false); settled {
		t.Fatalf("훅 기반 에이전트인데 침묵으로 준비완료 판정했다: status=%q reason=%q", status, reason)
	}
	// 훅이 없는 에이전트: 3단계 폴백이 유일한 근거이므로 유지된다.
	if status, reason, settled := evaluateWait("ready", st, true); !settled || status != "ready" || reason != "quiescence" {
		t.Fatalf("훅 없는 에이전트의 폴백이 사라졌다: status=%q reason=%q settled=%v", status, reason, settled)
	}
}

// 폴백을 끄더라도 훅이 말하면 그대로 판정된다 — 1단계는 영향받지 않는다.
func TestEvaluateWait_HookStillWinsWithFallbackOff(t *testing.T) {
	cases := []struct {
		state, cond, want string
	}{
		{"idle", "ready", "ready"},
		{"done", "ready", "ready"},
		{"done", "done", "done"},
		{"waiting", "ready", "blocked"},
		{"waiting", "done", "blocked"},
	}
	for _, c := range cases {
		status, _, settled := evaluateWait(c.cond, quietStatus(c.state), false)
		if !settled || status != c.want {
			t.Fatalf("state=%q for=%q → %q(settled=%v), want %q", c.state, c.cond, status, settled, c.want)
		}
	}
}

// 침묵은 완료의 근거가 될 수 없다 (FR-STA-4a). 폴백을 켜도 마찬가지다.
func TestEvaluateWait_QuiescenceNeverSettlesDone(t *testing.T) {
	if _, _, settled := evaluateWait("done", quietStatus(activityStateUnknown), true); settled {
		t.Fatal("침묵으로 완료 판정했다")
	}
}

// 도구가 사라진 것은 폴백 여부와 무관하게 즉시 결말이다.
func TestEvaluateWait_GoneSettlesRegardless(t *testing.T) {
	st := quietStatus(activityStateUnknown)
	st.Live = false
	for _, allow := range []bool{true, false} {
		if status, _, settled := evaluateWait("ready", st, allow); !settled || status != "gone" {
			t.Fatalf("allowQuiescence=%v → %q settled=%v", allow, status, settled)
		}
	}
}

// 폴백 적용 여부의 출처는 **Run 멤버의 어댑터 선언**이다. 멤버가 아닌 도구는
// 어떤 에이전트가 도는지 알 수 없으므로 기존 동작(폴백 허용)을 유지한다.
func TestQuiescenceAllowed_FollowsTheMembersAdapter(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")

	// Run 을 모르는 도구 — 폴백 유지 (묶음 R 이전 동작 보존).
	if !s.quiescenceAllowed("tool-b") {
		t.Fatal("멤버가 아닌 도구의 폴백을 꺼서는 안 된다")
	}

	runID := startRun(t, s)
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"w","agent":"claude","id":"tool-a"}`); code != 200 {
		t.Fatalf("멤버 등록 실패: %d %+v", code, out)
	}
	// claude 는 훅으로 준비완료를 말한다 → 폴백을 쓰지 않는다.
	if s.quiescenceAllowed("tool-a") {
		t.Fatal("훅 기반 멤버인데 정적 폴백이 켜져 있다")
	}
}

// 저장소가 없는 배선(Run 미사용)에서는 기존 동작이 그대로여야 한다 (NFR-RUN-1).
func TestQuiescenceAllowed_NoRunStoreKeepsOldBehaviour(t *testing.T) {
	s := &Server{}
	if !s.quiescenceAllowed("anything") {
		t.Fatal("Run 을 쓰지 않는 경로의 동작이 바뀌었다")
	}
}
