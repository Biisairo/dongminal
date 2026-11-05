package gitapi

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// TC-SDA-1 (GT-c): 커밋 대상 판정의 표 시험.
func TestCommitTargetAnswers(t *testing.T) {
	head := strings.Repeat("a", 40)
	st := query.Status{Oid: head}
	busy := query.Status{Oid: head, Operation: query.Operation{Kind: "merge"}}
	one := commitFacts{Oid: strings.Repeat("b", 40), Parents: []string{"p"}}
	atHead := commitFacts{Oid: head, Parents: []string{"p"}}
	root := commitFacts{Oid: strings.Repeat("b", 40)}
	merge := commitFacts{Oid: strings.Repeat("b", 40), Parents: []string{"p", "q"}}
	cases := []struct {
		name, id string
		st       query.Status
		c        commitFacts
		why      string
	}{
		{"cherry-pick 보통", action.GitCommitCherryPick, st, one, ""},
		{"cherry-pick HEAD", action.GitCommitCherryPick, st, atHead, apierr.CodeTargetIsHead},
		{"reset HEAD", action.GitCommitReset, st, atHead, apierr.CodeTargetIsHead},
		{"revert HEAD 는 된다", action.GitCommitRevert, st, atHead, ""},
		{"drop 루트", action.GitCommitDrop, st, root, apierr.CodeRootCommit},
		{"drop 머지", action.GitCommitDrop, st, merge, apierr.CodeMergeCommit},
		{"drop 보통", action.GitCommitDrop, st, one, ""},
		{"진행 중이면 넷 다", action.GitCommitRevert, busy, one, apierr.CodeOperationInProgress},
		{"진행 중이 대상보다 먼저", action.GitCommitDrop, busy, root, apierr.CodeOperationInProgress},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := commitOpAnswer(c.id, c.st, c.c)
			if a.OK != (c.why == "") || a.Why != c.why {
				t.Fatalf("answer = %+v, want why=%q", a, c.why)
			}
			if !a.OK && !action.Catalog.MayGive(c.id, a.Why) {
				t.Fatalf("사유 %q 가 %s 의 목록에 없다", a.Why, c.id)
			}
			if a.Why == apierr.CodeOperationInProgress && a.Args["kind"] != "merge" {
				t.Fatalf("args = %v, want kind=merge", a.Args)
			}
		})
	}
}

func commitMenuAnswers(t *testing.T, s *GitServer, oid string) map[string]any {
	t.Helper()
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/actions?repo="+url.QueryEscape(absWorkRepo)+"&kind=commit&oid="+oid, "")
	if code != http.StatusOK {
		t.Fatalf("답 종단 = %d %v", code, out)
	}
	acts, _ := out["actions"].(map[string]any)
	for _, id := range []string{action.GitCommitCherryPick, action.GitCommitRevert, action.GitCommitReset, action.GitCommitDrop} {
		if acts[id] == nil {
			t.Fatalf("%s 의 답이 없다: %v", id, acts)
		}
	}
	return acts
}

// TC-SDA-1·6 (GT-a·c): 메뉴의 답과 실행 거절이 같다.
func TestCommitMenuAnswerMatchesRejection(t *testing.T) {
	head := strings.Repeat("a", 40)
	cases := []struct {
		name, oid, parents, path, body, id, why string
		merging                                 bool
	}{
		{"HEAD cherry-pick", head, "p1", "/api/git/cherry-pick", `{"repo":` + qWorkRepo + `,"oid":"` + head + `"}`,
			action.GitCommitCherryPick, apierr.CodeTargetIsHead, false},
		{"HEAD reset", head, "p1", "/api/git/reset", `{"repo":` + qWorkRepo + `,"oid":"` + head + `"}`,
			action.GitCommitReset, apierr.CodeTargetIsHead, false},
		{"루트 drop", strings.Repeat("b", 40), "", "/api/git/drop", `{"repo":` + qWorkRepo + `,"oid":"bbb","confirm":true}`,
			action.GitCommitDrop, apierr.CodeRootCommit, false},
		{"merge 중 revert", strings.Repeat("b", 40), "p1", "/api/git/revert", `{"repo":` + qWorkRepo + `,"oid":"bbb"}`,
			action.GitCommitRevert, apierr.CodeOperationInProgress, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitCoFake(t)
			f.oid, f.parents = c.oid, c.parents
			if c.merging {
				if err := os.WriteFile(filepath.Join(f.gitDir, "MERGE_HEAD"), []byte(head+"\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			s := gitCoServer(t, f)
			a, _ := commitMenuAnswers(t, s, c.oid)[c.id].(map[string]any)
			if a["ok"] != false || a["why"] != c.why {
				t.Fatalf("답 = %v, want %s", a, c.why)
			}
			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if out["error"] != c.why || code == http.StatusOK {
				t.Fatalf("실행 = %d %v, want %s", code, out["error"], c.why)
			}
			if _, has := out["message"]; has {
				t.Fatalf("서버가 문구를 실었다: %v", out["message"])
			}
			if w := f.wrote(); len(w) != 0 {
				t.Fatalf("거절됐는데 실행됐다: %v", w)
			}
		})
	}
}

// GT-a: 모르는 kind 는 400 이다.
func TestTargetActionsUnknownKind(t *testing.T) {
	s := gitCoServer(t, newGitCoFake(t))
	code, out := gitReq(t, s, http.MethodGet, "/api/git/actions?repo="+url.QueryEscape(absWorkRepo)+"&kind=nope", "")
	if code != http.StatusBadRequest || out["error"] != apierr.CodeBadRequest {
		t.Fatalf("= %d %v, want 400 bad_request", code, out)
	}
}
