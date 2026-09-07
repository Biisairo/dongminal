package gitapi

import (
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// GIT_PUSH_OBSERVE_SRS FR-GPO-10 — status 요청이 곧 관심 표명이다.
//
// 이 검사가 없으면 배선이 끊겨도 조용하다: 브라우저는 status 를 받아 화면이
// 서고, 다만 그 뒤로 아무 방송도 오지 않는다. e2e 에서는 "느리다" 로만 드러나고
// 그 원인이 감시자인지 브라우저인지 가려지지 않는다.

type noteSpy struct{ repos []string }

func (n *noteSpy) Note(repo string, _ store.Observation) { n.repos = append(n.repos, repo) }

func TestApiGitStatus_NotesInterest(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }
	spy := &noteSpy{}
	s.Watch = spy

	code, _ := gitReq(t, s, "GET", "/api/git/status?repo="+absWorkRepo, "")
	if code != 200 {
		t.Fatalf("status 가 %d 로 답했다", code)
	}
	if len(spy.repos) != 1 {
		t.Fatalf("status 요청이 관심을 표명하지 않았다: %v (FR-GPO-10)", spy.repos)
	}
	// 표명하는 것은 **해석된 루트**다 (`root` 가 답한 값). 클라이언트가 보낸 값
	// 그대로면 심볼릭 링크를 지난 경로와 어긋나 감시가 엉뚱한 자리를 본다 —
	// macOS 의 `/tmp` → `/private/tmp` 가 그 자리다 (FR-DIR-5).
	if spy.repos[0] != absWorkRepo {
		t.Fatalf("해석된 루트가 아닌 것을 표명했다: %q", spy.repos[0])
	}
}

// Watch 가 없는 구성에서도 핸들러는 그대로 돈다 — nil 은 예외가 아니라 유효한
// 상태다 (감시자 없이 서는 배선이 있다).
func TestApiGitStatus_NilWatchIsFine(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	if code, _ := gitReq(t, s, "GET", "/api/git/status?repo="+absWorkRepo, ""); code != 200 {
		t.Fatalf("Watch 가 nil 인데 %d 로 답했다", code)
	}
}
