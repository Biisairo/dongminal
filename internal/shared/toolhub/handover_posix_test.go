//go:build !windows

package toolhub

import (
	"bytes"
	"encoding/json"
	"strings"
	"syscall"
	"testing"
	"time"
)

// DAEMON_SESSION_KEEP_SRS FR-DSK-14·21~23 (TC-DSK-7·8): 멈춘 도구를 담아 다른 관리자가 같은
// 셸로 다시 쥔다. exec 는 같은 프로세스의 fd 를 넘기므로 Dup 으로 흉내 낸다.
func TestHandover_ExportThenAdopt(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 90, 30, Placement{Command: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Write([]byte("before\n")); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "첫 출력", func() bool { return strings.Count(string(snap(p)), "before") >= 2 })
	p.RestoreAgentState(AgentState{AgentSeen: true, Attention: true})
	p.SetRecord("usage", json.RawMessage(`{"n":1}`))
	m.SetBackground(p.ID, true)

	if !m.FreezeAll() {
		t.Fatal("멈추지 못했다")
	}
	tools, err := m.ExportHandover()
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 {
		t.Fatalf("담은 도구 %d개", len(tools))
	}
	ht := tools[0]
	if ht.ID != p.ID || ht.PID != p.CmdProcessPID() || ht.Cols != 90 || ht.Rows != 30 || !ht.Background {
		t.Fatalf("담은 값 = %+v", ht)
	}
	if !bytes.Equal(ht.Screen, snap(p)) || ht.Offset != p.Stream().Offset() {
		t.Fatal("화면 내용이나 좌표가 다르다")
	}
	// 멈춘 동안 셸이 낸 출력은 커널에 남아 새 쪽이 읽는다 (NFR-DSK-2).
	if err := p.Write([]byte("during\n")); err != nil {
		t.Fatal(err)
	}

	fd, err := syscall.Dup(int(ht.FD))
	if err != nil {
		t.Fatal(err)
	}
	ht.FD = uintptr(fd)
	m2 := newTestManager(t)
	if err := m2.AdoptHandover(ht); err != nil {
		t.Fatal(err)
	}
	q := m2.Get(p.ID)
	if q == nil {
		t.Fatal("같은 id 의 도구가 없다")
	}
	t.Cleanup(func() {
		m2.Delete(q.ID)
		_ = p.term.Close()
	})
	if q.CmdProcessPID() != ht.PID || !m2.IsBackground(q.ID) {
		t.Fatalf("pid=%d background=%v", q.CmdProcessPID(), m2.IsBackground(q.ID))
	}
	if st := q.AgentState(); !st.AgentSeen || !st.Attention {
		t.Fatalf("에이전트 기록을 잃었다: %+v", st)
	}
	if string(q.Records()["usage"]) != `{"n":1}` {
		t.Fatalf("기록 = %v", q.Records())
	}
	waitUntil(t, "멈춘 동안의 출력", func() bool { return strings.Count(string(snap(q)), "during") >= 2 })
	if !strings.HasPrefix(string(snap(q)), string(ht.Screen)) {
		t.Fatal("넘겨받은 화면 뒤에 이어지지 않는다")
	}
}

// FR-DSK-13: 멈추지 않은 관리자는 담지 않는다.
func TestHandover_ExportRequiresFreeze(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Delete(p.ID) })
	if _, err := m.ExportHandover(); err == nil {
		t.Fatal("멈추지 않았는데 담았다")
	}
}

func snap(p *Tool) []byte {
	b, _ := p.Stream().Snapshot()
	return b
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s 을(를) 기다리다 시한을 넘겼다", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
