package gitapi

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// REPO_FIX 04 §3A-0 X5 — status 응답의 `mark` 는 git_changed 의 mark 와 같은 함수다.
func TestGitStatus_CarriesMark(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }
	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo), "")
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	obs, _, err := s.Git.Status(context.Background(), absWorkRepo)
	if err != nil {
		t.Fatal(err)
	}
	if out["mark"] == nil || out["mark"] != store.Mark(obs) || out["mark"] == "" {
		t.Fatalf("mark = %v, want %q", out["mark"], store.Mark(obs))
	}
}
