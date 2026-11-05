package gitapi

import (
	"net/http"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// TC-SDA-1 (GR-2b·c): 상태 사실 판정의 표 시험.
func TestFactAnswers(t *testing.T) {
	one := []query.FileEntry{{Path: "a"}}
	cases := []struct {
		name string
		got  action.Answer
		why  string // "" 이면 참
	}{
		{"stash.new · 변경 없음", stashNewAnswer(query.Status{}), apierr.CodeNothingToStash},
		{"stash.new · untracked 만", stashNewAnswer(query.Status{Untracked: one}), ""},
		{"stash.new · staged", stashNewAnswer(query.Status{Staged: one}), ""},
		{"reset · 커밋 없음", resetAnswer(query.Status{Initial: true}), apierr.CodeNoHead},
		{"reset · 커밋 있음", resetAnswer(query.Status{}), ""},
		{"clean · untracked 없음", cleanAnswer(query.Status{Changes: one}), apierr.CodeNothingToClean},
		{"clean · untracked 있음", cleanAnswer(query.Status{Untracked: one}), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.got.OK != (c.why == "") || c.got.Why != c.why {
				t.Fatalf("answer = %+v, want why=%q", c.got, c.why)
			}
			if !c.got.OK && c.got.Status != http.StatusConflict {
				t.Fatalf("status = %d, want 409", c.got.Status)
			}
		})
	}
}

// GR-2d: 셋은 1층이다 — status 응답의 같은 status 로 판정한다.
func TestStatusActions_Facts(t *testing.T) {
	cases := []struct {
		name   string
		status string
		want   map[string]string // 동작 → 사유("" 이면 참)
	}{
		{"깨끗함", gitCleanStatus(), map[string]string{
			action.GitStashNew: apierr.CodeNothingToStash, action.GitUncommittedClean: apierr.CodeNothingToClean,
			action.GitUncommittedReset: ""}},
		{"untracked 만", gitUntrackedStatus(), map[string]string{
			action.GitStashNew: "", action.GitUncommittedClean: "", action.GitUncommittedReset: ""}},
		{"커밋 없음", gitInitialStatus(), map[string]string{action.GitUncommittedReset: apierr.CodeNoHead}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitM5Fake(t)
			f.status = c.status
			s := gitM5Server(t, f)
			_, acts := statusActions(t, s, "")
			for id, why := range c.want {
				a, _ := acts[id].(map[string]any)
				if a == nil {
					t.Fatalf("%s 의 답이 없다", id)
				}
				if a["ok"] != (why == "") || (why != "" && a["why"] != why) {
					t.Errorf("%s = %v, want why=%q", id, a, why)
				}
				if why != "" && !action.Catalog.MayGive(id, why) {
					t.Errorf("%s 가 동작 목록에 %s 를 갖지 않는다", id, why)
				}
			}
		})
	}
}

// TC-SDA-1 (D-SDA-6): 답이 거짓이면 실행이 같은 코드로, 문구 없이 거절된다.
func TestFactAnswers_MatchRejection(t *testing.T) {
	cases := []struct {
		name, status, id, path, body string
	}{
		{"clean", gitCleanStatus(), action.GitUncommittedClean, "/api/git/uncommitted/clean",
			`{"repo":` + qWorkRepo + `,"confirm":true,"paths":["u.txt"]}`},
		{"reset", gitInitialStatus(), action.GitUncommittedReset, "/api/git/uncommitted/reset",
			`{"repo":` + qWorkRepo + `}`},
		{"stash", gitCleanStatus(), action.GitStashNew, "/api/git/stash/push",
			`{"repo":` + qWorkRepo + `,"includeUntracked":true}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitM5Fake(t)
			f.status = c.status
			s := gitM5Server(t, f)
			_, acts := statusActions(t, s, "")
			a, _ := acts[c.id].(map[string]any)
			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if a["ok"] != false || code != http.StatusConflict || out["error"] != a["why"] {
				t.Fatalf("답 %v · 실행 %d %v — 같은 코드로 거절돼야 한다", a, code, out["error"])
			}
			if _, has := out["message"]; has {
				t.Fatalf("서버가 문구를 실었다 (D-SDA-5): %v", out["message"])
			}
			if len(f.wrote()) != 0 {
				t.Fatalf("실행됐다: %v", f.wrote())
			}
		})
	}
}

// GR-2a: 칸이 먼저다 — index 잡이 돌면 상태 사실과 무관하게 job_busy.
func TestFactAnswers_SlotFirst(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("pull 시작 = %d %v", code, out)
	}
	_, acts := statusActions(t, s, "")
	for _, id := range []string{action.GitStashNew, action.GitUncommittedReset, action.GitUncommittedClean} {
		a, _ := acts[id].(map[string]any)
		if a == nil || a["ok"] != false || a["why"] != apierr.CodeJobBusy {
			t.Errorf("%s = %v, want job_busy", id, a)
		}
	}
}
