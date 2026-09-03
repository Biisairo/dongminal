package lsp

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// IdleAfter 는 쓰이지 않은 세션을 정지시키기까지의 시간이다 (FR-LSP-17).
//
// 언어 서버는 큰 저장소에서 수백 MB 를 쓴다. 짧게 두면 잠깐 다른 일을 하고 돌아온
// 사용자가 매번 기동을 기다리고, 길게 두면 쓰지 않는 메모리가 남는다.
const IdleAfter = 20 * time.Minute

// MaxSessions 는 동시에 살아 있는 세션의 상한이다 (FR-LSP-19).
const MaxSessions = 6

// MaxTextBytes 는 요청이 실을 수 있는 파일 텍스트의 상한이다 (FR-LSP-53).
//
// 요청마다 현재 텍스트가 오는 구조이므로(D-3) 이 값이 곧 한 요청의 크기다.
const MaxTextBytes = 8 << 20

// SweepEvery 는 idle 정리의 주기다.
const SweepEvery = 2 * time.Minute

// sessionKey 는 (루트, 서술자) 한 쌍이다 (FR-LSP-13).
//
// 서술자가 단위인 것이 규칙이다 — 언어를 단위로 삼으면 TS·JS 가 같은 서버를 두 번
// 띄운다.
func sessionKey(root, descID string) string { return root + "\x00" + descID }

// Definition 은 그 자리의 정의들이다 (FR-LSP-21).
func (s *Service) Definition(ctx context.Context, root, path, text string, line, col int) ([]Location, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return nil, err
	}
	if err := checkText(text); err != nil {
		return nil, err
	}
	return sess.Definition(ctx, path, text, line, col)
}

// References 는 그 자리의 참조들이다 (FR-LSP-22).
func (s *Service) References(ctx context.Context, root, path, text string, line, col int, includeDecl bool) ([]Location, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return nil, err
	}
	if err := checkText(text); err != nil {
		return nil, err
	}
	return sess.References(ctx, path, text, line, col, includeDecl)
}

// Hover 는 그 자리 심볼의 타입·문서다 (FR-LSP-29).
func (s *Service) Hover(ctx context.Context, root, path, text string, line, col int) (string, error) {
	sess, err := s.session(root, path)
	if err != nil {
		return "", err
	}
	if err := checkText(text); err != nil {
		return "", err
	}
	return sess.Hover(ctx, path, text, line, col)
}

func checkText(text string) error {
	if len(text) > MaxTextBytes {
		return fmt.Errorf("파일이 너무 큽니다 (%d 바이트, 상한 %d)", len(text), MaxTextBytes)
	}
	return nil
}

// session 은 이 파일을 맡을 세션을 얻는다. 없으면 세우고, 실패는 기억한다.
//
// **사유가 있는 오류만 낸다** (D-9). LSP 는 안 되는 경우가 많고 — 서술자 없음,
// 실행 파일 없음, 기동 실패 — 그 전부가 "아무 일도 일어나지 않음" 으로 보이면
// 사용자는 모두 우리 버그로 읽는다.
func (s *Service) session(root, path string) (*Session, error) {
	if root == "" {
		return nil, fmt.Errorf("루트가 없습니다")
	}
	// FR-LSP-24·49: 루트 밖은 거절한다. 종단에도 가드가 있지만 이 표면을 쓰는
	// 다른 종단이 그 가드를 다시 적지 않아도 되게 여기서도 막는다.
	if !underRoot(root, path) {
		return nil, fmt.Errorf("루트 밖의 경로입니다")
	}
	d, ok := DescriptorForExt(filepath.Ext(path))
	if !ok {
		return nil, fmt.Errorf("%s 는 코드 탐색을 지원하는 언어가 아닙니다", filepath.Ext(path))
	}

	key := sessionKey(root, d.ID)
	s.mu.Lock()
	if s.sessions == nil {
		s.sessions = map[string]*Session{}
	}
	if sess := s.sessions[key]; sess != nil {
		s.mu.Unlock()
		return sess, nil
	}
	// FR-LSP-16: 기동 실패는 기억된다 — 매 요청마다 프로세스를 되풀이 띄우지
	// 않는다. 설치가 바뀌면 이 기억은 지워진다 (Install 이 그것을 한다).
	if s.failed != nil {
		if err, bad := s.failed[d.ID]; bad {
			s.mu.Unlock()
			return nil, err
		}
	}
	s.mu.Unlock()

	// 실행 파일을 찾는다. 못 찾으면 **무엇이 없는지**를 사유로 낸다.
	loc := &Locator{LookPath: s.lookPath(), ManagedDir: s.Dir, Overrides: s.Overrides}
	st := loc.Locate(d)
	if !st.Found {
		err := fmt.Errorf("%s 가 없어 코드 탐색을 할 수 없습니다 — 설정 ▸ Code 에서 받으세요", d.Exe)
		s.remember(d.ID, err)
		return nil, err
	}

	start := s.Start
	if start == nil {
		start = StartProcess
	}
	sess := newSession(root, d, st.Exe, start, nil)
	if sess.initErr != nil {
		s.remember(d.ID, sess.initErr)
		sess.Close()
		return nil, sess.initErr
	}

	s.mu.Lock()
	// 그 사이 다른 요청이 세웠으면 그것을 쓴다 — 둘을 살려 두면 프로세스가 샌다.
	if existing := s.sessions[key]; existing != nil {
		s.mu.Unlock()
		sess.Close()
		return existing, nil
	}
	s.sessions[key] = sess
	s.mu.Unlock()

	// FR-LSP-19: 상한을 넘으면 가장 오래 쓰이지 않은 것을 정지한다.
	s.evictOverLimit()
	return sess, nil
}

