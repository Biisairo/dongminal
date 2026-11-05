package gitapi

import (
	"net/http"
	"net/url"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/jobs"
)

// fakeSlots 는 칸 이름 → 그 칸을 쥔 잡이다. 키는 보지 않는다.
type fakeSlots map[string]string

func (f fakeSlots) IndexBusy(string) (string, bool)  { id, ok := f[jobs.SlotIndex]; return id, ok }
func (f fakeSlots) CommonBusy(string) (string, bool) { id, ok := f[jobs.SlotCommon]; return id, ok }

// TC-SDA-1 (GR-1a): 칸 판정의 표 시험.
func TestSlotsAnswer(t *testing.T) {
	k := jobs.Keys{Top: "/top", Common: "/common"}
	cases := []struct {
		name  string
		busy  []string // 잡이 쥔 칸
		slots []string // 동작이 쓰는 칸
		ok    bool
	}{
		{"비어 있음", nil, []string{jobs.SlotIndex}, true},
		{"index 바쁨 · index 동작", []string{jobs.SlotIndex}, []string{jobs.SlotIndex}, false},
		{"common 바쁨 · index 동작", []string{jobs.SlotCommon}, []string{jobs.SlotIndex}, true},
		{"common 바쁨 · 두 칸 동작", []string{jobs.SlotCommon}, []string{jobs.SlotIndex, jobs.SlotCommon}, false},
		{"index 바쁨 · common 동작", []string{jobs.SlotIndex}, []string{jobs.SlotCommon}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := fakeSlots{}
			for _, s := range c.busy {
				x[s] = "j1"
			}
			a := slotsAnswer(x, k, c.slots...)
			if a.OK != c.ok {
				t.Fatalf("answer = %+v, want ok=%v", a, c.ok)
			}
			if !a.OK && (a.Why != apierr.CodeJobBusy || a.Status != http.StatusConflict) {
				t.Fatalf("answer = %+v, want 409 job_busy", a)
			}
		})
	}
}

func statusActions(t *testing.T, s *GitServer, query string) (map[string]any, map[string]any) {
	t.Helper()
	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo)+query, "")
	if code != http.StatusOK {
		t.Fatalf("status = %d %v", code, out)
	}
	acts, _ := out["actions"].(map[string]any)
	if acts == nil {
		t.Fatalf("status 응답에 actions 가 없다: %v", out)
	}
	return out, acts
}

func wantAnswers(t *testing.T, acts map[string]any, want map[string]bool) {
	t.Helper()
	for id, ok := range want {
		a, _ := acts[id].(map[string]any)
		if a == nil {
			t.Errorf("%s 의 답이 없다", id)
			continue
		}
		if a["ok"] != ok {
			t.Errorf("%s = %v, want ok=%v", id, a, ok)
		}
		if !ok && a["why"] != apierr.CodeJobBusy {
			t.Errorf("%s why = %v, want job_busy", id, a["why"])
		}
		if !ok && !action.Catalog.MayGive(id, apierr.CodeJobBusy) {
			t.Errorf("%s 가 동작 목록에 job_busy 를 갖지 않는다", id)
		}
	}
}

// TC-SDA-5 (GR-1b·c): 1층 답은 칸 상태를 따른다 — fetch 가 도는 동안 common 칸 동작은
// 꺼지고 index 칸 동작은 켜져 있다.
func TestStatusActions_FollowSlots(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)

	_, idle := statusActions(t, s, "")
	wantAnswers(t, idle, map[string]bool{
		action.GitFetch: true, action.GitPull: true, action.GitPush: true, action.GitWrite: true,
		action.GitLockRemove: true, action.GitWorktreeCreate: true,
		action.GitSubmoduleUpdate: true, action.GitTagPush: true, action.GitTagDeleteRemote: true,
	})

	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("fetch 시작 = %d %v", code, out)
	}
	_, busy := statusActions(t, s, "")
	wantAnswers(t, busy, map[string]bool{
		action.GitFetch: false, action.GitPull: false, action.GitPush: false, action.GitWrite: true,
		action.GitLockRemove: false, action.GitWorktreeCreate: false,
		action.GitSubmoduleUpdate: false, action.GitTagPush: false, action.GitTagDeleteRemote: false,
	})
}

// GR-1b: pull 은 두 칸을 쥔다 — 동기 쓰기도 꺼진다.
func TestStatusActions_PullHoldsBoth(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("pull 시작 = %d %v", code, out)
	}
	_, acts := statusActions(t, s, "")
	wantAnswers(t, acts, map[string]bool{
		action.GitWrite: false, action.GitFetch: false, action.GitPush: false,
	})
}

// GR-1c: 잡 상태는 mark 밖이다 — unchanged 응답에도 actions 가 실린다.
func TestStatusActions_InUnchanged(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	out, _ := statusActions(t, s, "")
	mark, _ := out["mark"].(string)
	if mark == "" {
		t.Fatalf("mark 가 없다: %v", out)
	}
	if code, o := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("fetch 시작 = %d %v", code, o)
	}
	again, acts := statusActions(t, s, "&ifMark="+url.QueryEscape(mark))
	if again["unchanged"] != true {
		t.Fatalf("unchanged 응답이 아니다: %v", again)
	}
	wantAnswers(t, acts, map[string]bool{action.GitFetch: false, action.GitWrite: true})
}

// TC-SDA-1 (D-SDA-6): 답이 거짓이면 실행이 같은 코드로 거절된다 — 동기 쓰기·잡 시작·
// lock 지우기 대표 셋.
func TestStatusActions_MatchRejection(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("pull 시작 = %d %v", code, out)
	}
	_, acts := statusActions(t, s, "")
	for _, c := range []struct{ id, path, body string }{
		{action.GitWrite, "/api/git/stage", exclStageBody},
		{action.GitFetch, "/api/git/fetch", `{"repo":` + qWorkRepo + `}`},
		{action.GitLockRemove, "/api/git/lock/remove", lockRemoveBody(`,"confirm":true,"mtimeUnixMs":1`)},
	} {
		a, _ := acts[c.id].(map[string]any)
		code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
		if a["ok"] != false || code != http.StatusConflict || out["error"] != a["why"] {
			t.Errorf("%s: 답 %v · 실행 %d %v — 같은 코드로 거절돼야 한다", c.id, a, code, out["error"])
		}
	}
}
