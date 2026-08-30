package gitapi

import (
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 E — `+ Add` 의 경로 자동채움 (EXPLORER_TRANSFER_IGNORE_SRS §3.5,
// V-ETR-28).
//
// **결함은 폴백 자체가 아니라 그것이 보이지 않는다는 것이다.** `gitToolCwd` 는
// 도구를 못 찾으면 서버 프로세스의 cwd 로 답하고, 그것이 마침 저장소면
// `isRepo:true` 로 나간다. 클라이언트는 그 값을 사용자의 것으로 읽는다 (§2.4).
//
// 폴백을 없애지 않는 이유는 `/api/cwd` 의 소비자 넷이 그것을 딛고 있기
// 때문이다 (FILE_TRANSFER_SRS D-4). 그래서 같은 규약으로 `source` 를 **더한다**
// (D-10) — 판단은 호출자가 한다.

// V-ETR-28 (FR-ETR-31): 아는 도구의 cwd 로 답할 때는 source 가 "tool" 이다.
func TestGitRepoAt_SourceTool(t *testing.T) {
	g := newGitFake(t)
	s, hub, _, _ := gitTestServer(t, g)
	hub.seed("t1", "T1")
	hub.setCwd("t1", absWorkRepoSub)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at?tool=t1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["source"] != "tool" {
		t.Fatalf("source=%v, want %q", out["source"], "tool")
	}
}

// V-ETR-28 (FR-ETR-31): **없는 도구**로 물으면 서버의 cwd 가 나가지만 그 사실이
// source 로 드러나야 한다. 이것이 §2.4 의 실측을 고치는 자리다 —
//
//	$ curl '/api/git/repo-at?tool=deadbeef'
//	{"cwd":"…/dongminal","isRepo":true,…}      ← 사용자의 것이 아닌데 그럴듯하다
func TestGitRepoAt_SourceServerForUnknownTool(t *testing.T) {
	g := newGitFake(t)
	s, hub, _, _ := gitTestServer(t, g)
	hub.seed("t1", "T1")
	hub.setCwd("t1", absWorkRepoSub)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at?tool=nope", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["source"] != "server" {
		t.Fatalf("source=%v, want %q — 없는 도구인데 사용자의 것으로 보인다", out["source"], "server")
	}
}

// FR-ETR-31: tool 인자가 아예 없을 때도 같다.
func TestGitRepoAt_SourceServerWithoutTool(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["source"] != "server" {
		t.Fatalf("source=%v, want %q", out["source"], "server")
	}
}

// FR-ETR-31: 도구는 아는데 cwd 를 못 읽는 경우도 서버 폴백이다 — fakePaneHub 의
// seed 는 도구를 알리되 cwd 를 비운다. 실제 ToolManager 도 그렇게 답한다.
func TestGitRepoAt_SourceServerWhenCwdEmpty(t *testing.T) {
	g := newGitFake(t)
	s, hub, _, _ := gitTestServer(t, g)
	hub.seed("t1", "T1") // cwd 를 심지 않는다
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repo-at?tool=t1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["source"] != "server" {
		t.Fatalf("source=%v, want %q", out["source"], "server")
	}
}
