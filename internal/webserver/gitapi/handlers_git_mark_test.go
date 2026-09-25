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

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-7 (HTTP-7 · IPC-30): `ifMark` 가 현재 관측의 mark 와
// 같으면 목록을 싣지 않고 `unchanged:true` 만 답한다. 다르면 종전 본문 그대로다.
func TestGitStatus_IfMarkUnchanged(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }
	spy := &noteSpy{}
	s.Watch = spy
	base := "/api/git/status?repo=" + url.QueryEscape(absWorkRepo)
	_, full := gitReq(t, s, http.MethodGet, base, "")
	mark, _ := full["mark"].(string)
	if mark == "" {
		t.Fatalf("mark 가 없다: %v", full)
	}

	code, out := gitReq(t, s, http.MethodGet, base+"&clientId=c-1&ifMark="+url.QueryEscape(mark), "")
	if code != http.StatusOK || out["unchanged"] != true {
		t.Fatalf("같은 mark 인데 unchanged 가 아니다: code=%d %v", code, out)
	}
	if _, has := out["status"]; has {
		t.Fatalf("unchanged 응답이 목록을 실었다: %v", out)
	}
	for _, k := range []string{"repo", "requested", "isRepo", "rootMatch", "requestedResolved", "mark"} {
		if out[k] != full[k] {
			t.Fatalf("%s = %v, 전량 응답은 %v", k, out[k], full[k])
		}
	}
	// 생략해도 관심 표명(임대)은 그대로다 — 이 요청도 "보고 있다" 는 말이다.
	if n := len(spy.clients); n != 2 || spy.clients[1] != "c-1" {
		t.Fatalf("unchanged 응답이 표명을 건너뛰었다: %v", spy.clients)
	}

	_, other := gitReq(t, s, http.MethodGet, base+"&ifMark=stale", "")
	if other["unchanged"] != nil || other["status"] == nil {
		t.Fatalf("다른 mark 인데 전량이 아니다: %v", other)
	}
}
