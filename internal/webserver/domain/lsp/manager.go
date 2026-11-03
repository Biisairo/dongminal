package lsp

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/editorlimit"
)

// IdleAfter 는 프레임이 오가지 않은 통로를 정리하기까지의 시간이다 (FR-LSP-17 · CODEMIRROR_MIGRATION_SRS FR-CMR-102).
//
// 언어 서버는 큰 저장소에서 수백 MB 를 쓴다. 짧게 두면 잠깐 다른 일을 하고 돌아온
// 사용자가 매번 기동을 기다리고, 길게 두면 쓰지 않는 메모리가 남는다.
const IdleAfter = 20 * time.Minute

// MaxSessions 는 동시에 살아 있는 통로 프로세스의 상한이다 (FR-LSP-19 · FR-CMR-102).
const MaxSessions = 6

// MaxTextBytes 는 편집기 파일 상한이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-15-1). 통로 메시지의 상한이
// 이것에 JSON 머리 몫을 더한 값이다 (FR-CMR-104).
var MaxTextBytes = editorlimit.FileMaxBytes

// SweepEvery 는 idle 정리의 주기다.
const SweepEvery = 2 * time.Minute

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// limit 은 동시 실행 상한이다.
func (s *Service) limit() int {
	if s.MaxSessions <= 0 {
		return MaxSessions
	}
	return s.MaxSessions
}

// Sweep 은 IdleAfter 동안 프레임이 오가지 않은 통로를 닫는다 (FR-CMR-102·103). 브라우저는
// 다음에 그 연결을 쓸 때 다시 연다.
func (s *Service) Sweep() {
	after := s.IdleAfter
	if after <= 0 {
		after = IdleAfter
	}
	cut := s.now().Add(-after)
	s.mu.Lock()
	idle := s.tunnelsLocked()
	s.mu.Unlock()
	for _, t := range idle {
		if t.LastUse().Before(cut) {
			t.Close()
		}
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

// Shutdown 은 모든 통로를 닫는다 (FR-LSP-18).
func (s *Service) Shutdown() {
	s.mu.Lock()
	tunnels := s.tunnelsLocked()
	s.mu.Unlock()
	for _, t := range tunnels {
		t.Close()
	}
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
