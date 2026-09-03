package lsp

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

// Service 는 HTTP 종단이 딛는 표면이다 (M1 의 묶음 A).
//
// 종단이 이것만 알고 프로토콜·프로세스를 모르는 것이 규칙이다 (D-4) — 방향은
// 샌드박스와 같다: httpapi 는 컨테이너 런타임을 알지 않는다.
type Service struct {
	// Dir 은 전용 디렉터리다 (`<홈>/lsp`).
	Dir string
	// LookPath·Exec 는 탐색과 설치의 의존이다. 비면 실제 것을 쓴다.
	LookPath func(string) (string, error)
	Exec     func(ctx context.Context, name string, args, env []string, dir string) ([]byte, error)

	// Start 는 언어 서버 프로세스를 세운다. 비면 실제 프로세스를 쓴다.
	Start Starter
	// Overrides 는 설정이 적은 절대경로 표다 (FR-LSP-4b). 세션을 세울 때의
	// 탐색이 이것을 딛는다 — 상태 조회는 요청이 실은 표를 따로 받는다.
	Overrides map[string]string
	// IdleAfter·MaxSessions 가 0 이면 이 패키지의 기본값을 쓴다.
	IdleAfter   time.Duration
	MaxSessions int

	mu sync.Mutex
	// sessions 는 (루트, 서술자) → 세션이다 (FR-LSP-13).
	sessions map[string]*Session
	// failed 는 기동 실패의 기억이다 (FR-LSP-16) — 매 요청마다 같은 실패를
	// 되풀이해 프로세스를 띄우지 않는다.
	failed map[string]error
	// installing 은 지금 받고 있는 서술자들이다 (FR-LSP-48).
	//
	// 판정이 서버에 있는 근거는 화면의 비활성으로는 **다른 탭·다른 기기**에서
	// 누른 두 번째 설치를 막지 못한다는 것이다.
	installing map[string]bool
}

// NewService 는 실제 PATH·프로세스를 쓰는 Service 다.
func NewService(dir string) *Service {
	return &Service{Dir: dir, LookPath: exec.LookPath, Exec: execCombined}
}

func (s *Service) lookPath() func(string) (string, error) {
	if s.LookPath != nil {
		return s.LookPath
	}
	return exec.LookPath
}

// Status 는 서술자마다 한 줄의 **관측**이다 (FR-LSP-5·46·47).
//
// `overrides` 는 화면이 실어 보낸 절대경로 표다 (FR-LSP-4b) — 설정 블롭은 서버가
// 해석하지 않으므로 서버가 그것을 읽을 자리가 없다.
func (s *Service) Status(overrides map[string]string) []Status {
	loc := &Locator{LookPath: s.lookPath(), ManagedDir: s.Dir, Overrides: overrides}
	ds := Descriptors()
	out := make([]Status, 0, len(ds))
	s.mu.Lock()
	inflight := make(map[string]bool, len(s.installing))
	for k, v := range s.installing {
		inflight[k] = v
	}
	s.mu.Unlock()
	for _, d := range ds {
		st := loc.Locate(d)
		st.Installing = inflight[d.ID]
		out = append(out, st)
	}
	return out
}

// Install 은 서술자 하나를 받는다.
//
// 같은 서술자의 두 번째 요청은 **거절된다** (FR-LSP-48). 두 개를 함께 돌리면 같은
// 디렉터리에 두 도구가 쓰고, 실패했을 때 어느 쪽의 출력인지 알 수 없다.
func (s *Service) Install(ctx context.Context, id string) InstallOutcome {
	var d Descriptor
	found := false
	for _, c := range Descriptors() {
		if c.ID == id {
			d, found = c, true
			break
		}
	}
	if !found {
		return InstallOutcome{Reason: fmt.Sprintf("%q 는 아는 언어 서버가 아닙니다", id)}
	}

	s.mu.Lock()
	if s.installing[id] {
		s.mu.Unlock()
		return InstallOutcome{Reason: fmt.Sprintf("%s 를 이미 받고 있습니다", id)}
	}
	if s.installing == nil {
		s.installing = map[string]bool{}
	}
	s.installing[id] = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.installing, id)
		s.mu.Unlock()
	}()

	r := &InstallRunner{ManagedDir: s.Dir, LookPath: s.lookPath(), Exec: s.Exec}
	if r.Exec == nil {
		r.Exec = execCombined
	}
	out := r.Install(ctx, d)
	// FR-LSP-16: 설치를 시도했으면 그 서술자의 실패 기억을 지운다. 성공이든
	// 실패든 지우는 이유는, 실패한 설치도 상태를 바꿀 수 있고(부분 설치) 무엇보다
	// **고쳐 놓고도 안 되는 것**이 사용자가 우리를 못 믿게 되는 자리이기 때문이다.
	s.forget(id)
	return out
}
