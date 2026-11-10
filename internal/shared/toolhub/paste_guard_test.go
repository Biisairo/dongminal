package toolhub

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// recTerm 은 쓴 바이트를 모으는 가짜 터미널이다.
type recTerm struct {
	platform.Terminal
	mu  sync.Mutex
	buf bytes.Buffer
}

func (t *recTerm) PID() int { return 4321 }
func (t *recTerm) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.Write(p)
}
func (t *recTerm) written() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

// guardFixture 는 전경 조회를 차례대로 답하는 도구 하나다.
func guardFixture(t *testing.T, answers ...string) (*ToolManager, *recTerm, *int) {
	t.Helper()
	term := &recTerm{}
	m := NewToolManager(t.TempDir(), nil)
	m.Adopt(&Tool{ID: "a", term: term})
	calls := 0
	restore := SetForegroundProbe(func(ids []string) map[string]string {
		name := answers[len(answers)-1]
		if calls < len(answers) {
			name = answers[calls]
		}
		calls++
		return map[string]string{"a": name}
	})
	t.Cleanup(restore)
	return m, term, &calls
}

// PEER_NETWORK_SRS I-47: 붙여넣기 직전에 전경을 **새로** 조회한다. 기대한 프로그램이면 쓴다.
func TestSendPasteIfForeground_Writes(t *testing.T) {
	m, term, calls := guardFixture(t, "claude")
	if err := m.SendPasteIfForeground("a", []byte("hi"), true, "claude"); err != nil {
		t.Fatal(err)
	}
	if got := term.written(); got != "hi\r" {
		t.Fatalf("쓴 것 %q", got)
	}
	if *calls != 2 {
		t.Fatalf("쓰기 전과 Enter 전에 한 번씩 조회해야 한다: %d", *calls)
	}
}

// 전경이 바뀌었으면(셸로 돌아감) 아무것도 쓰지 않는다. 캐시가 "claude" 여도 마찬가지다.
func TestSendPasteIfForeground_RefusesShell(t *testing.T) {
	m, term, _ := guardFixture(t, "")
	m.fgMu.Lock()
	m.fgCache = map[string]fgEntry{"a": {name: "claude", at: time.Now()}}
	m.fgMu.Unlock()
	err := m.SendPasteIfForeground("a", []byte("rm -rf ~\n"), true, "claude")
	if !errors.Is(err, ErrForegroundChanged) {
		t.Fatalf("err = %v", err)
	}
	if got := term.written(); got != "" {
		t.Fatalf("셸에 썼다 %q", got)
	}
}

// 붙여넣은 뒤 Enter 직전에 바뀌었으면 Enter 를 누르지 않는다.
func TestSendPasteIfForeground_NoSubmitAfterChange(t *testing.T) {
	m, term, _ := guardFixture(t, "claude", "")
	err := m.SendPasteIfForeground("a", []byte("hi"), true, "claude")
	if !errors.Is(err, ErrForegroundChanged) {
		t.Fatalf("err = %v", err)
	}
	if got := term.written(); got != "hi" {
		t.Fatalf("쓴 것 %q", got)
	}
}
