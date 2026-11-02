package lsp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/ext"
)

// ErrLimit 는 동시 실행 상한에 걸렸다는 답이다 (CODEMIRROR_MIGRATION_SRS FR-CMR-102).
var ErrLimit = errors.New("lsp: 동시 실행 상한")

// Tunnel 은 브라우저의 LSP 클라이언트와 언어 서버 프로세스 하나를 잇는 통로다
// (CODEMIRROR_MIGRATION_SRS FR-CMR-101). 메시지 내용은 해석하지 않는다.
//
// Send·Recv 가 오가는 것이 "쓰이고 있다" 의 판정이다 — 유휴 정리가 LastUse 를 본다.
type Tunnel interface {
	// Send 는 본문에 Content-Length 머리를 붙여 stdin 에 쓴다.
	Send(body []byte) error
	// Recv 는 stdout 의 프레임 하나에서 머리를 뗀 본문이다. 한 goroutine 만 부른다.
	Recv() ([]byte, error)
	// Close 는 프로세스를 끝내고 등록에서 뺀다. 여러 번 불러도 한 번이다.
	Close()
	LastUse() time.Time
}

type tunnel struct {
	svc  *Service
	rwc  io.ReadWriteCloser
	br   *bufio.Reader
	stop func()
	wmu  sync.Mutex
	once sync.Once

	mu      sync.Mutex
	lastUse time.Time
}

// OpenTunnel 은 (루트, 서술자)의 언어 서버를 새로 띄워 통로로 낸다.
//
// 통로 수가 이미 상한이면 프로세스를 띄우지 않고 ErrLimit 다. 띄운 뒤 REST 세션과
// 합쳐 상한을 넘으면 REST 세션만 LRU 로 정지한다 (FR-CMR-102).
func (s *Service) OpenTunnel(root, descID string) (Tunnel, error) {
	if root == "" {
		return nil, fmt.Errorf("루트가 없습니다")
	}
	if s.Ext == nil {
		return nil, fmt.Errorf("플러그인 계층이 배선되지 않았습니다")
	}
	srv, st, ok := s.Ext.ResolveID(descID, s.locatorOverrides())
	if !ok {
		return nil, fmt.Errorf("모르는 언어 서버입니다: %q", descID)
	}
	if !st.Found {
		return nil, fmt.Errorf("%s 가 없어 코드 탐색을 할 수 없습니다 — %s (설정 ▸ Code)",
			srv.Exe, ext.MissingText(st))
	}
	s.mu.Lock()
	if s.tunnelSlotsLocked() >= s.limit() {
		s.mu.Unlock()
		return nil, ErrLimit
	}
	s.tunnelPending++
	s.mu.Unlock()

	start := s.Start
	if start == nil {
		start = StartProcess
	}
	rwc, stop, err := start(context.Background(), st.Exe, srv.Args, root)
	s.mu.Lock()
	s.tunnelPending--
	if err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("lsp: %s 를 띄우지 못했습니다: %w", descID, err)
	}
	t := &tunnel{svc: s, rwc: rwc, br: bufio.NewReader(rwc), stop: stop, lastUse: s.now()}
	if s.tunnels == nil {
		s.tunnels = map[*tunnel]struct{}{}
	}
	s.tunnels[t] = struct{}{}
	s.mu.Unlock()
	s.evictOverLimit()
	return t, nil
}

// tunnelSlotsLocked 는 통로가 차지한 자리(열린 것 + 띄우는 중)다.
func (s *Service) tunnelSlotsLocked() int { return len(s.tunnels) + s.tunnelPending }

// tunnelsLocked 는 열린 통로들의 사본이다 — 잠금 밖에서 닫기 위해서다.
func (s *Service) tunnelsLocked() []*tunnel {
	out := make([]*tunnel, 0, len(s.tunnels))
	for t := range s.tunnels {
		out = append(out, t)
	}
	return out
}

func (t *tunnel) touch() {
	now := t.svc.now()
	t.mu.Lock()
	t.lastUse = now
	t.mu.Unlock()
}

func (t *tunnel) LastUse() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastUse
}

func (t *tunnel) Send(body []byte) error {
	t.wmu.Lock()
	err := writeFrame(t.rwc, body)
	t.wmu.Unlock()
	if err == nil {
		t.touch()
	}
	return err
}

func (t *tunnel) Recv() ([]byte, error) {
	b, err := readFrame(t.br)
	if err == nil {
		t.touch()
	}
	return b, err
}

func (t *tunnel) Close() {
	t.once.Do(func() {
		_ = t.rwc.Close()
		if t.stop != nil {
			t.stop()
		}
		t.svc.mu.Lock()
		delete(t.svc.tunnels, t)
		t.svc.mu.Unlock()
	})
}
