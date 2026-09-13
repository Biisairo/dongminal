package toolhub

import (
	"fmt"
	"strings"
	"sync"
)

// ExitInfo 는 도구 프로세스가 끝난 사정이다 (M8_UNIFIED_SRS D-C-15 · FR-ABG-20). Code 는
// 종료 코드(신호로 죽었으면 -1, 모르면 0), Stderr 는 파이프 stderr 의 마지막 줄들이다 —
// PTY 도구는 비어 있다. 두 모드가 같은 모양을 나른다: 직접 모드는 ExitObserver 의 인자,
// 데몬 모드는 `exit` push 의 `code`·`stderr`.
type ExitInfo struct {
	Code   int      `json:"code"`
	Stderr []string `json:"stderr,omitempty"`
}

// String 은 사람이 읽을 한 줄이다 — 뷰가 그대로 보인다. 비어 있으면 "".
func (e ExitInfo) String() string {
	if e.Code == 0 && len(e.Stderr) == 0 {
		return ""
	}
	s := fmt.Sprintf("exit %d", e.Code)
	if len(e.Stderr) > 0 {
		s += ": " + strings.Join(e.Stderr, " | ")
	}
	return s
}

// stderrTail 은 마지막 stderrTailLines 줄(합쳐 stderrTailBytes 이내)을 든다. StartPipe 의
// 읽기 고루틴이 쓰고 ExitInfo 가 읽는다.
type stderrTail struct {
	mu   sync.Mutex
	buf  []string
	size int
}

func newStderrTail() *stderrTail { return &stderrTail{} }

func (t *stderrTail) add(line string) {
	if len(line) > stderrTailBytes {
		line = line[:stderrTailBytes]
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, line)
	t.size += len(line)
	for len(t.buf) > stderrTailLines || (t.size > stderrTailBytes && len(t.buf) > 1) {
		t.size -= len(t.buf[0])
		t.buf = t.buf[1:]
	}
}

func (t *stderrTail) lines() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.buf...)
}
