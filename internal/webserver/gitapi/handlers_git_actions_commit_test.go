package gitapi

import (
	"net/http"
	"net/url"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// TC-SDA-1 (GR-3b): 커밋 판정의 표 시험.
func TestCommitAnswers(t *testing.T) {
	staged := query.Status{Staged: []query.FileEntry{{Path: "a"}}}
	blocked := query.Preflight{Blocks: []query.Block{{Code: "merge", Reason: "r", Fix: "f"}}}
	same := func() bool { return true }
	diff := func() bool { return false }
	cases := []struct {
		name   string
		got    action.Answer
		why    string
		status int
	}{
		{"빈 메시지", commitMessageAnswer("  \n"), apierr.CodeEmptyMessage, http.StatusBadRequest},
		{"메시지 있음", commitMessageAnswer("m"), "", 0},
		{"preflight 막힘", commitStateAnswer(staged, blocked, gitCommitReq{}, diff), apierr.CodePreflightBlocked, http.StatusConflict},
		{"staged 없음", commitStateAnswer(query.Status{}, query.Preflight{}, gitCommitReq{}, diff), apierr.CodeNothingStaged, http.StatusBadRequest},
		{"staged 없음 · all", commitStateAnswer(query.Status{}, query.Preflight{}, gitCommitReq{All: true}, diff), "", 0},
		{"amend · 메시지 바뀜", commitStateAnswer(query.Status{}, query.Preflight{}, gitCommitReq{Amend: true}, diff), "", 0},
		{"amend · 메시지 같음", commitStateAnswer(query.Status{}, query.Preflight{}, gitCommitReq{Amend: true}, same), apierr.CodeNothingStaged, http.StatusBadRequest},
		{"staged 있음", commitStateAnswer(staged, query.Preflight{}, gitCommitReq{}, diff), "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.got.OK != (c.why == "") || c.got.Why != c.why || c.got.Status != c.status {
				t.Fatalf("answer = %+v, want why=%q status=%d", c.got, c.why, c.status)
			}
			if !c.got.OK && !action.Catalog.MayGive(action.GitCommit, c.got.Why) {
				t.Fatalf("사유 %q 가 동작 목록에 없다", c.got.Why)
			}
		})
	}
	if b := commitStateAnswer(staged, blocked, gitCommitReq{}, diff).Args["blocks"]; b == nil {
		t.Fatal("preflight 거절에 막은 항목(args.blocks)이 없다")
	}
}

func commitAnswerPath(msg, flags string) string {
	return "/api/git/actions?repo=" + url.QueryEscape(absWorkRepo) + "&action=" + action.GitCommit +
		"&message=" + url.QueryEscape(msg) + flags
}

// TC-SDA-1 (D-SDA-6 · FR-SDA-23): 같은 입력에서 답이 거짓이면 실행이 같은 코드로 거절된다.
func TestCommitAnswerMatchesRejection(t *testing.T) {
	cases := []struct {
		name, status, msg, flags, body, why string
	}{
		{"빈 메시지", gitWriteStatus("a.txt", "M."), " ", "", `{"repo":` + qWorkRepo + `,"message":" "}`, apierr.CodeEmptyMessage},
		{"staged 없음", gitWriteStatus("a.txt", ".M"), "m", "", `{"repo":` + qWorkRepo + `,"message":"m"}`, apierr.CodeNothingStaged},
		{"staged 있음", gitWriteStatus("a.txt", "M."), "m", "", `{"repo":` + qWorkRepo + `,"message":"m"}`, ""},
		{"all", gitWriteStatus("a.txt", ".M"), "m", "&all=1", `{"repo":` + qWorkRepo + `,"message":"m","all":true}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitWriteFake(t)
			f.status = c.status
			s, _ := gitWriteServer(t, f)
			code, out := gitReq(t, s, http.MethodGet, commitAnswerPath(c.msg, c.flags), "")
			if code != http.StatusOK {
				t.Fatalf("답 종단 = %d %v", code, out)
			}
			acts, _ := out["actions"].(map[string]any)
			a, _ := acts[action.GitCommit].(map[string]any)
			if a == nil || a["ok"] != (c.why == "") || (c.why != "" && a["why"] != c.why) {
				t.Fatalf("답 = %v, want why=%q", a, c.why)
			}
			code, out = gitReq(t, s, http.MethodPost, "/api/git/commit", c.body)
			if c.why == "" {
				if code != http.StatusOK {
					t.Fatalf("답은 참인데 실행이 거절됐다: %d %v", code, out)
				}
				return
			}
			if out["error"] != c.why {
				t.Fatalf("실행 = %d %v, want %s", code, out["error"], c.why)
			}
			if _, has := out["message"]; has {
				t.Fatalf("서버가 문구를 실었다 (D-SDA-5): %v", out["message"])
			}
		})
	}
}

// GR-3a: 커밋 답은 입력이 바꾸므로 1층에 싣지 않는다.
func TestStatusActions_NoCommit(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	_, acts := statusActions(t, s, "")
	if _, has := acts[action.GitCommit]; has {
		t.Fatalf("1층에 git.commit 이 있다: %v", acts[action.GitCommit])
	}
}
