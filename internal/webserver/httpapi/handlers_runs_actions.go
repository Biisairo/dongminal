package httpapi

import (
	"net/http"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
)

// Run 의 동작 답 (SERVER_DRIVEN_ACTIONS_SRS 묶음 R · FR-SDA-60·61).
//
// 목록(`GET /api/runs`)과 그래프(`GET /api/runs/{id}/graph`)의 Run·멤버에 싣는다. 실행 종단은
// 같은 판정 함수로 거절한다 (D-SDA-6).

// runCloseAnswer 는 화면의 종료 버튼의 답이다. 그 버튼은 "지금 멈춘다"(force)이므로 force 의
// 판정이다 (D-SDA-9) — 열린 Run 이면 참이다.
func runCloseAnswer(rec run.Record) action.Answer {
	if _, err := run.CheckClose(rec, true); err != nil {
		return runErrAnswer(err)
	}
	return action.Allow()
}

// runUnreported 는 아직 보고하지 않은 멤버의 수다 — 종료 확인 문구가 말한다 (R-d).
func runUnreported(rec run.Record) int {
	pending, _ := run.CheckClose(rec, true)
	return len(pending)
}

// memberDetachAnswer 는 떼기의 답이다 — 탭에 붙어 있지 않으면 뗄 것이 없다.
func memberDetachAnswer(m run.Member) action.Answer {
	if m.TabID == "" {
		return runErrAnswer(run.ErrMemberNotAttached)
	}
	return action.Allow()
}

func runActions(rec run.Record) map[string]action.Answer {
	return map[string]action.Answer{
		action.RunClose: runCloseAnswer(rec),
		// 서버는 있는 Run 을 언제나 지운다 (R-e).
		action.RunDelete: action.Allow(),
	}
}

func memberActions(m run.Member) map[string]action.Answer {
	return map[string]action.Answer{action.RunMemberDetach: memberDetachAnswer(m)}
}

// runErrAnswer 는 Run 표면의 sentinel 을 답으로 옮긴다. 코드와 상태는 `apierr.Runs` 표다.
func runErrAnswer(err error) action.Answer {
	if status, code, ok := apierr.Runs.Lookup(err); ok {
		return action.Deny(status, code, nil)
	}
	return action.Deny(http.StatusInternalServerError, err.Error(), nil)
}
