package gitapi

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
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
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `,` + qC + `,` + qD + `,` + qE + `]}}`)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1", "")
	if code != 200 {
		t.Fatalf("code=%d", code)
	}
	pinned, _ := out["pinned"].([]any)
	want := []string{absA, absB, absC, absD, absE}
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
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qBad + `,` + qGood + `]}}`)
	g.root = func(dir string) (core.Output, error) {
		if dir == absBad {
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

// scopeSpy 는 핀 임대의 표명·해제를 적는다 (FR-OPT-4-3).
// 관측은 핀마다 병렬이다 (fanout) — 적는 자리를 잠근다.
type scopeSpy struct {
	mu       sync.Mutex
	noted    []string
	released []string
}

func (s *scopeSpy) Note(string, store.Observation)            {}
func (s *scopeSpy) NoteFor(string, store.Observation, string) {}
func (s *scopeSpy) NoteScoped(repo string, _ store.Observation, clientID, scope string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.noted = append(s.noted, repo+"|"+clientID+"|"+scope)
}
func (s *scopeSpy) ReleaseScope(clientID, scope string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.released = append(s.released, clientID+"|"+scope)
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-3 (IPC-7): Repo 탭이 보이는 동안(`observe=1`) 핀 전부를
// 그 신원의 `pins` 갈래로 임대한다 — 배지 갱신은 감시자의 `git_changed` 가 알린다.
// `observe=0` 은 탭을 떠난 것이다: 그 갈래를 놓는다. 인자가 없으면 임대를 건드리지 않는다.
func TestGitRepos_ObserveLeasesPinsAndZeroReleases(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `,` + qB + `]}}`)
	spy := &scopeSpy{}
	s.Watch = spy

	if code, _ := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1&clientId=c1", ""); code != 200 {
		t.Fatalf("code=%d", code)
	}
	sort.Strings(spy.noted)
	want := []string{absA + "|c1|pins", absB + "|c1|pins"}
	sort.Strings(want)
	if fmt.Sprint(spy.noted) != fmt.Sprint(want) {
		t.Fatalf("noted=%v want %v", spy.noted, want)
	}
	if code, _ := gitReq(t, s, http.MethodGet, "/api/git/repos?clientId=c1", ""); code != 200 {
		t.Fatalf("code=%d", code)
	}
	if len(spy.released) != 0 || len(spy.noted) != 2 {
		t.Fatalf("인자 없는 목록이 임대를 건드렸다: noted=%v released=%v", spy.noted, spy.released)
	}
	if code, _ := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=0&clientId=c1", ""); code != 200 {
		t.Fatalf("code=%d", code)
	}
	if fmt.Sprint(spy.released) != "[c1|pins]" {
		t.Fatalf("released=%v", spy.released)
	}
	if n := g.count("status"); n != 2 {
		t.Fatalf("git status %d 회, want 2 (observe=1 한 번만)", n)
	}
}

// 핀 항목은 git 이 푼 루트를 싣는다 — `git_changed` 의 repo 와 견줄 값이다 (FR-OPT-4-3).
func TestGitRepos_EntryCarriesRoot(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `]}}`)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos", "")
	if code != 200 {
		t.Fatalf("code=%d", code)
	}
	e, _ := out["pinned"].([]any)[0].(map[string]any)
	if e["root"] != absA {
		t.Fatalf("root=%v want %s (%v)", e["root"], absA, e)
	}
}

// FR-OPT-4-3: 관측 중에 저장소가 사라지면(관측 실패) 그 핀의 루트 해석을 잊는다 — 같은
// 응답이 캐시된 옛 해석으로 isRepo:true 를 싣지 않는다. 그 핀은 임대도 없으므로 이 응답이
// 틀리면 안전망까지 낡은 채로 남는다.
func TestGitRepos_ObserveVanishedPinIsNotRepo(t *testing.T) {
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qA + `]}}`)
	calls := 0
	g.root = func(dir string) (core.Output, error) {
		calls++
		if calls > 1 {
			return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
		}
		return core.Output{Stdout: dir + "\n"}, nil
	}
	g.statusNotRepo = true
	code, out := gitReq(t, s, http.MethodGet, "/api/git/repos?observe=1&clientId=c1", "")
	if code != 200 {
		t.Fatalf("code=%d", code)
	}
	e, _ := out["pinned"].([]any)[0].(map[string]any)
	if e["isRepo"] != false {
		t.Fatalf("사라진 핀이 저장소로 실렸다: %v", e)
	}
}