func (s *Service) remember(descID string, err error) {
	s.mu.Lock()
	if s.failed == nil {
		s.failed = map[string]error{}
	}
	s.failed[descID] = err
	s.mu.Unlock()
}

// forget 은 그 서술자의 실패 기억을 지운다. 설치가 이것을 부른다 (FR-LSP-16) —
// 고쳐 놓고도 안 되면 사용자는 우리를 못 믿는다.
func (s *Service) forget(descID string) {
	s.mu.Lock()
	delete(s.failed, descID)
	s.mu.Unlock()
}

// evictOverLimit 은 상한을 넘긴 만큼 가장 오래 쓰이지 않은 세션을 정지시킨다.
func (s *Service) evictOverLimit() {
	limit := s.MaxSessions
	if limit <= 0 {
		limit = MaxSessions
	}
	for {
		s.mu.Lock()
		if len(s.sessions) <= limit {
			s.mu.Unlock()
			return
		}
		var oldKey string
		var oldest *Session
		for k, sess := range s.sessions {
			if oldest == nil || sess.LastUse().Before(oldest.LastUse()) {
				oldKey, oldest = k, sess
			}
		}
		delete(s.sessions, oldKey)
		s.mu.Unlock()
		if oldest != nil {
			oldest.Close()
		}
	}
}

// Sweep 은 쓰이지 않은 세션을 정지시킨다 (FR-LSP-17).
//
// 정지는 포기가 아니다 — 다시 물으면 다시 선다.
func (s *Service) Sweep() {
	after := s.IdleAfter
	if after <= 0 {
		after = IdleAfter
	}
	cut := time.Now().Add(-after)
	var stop []*Session
	s.mu.Lock()
	for k, sess := range s.sessions {
		if sess.LastUse().Before(cut) {
			stop = append(stop, sess)
			delete(s.sessions, k)
		}
	}
	s.mu.Unlock()
	for _, sess := range stop {
		sess.Close()
	}
}

// RunSweeper 는 주기적으로 Sweep 한다. 서버 수명과 함께 시작하고 끝난다.
func (s *Service) RunSweeper(ctx context.Context) {
	t := time.NewTicker(SweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep()
		}
	}
}

// Shutdown 은 모든 세션을 정지시킨다 (FR-LSP-18).
func (s *Service) Shutdown() {
	s.mu.Lock()
	all := s.sessions
	s.sessions = map[string]*Session{}
	s.mu.Unlock()
	for _, sess := range all {
		sess.Close()
	}
}

// SessionCount 는 지금 살아 있는 세션 수다. 진단과 검사가 읽는다.
func (s *Service) SessionCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// underRoot 는 그 경로가 루트 아래인가다.
//
// `..` 를 지나 밖으로 나가는 경로를 막는 것이 요점이다 — `filepath.Clean` 이
// 그것을 펴 준 뒤에 견준다.
func underRoot(root, path string) bool {
	if path == "" {
		return false
	}
	r := filepath.Clean(root)
	p := filepath.Clean(path)
	if p == r {
		return true
	}
	sep := string(filepath.Separator)
	if !strings.HasSuffix(r, sep) {
		r += sep
	}
	return strings.HasPrefix(p, r)
}
