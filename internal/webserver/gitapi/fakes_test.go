package gitapi

import (
	"net/http"
	"sync"

	"dongminal/internal/shared/workspace"
)

// gitapi 가 요구하는 표면은 ToolLocator·WorkspaceStore·Broadcaster 세 인터페이스의
// 메서드 네 개뿐이다. 그래서 이 fake 들도 그만큼만 구현한다 — internal/webserver/httpapi 의
// 전체 ToolHub fake 를 끌어올 이유가 없다. 다만 동작(rev 증가, ErrStale, save 계수)은
// 원본과 같게 유지한다: 다르게 만들면 회귀와 fake 결함을 구별할 수 없다.

// ── ToolLocator ─────────────────────────────────────

type fakePaneHub struct {
	mu    sync.Mutex
	known map[string]bool
	cwds  map[string]string
}

func newFakePaneHub() *fakePaneHub {
	return &fakePaneHub{known: map[string]bool{}, cwds: map[string]string{}}
}

// seed 는 도구가 존재한다고 표시한다. cwd 가 없으면 Cwd 는 빈 문자열이다 —
// 실제 ToolManager 도 cwd 를 못 읽으면 그렇게 답한다.
func (f *fakePaneHub) seed(id, _ string) {
	f.mu.Lock()
	f.known[id] = true
	f.mu.Unlock()
}

func (f *fakePaneHub) setCwd(id, cwd string) {
	f.mu.Lock()
	f.known[id] = true
	f.cwds[id] = cwd
	f.mu.Unlock()
}

func (f *fakePaneHub) Cwd(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cwds[id]
}

// ── WorkspaceStore ──────────────────────────────────

type fakeWorkspaceStore struct {
	mu    sync.Mutex
	raw   []byte
	rev   uint64
	saves int
	stale bool // true 면 Save 가 항상 ErrStale 이다
}

func newFakeWorkspaceStore() *fakeWorkspaceStore { return &fakeWorkspaceStore{} }

func (f *fakeWorkspaceStore) Snapshot() ([]byte, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.raw...), f.rev
}

func (f *fakeWorkspaceStore) Save(blob []byte, _ string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale {
		return 0, workspace.ErrStale
	}
	f.raw = append([]byte(nil), blob...)
	f.rev++
	f.saves++
	return f.rev, nil
}

// ── Broadcaster ─────────────────────────────────────

type fakeCommandBroker struct {
	mu        sync.Mutex
	published [][]byte
}

func (f *fakeCommandBroker) Broadcast(payload []byte) int {
	f.mu.Lock()
	f.published = append(f.published, append([]byte(nil), payload...))
	f.mu.Unlock()
	return 1
}

// ── 테스트 핸들러 ────────────────────────────────────

// handler는 Handle 을 http.Handler 로 감싼다. 라우팅 miss 는 운영과 같은 404 다
// (httpapi.handleAPI 가 그렇게 낸다).
func (g *GitServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.Handle(w, r) {
			http.Error(w, "not found", http.StatusNotFound)
		}
	})
}
