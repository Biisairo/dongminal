package gitapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/submodule"
)

// 입력 답의 한 줄 (SERVER_DRIVEN_ACTIONS_SRS GV-c). 답 종단과 실행 종단에 같은 입력을
// 보낸다.
type inputCase struct {
	name     string
	id       string
	query    url.Values
	execPath string
	execBody map[string]any
	why      string
}

func inputAnswer(t *testing.T, s *GitServer, repo, id string, q url.Values) (int, map[string]any) {
	t.Helper()
	v := url.Values{}
	for k, vs := range q {
		v[k] = vs
	}
	if repo != "" {
		v.Set("repo", repo)
	}
	v.Set("action", id)
	code, out := wtReq(t, s, http.MethodGet, "/api/git/actions?"+v.Encode(), "")
	acts, _ := out["actions"].(map[string]any)
	ans, _ := acts[id].(map[string]any)
	return code, ans
}

// TC-SDA-1 (GV-b): 답이 거짓이면 실행이 **같은 코드**로 거절되고, 문구를 싣지 않는다.
// 답이 참이면 실행이 그 판정으로 거절되지 않는다.
func runInputCases(t *testing.T, s *GitServer, repo string, cases []inputCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, ans := inputAnswer(t, s, repo, c.id, c.query)
			if code != http.StatusOK || ans == nil {
				t.Fatalf("답 종단 = %d %v", code, ans)
			}
			wantOK := c.why == ""
			if ans["ok"] != wantOK || (!wantOK && ans["why"] != c.why) {
				t.Fatalf("답 = %v, want ok=%v why=%q", ans, wantOK, c.why)
			}
			if !wantOK && !action.Catalog.MayGive(c.id, c.why) {
				t.Fatalf("%s 의 목록에 %s 가 없다 (M-3)", c.id, c.why)
			}
			body := map[string]any{"repo": repo}
			for k, v := range c.execBody {
				body[k] = v
			}
			raw, _ := json.Marshal(body)
			code, out := wtReq(t, s, http.MethodPost, c.execPath, string(raw))
			if wantOK {
				if code >= 400 {
					t.Fatalf("답은 참인데 실행이 거절됐다: %d %v", code, out)
				}
				return
			}
			if code < 400 || out["error"] != c.why {
				t.Fatalf("실행 = %d %v, want error %s", code, out["error"], c.why)
			}
			if !mapsEqualJSON(out["args"], ans["args"]) {
				t.Fatalf("실행 args = %v, 답 args = %v", out["args"], ans["args"])
			}
			if _, has := out["message"]; has {
				t.Fatalf("서버가 문구를 실었다 (D-SDA-5): %v", out["message"])
			}
		})
	}
}

// GV-e (G-B1): annotated·signed 는 메시지가 있어야 한다.
func TestTagCreateInputAnswer(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	q := func(kind, msg string) url.Values { return url.Values{"tagKind": {kind}, "message": {msg}} }
	b := func(name, kind, msg string) map[string]any {
		return map[string]any{"name": name, "kind": kind, "message": msg}
	}
	runInputCases(t, s, repo, []inputCase{
		{"annotated · 메시지 없음", action.GitTagCreate, q("annotated", ""), "/api/git/tag", b("v1", "annotated", ""), apierr.CodeTagMessageRequired},
		{"signed · 공백 메시지", action.GitTagCreate, q("signed", "  "), "/api/git/tag", b("v1", "signed", "  "), apierr.CodeTagMessageRequired},
		{"모르는 종류", action.GitTagCreate, q("heavy", "m"), "/api/git/tag", b("v1", "heavy", "m"), apierr.CodeTagKindInvalid},
		{"lightweight · 메시지 없음", action.GitTagCreate, q("", ""), "/api/git/tag", b("v1", "", ""), ""},
		{"annotated · 메시지 있음", action.GitTagCreate, q("annotated", "rel"), "/api/git/tag", b("v2", "annotated", "rel"), ""},
	})
}

// GV-f (G-B2 · FR-SDA-41): upstream 은 알려진 원격 ref 여야 한다.
func TestUpstreamInputAnswer(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	q := func(branch, up string) url.Values { return url.Values{"branch": {branch}, "upstream": {up}} }
	b := func(branch, up string) map[string]any { return map[string]any{"branch": branch, "upstream": up} }
	const id, path = action.GitBranchUpstreamSet, "/api/git/branch/upstream"
	runInputCases(t, s, repo, []inputCase{
		{"원격 ref 에 설정", id, q("origin/feat", "origin/main"), path, b("origin/feat", "origin/main"), apierr.CodeNotLocalBranch},
		{"빈 upstream", id, q("lone", " "), path, b("lone", " "), apierr.CodeEmptyRef},
		{"모르는 원격 ref", id, q("lone", "origin/nope"), path, b("lone", "origin/nope"), apierr.CodeUpstreamUnknown},
		{"로컬 브랜치를 upstream 으로", id, q("lone", "main"), path, b("lone", "main"), apierr.CodeUpstreamUnknown},
		{"알려진 원격 ref", id, q("lone", "origin/other"), path, b("lone", "origin/other"), ""},
	})
}

// GV-c (G-B5): stash 에서 만들 브랜치의 이름.
func TestStashBranchInputAnswer(t *testing.T) {
	s, repo, _ := gtBranchRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "w.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		out, err := submodule.ExecGit(context.Background(), repo,
			append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("stash", "push", "-q", "-u")
	oid := git("rev-parse", "stash@{0}")
	q := func(name string) url.Values { return url.Values{"name": {name}} }
	b := func(name string) map[string]any { return map[string]any{"oid": oid, "name": name} }
	const id, path = action.GitStashBranch, "/api/git/stash/branch"
	runInputCases(t, s, repo, []inputCase{
		{"빈 이름", id, q("  "), path, b("  "), apierr.CodeEmptyName},
		{"규칙 위반", id, q("a..b"), path, b("a..b"), apierr.CodeRefName},
		{"있는 이름", id, q("main"), path, b("main"), apierr.CodeBranchExists},
		{"새 이름", id, q("from-stash"), path, b("from-stash"), ""},
	})
}

// GV-b: 답은 도메인 sentinel 을 apierr 표로 코드로 바꾼 것이다 — 실행 거절과 같은 표다.
func TestErrAnswer(t *testing.T) {
	if a := errAnswer(nil); !a.OK {
		t.Fatalf("nil = %+v, want 허용", a)
	}
	a := errAnswer(write.CheckTagMessage(write.TagAnnotated, ""))
	if a.OK || a.Why != apierr.CodeTagMessageRequired || a.Status != http.StatusBadRequest {
		t.Fatalf("= %+v, want 400 tag_message_required", a)
	}
}
