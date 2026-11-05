package gitapi

import (
	"net/http"
	"net/url"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// TC-SDA-1 (FR-SDA-24 · M-3): stash 만들기 판정의 표 시험.
func TestStashCreateAnswer(t *testing.T) {
	one := []query.FileEntry{{Path: "a"}}
	cases := []struct {
		name      string
		st        query.Status
		untracked bool
		ok        bool
		why       string
		args      map[string]any
	}{
		{"staged", query.Status{Staged: one}, false, true, "", nil},
		{"changes", query.Status{Changes: one}, false, true, "", nil},
		{"conflicts", query.Status{Conflicts: one}, false, true, "", nil},
		{"untracked 만 · -u 켬", query.Status{Untracked: one}, true, true, "", nil},
		{"untracked 만 · -u 끔", query.Status{Untracked: []query.FileEntry{{Path: "a"}, {Path: "b"}}}, false, false,
			apierr.CodeUntrackedOnly, map[string]any{"count": 2}},
		{"변경 없음 · -u 끔", query.Status{}, false, false, apierr.CodeNothingToStash, nil},
		{"변경 없음 · -u 켬", query.Status{}, true, false, apierr.CodeNothingToStash, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := stashCreateAnswer(c.st, c.untracked)
			if a.OK != c.ok || a.Why != c.why {
				t.Fatalf("answer = %+v, want ok=%v why=%q", a, c.ok, c.why)
			}
			if c.args != nil && a.Args["count"] != c.args["count"] {
				t.Fatalf("args = %v, want %v", a.Args, c.args)
			}
			if !a.OK {
				if a.Status != http.StatusConflict {
					t.Fatalf("status = %d, want 409 (상태 때문)", a.Status)
				}
				if !action.Catalog.MayGive(action.GitStashCreate, a.Why) {
					t.Fatalf("사유 %q 가 동작 목록에 없다", a.Why)
				}
			}
		})
	}
}

func stashAnswerPath(includeUntracked string) string {
	return "/api/git/actions?repo=" + url.QueryEscape(absWorkRepo) +
		"&action=" + action.GitStashCreate + "&includeUntracked=" + includeUntracked
}

// TC-SDA-1 (FR-SDA-3 · D-SDA-6): 같은 입력에서 답이 거짓이면 실행이 **같은 코드**로
// 거절된다. 답이 참이면 실행이 거절되지 않는다.
func TestStashCreateAnswerMatchesRejection(t *testing.T) {
	cases := []struct {
		name      string
		status    string
		untracked bool
		why       string
	}{
		{"변경 없음", gitCleanStatus(), false, apierr.CodeNothingToStash},
		{"untracked 만 · -u 끔", gitUntrackedStatus(), false, apierr.CodeUntrackedOnly},
		{"untracked 만 · -u 켬", gitUntrackedStatus(), true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitM5Fake(t)
			f.status = c.status
			s := gitM5Server(t, f)

			flag, body := "0", `{"repo":`+qWorkRepo+`}`
			if c.untracked {
				flag, body = "1", `{"repo":`+qWorkRepo+`,"includeUntracked":true}`
			}
			code, out := gitReq(t, s, http.MethodGet, stashAnswerPath(flag), "")
			if code != http.StatusOK {
				t.Fatalf("답 종단 code = %d, body = %v", code, out)
			}
			acts, _ := out["actions"].(map[string]any)
			ans, _ := acts[action.GitStashCreate].(map[string]any)
			if ans == nil {
				t.Fatalf("답이 없다: %v", out)
			}
			wantOK := c.why == ""
			if ans["ok"] != wantOK || (!wantOK && ans["why"] != c.why) {
				t.Fatalf("답 = %v, want ok=%v why=%q", ans, wantOK, c.why)
			}

			code, out = gitReq(t, s, http.MethodPost, "/api/git/stash/push", body)
			if wantOK {
				if code == http.StatusConflict {
					t.Fatalf("답은 참인데 실행이 거절됐다: %v", out)
				}
				return
			}
			if code != http.StatusConflict || out["error"] != c.why {
				t.Fatalf("실행 code = %d, error = %v, want 409 %s", code, out["error"], c.why)
			}
			if !mapsEqualJSON(out["args"], ans["args"]) {
				t.Fatalf("실행 args = %v, 답 args = %v — 같아야 한다", out["args"], ans["args"])
			}
			if _, has := out["message"]; has {
				t.Fatalf("서버가 문구를 실었다 (D-SDA-5): %v", out["message"])
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", got)
			}
		})
	}
}

// M-5: 모르는 동작은 400 이다 — 답 없음을 "허용" 으로 읽게 두지 않는다.
func TestGitActionsUnknownAction(t *testing.T) {
	s := gitM5Server(t, newGitM5Fake(t))
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/actions?repo="+url.QueryEscape(absWorkRepo)+"&action=git.no_such", "")
	if code != http.StatusBadRequest || out["error"] != apierr.CodeBadRequest {
		t.Fatalf("code = %d, error = %v, want 400 bad_request", code, out["error"])
	}
}

func mapsEqualJSON(a, b any) bool {
	am, _ := a.(map[string]any)
	bm, _ := b.(map[string]any)
	if len(am) != len(bm) {
		return false
	}
	for k, v := range am {
		if bm[k] != v {
			return false
		}
	}
	return true
}
