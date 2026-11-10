package recordsync

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS §3.1a — 서버의 기록 쓰기 큐.

type fakeSender struct {
	mu   sync.Mutex
	sent []string
	err  error
}

func (f *fakeSender) send(kind, tool string, v json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, kind+"/"+tool+"="+string(v))
	return nil
}

func (f *fakeSender) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sent...)
}

func TestWriter_CoalescesPerKey(t *testing.T) {
	f := &fakeSender{}
	w := New(f.send)
	w.Put("usage", "t1", map[string]int{"a": 1})
	w.Put("usage", "t1", map[string]int{"a": 2})
	w.Put("limits", "", nil)
	w.Flush()
	got := f.got()
	if len(got) != 2 {
		t.Fatalf("sent=%v", got)
	}
	m := map[string]bool{}
	for _, g := range got {
		m[g] = true
	}
	if !m[`usage/t1={"a":2}`] || !m[`limits/=null`] {
		t.Fatalf("sent=%v", got)
	}
	w.Flush()
	if len(f.got()) != 2 {
		t.Fatal("보낸 값을 다시 보냈다")
	}
}

func TestWriter_TransientKeptUntilFlush(t *testing.T) {
	f := &fakeSender{err: errors.New("paned connection lost")}
	w := New(f.send)
	w.Put("usage", "t1", 1)
	w.Flush()
	f.mu.Lock()
	f.err = nil
	f.mu.Unlock()
	w.Flush()
	if got := f.got(); len(got) != 1 || got[0] != "usage/t1=1" {
		t.Fatalf("연결 오류 뒤 남은 값을 보내지 않았다: %v", got)
	}
}

func TestWriter_TransientDoesNotOverwriteNewer(t *testing.T) {
	var w *Writer
	calls := 0
	w = New(func(kind, tool string, v json.RawMessage) error {
		calls++
		if calls == 1 {
			w.Put(kind, tool, 2) // 보내는 사이 새 값이 왔다
			return errors.New("lost")
		}
		return nil
	})
	w.Put("usage", "t1", 1)
	w.Flush()
	w.mu.Lock()
	v := string(w.pending[key{"usage", "t1"}])
	w.mu.Unlock()
	if v != "2" {
		t.Fatalf("실패한 옛 값이 새 값을 덮었다: %q", v)
	}
}

func TestWriter_RPCErrorDropped(t *testing.T) {
	f := &fakeSender{err: &toolipc.RPCError{Code: toolipc.CodeNotFound, Message: "no tool"}}
	w := New(f.send)
	w.Put("usage", "gone", 1)
	w.Flush()
	f.mu.Lock()
	f.err = nil
	f.mu.Unlock()
	w.Flush()
	if got := f.got(); len(got) != 0 {
		t.Fatalf("데몬이 거절한 값을 다시 보냈다: %v", got)
	}
}

func TestWriter_StartSendsInBackground(t *testing.T) {
	f := &fakeSender{}
	w := New(f.send)
	stop := make(chan struct{})
	defer close(stop)
	w.Start(stop)
	w.Put("usage", "t1", 1)
	deadline := time.Now().Add(2 * time.Second)
	for len(f.got()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("배경 고루틴이 보내지 않았다")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWriter_NilIsNoop(t *testing.T) {
	var w *Writer
	w.Put("usage", "t1", 1)
	w.Flush()
}
