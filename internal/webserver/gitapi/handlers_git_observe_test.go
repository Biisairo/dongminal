package gitapi

import (
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS 묶음 O.
//
// 배지는 마지막 관측값이고, 관측을 만드는 사람은 활성 리포의 폴링 하나뿐이었다
// (A11·A12). 그래서 클릭해 연 적 없는 핀은 영원히 배지가 없다. `observe=1` 은
// 그 자리에서 핀 전부를 관측한다.

// V-GOB-1: observe=1 이면 핀 수만큼 관측이 돌고, 열어 본 적 없는 핀에도 배지가 실린다.
func TestGitRepos_ObserveFillsEveryBadge(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `,` + qC + `]}}`)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if n := g.count("status"); n != 3 {
		t.Fatalf("git status 를 %d회 실행했다 (3 이어야 한다)", n)
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 3 {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	for i, p := range pinned {
		e, _ := p.(map[string]any)
		badge, _ := e["badge"].(map[string]any)
		if badge == nil {
			t.Fatalf("pinned[%d] 에 배지가 없다: %v", i, e)
		}
		if badge["total"] != float64(1) || badge["branch"] != "main" {
			t.Fatalf("pinned[%d] badge=%v", i, badge)
		}
	}
}

// V-GOB-1: 순서는 핀 순서 그대로다 — 병렬 관측이 순서를 흔들지 않는다 (FR-GOB-3).
func TestGitRepos_ObserveKeepsPinOrder(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `,` + qC + `,"/d","/e"]}}`)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1", "")
	if code != 200 {
		t.Fatalf("code=%d", code)
	}
	pinned, _ := out["pinned"].([]any)
	want := []string{absA, absB, absC, "/d", "/e"}
	if len(pinned) != len(want) {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	for i, p := range pinned {
		e, _ := p.(map[string]any)
		if e["path"] != want[i] {
			t.Fatalf("pinned[%d].path=%v want %s", i, e["path"], want[i])
		}
	}
}

// V-GOB-2 (FR-GOB-5 회귀): observe 가 없으면 지금과 완전히 같다 — status 0회.
func TestGitRepos_NoObserveStillNeverRunsStatus(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `,` + qC + `]}}`)

	if code, _ := gitReq(t, s, http.MethodGet, "/api/git/repos", ""); code != 200 {
		t.Fatalf("code=%d", code)
	}
	if n := g.count("status"); n != 0 {
		t.Fatalf("git status 를 %d회 실행했다", n)
	}
}

// V-GOB-3 (FR-GOB-4): 한 핀이 저장소가 아니어도 나머지 배지는 실린다. 목록
// 자체가 실패하지 않는다.
func TestGitRepos_ObserveSurvivesBadPin(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":["/bad",` + qGood + `]}}`)
	g.root = func(dir string) (core.Output, error) {
		if dir == "/bad" {
			return core.Output{}, core.ErrNotRepo
		}
		return core.Output{Stdout: dir + "\n"}, nil
	}

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	pinned, _ := out["pinned"].([]any)
	if len(pinned) != 2 {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	bad, _ := pinned[0].(map[string]any)
	if bad["isRepo"] != false || bad["badge"] != nil {
		t.Fatalf("저장소가 아닌 핀: %v", bad)
	}
	good, _ := pinned[1].(map[string]any)
	if badge, _ := good["badge"].(map[string]any); badge == nil {
		t.Fatalf("정상 핀에 배지가 없다: %v", good)
	}
}
