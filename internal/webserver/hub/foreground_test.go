package hub

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
)

// TestToolForegroundPayload는 tool_foreground 의 와이어 모양을 고정한다.
// 브라우저(app-cmd.js)가 이 키들을 그대로 읽으므로 이름이 바뀌면 조용히 깨진다.
func TestToolForegroundPayload(t *testing.T) {
	p := toolForegroundPayload("t1", "vim")
	if !bytes.Contains(p, []byte(`"action":"tool_foreground"`)) ||
		!bytes.Contains(p, []byte(`"toolId":"t1"`)) ||
		!bytes.Contains(p, []byte(`"name":"vim"`)) {
		t.Fatalf("unexpected payload: %s", p)
	}
}

// TestToolForegroundPayloadEmptyName은 빈 이름이 **생략되지 않고** 실려 나가는
// 것을 고정한다 (FR-TAN-12). 전경 프로그램이 끝났다는 사실은 빈 문자열로만
// 전달되므로, omitempty 류로 키가 사라지면 탭 이름이 Shell 로 돌아오지 못한다.
func TestToolForegroundPayloadEmptyName(t *testing.T) {
	p := toolForegroundPayload("t1", "")
	if !bytes.Contains(p, []byte(`"name":""`)) {
		t.Fatalf("빈 이름이 실리지 않았다: %s", p)
	}
}

// fakeBroker는 CommandBroker 중 Broadcast 만 쓰는 테스트 대역이다.
type fakeBroker struct {
	mu   sync.Mutex
	sent [][]byte
}

func (f *fakeBroker) Add() *CmdSub   { return nil }
func (f *fakeBroker) Remove(*CmdSub) {}
func (f *fakeBroker) Broadcast(p []byte) int {
	f.mu.Lock()
	f.sent = append(f.sent, append([]byte(nil), p...))
	f.mu.Unlock()
	return 1
}
func (f *fakeBroker) BroadcastAndAwait([]byte, string, time.Duration) (CmdResult, int, bool) {
	return CmdResult{}, 0, false
}
func (f *fakeBroker) DeliverResult(string, CmdResult) {}

func (f *fakeBroker) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

// TestBroadcastForeground는 콜백이 곧 Broadcast 임을 고정한다. V-TAN-13 의
// "같은 값을 반복 전송하지 않는다"는 이 층의 책임이 **아니다** —
// SetForegroundNotifier 가 바뀌었을 때만 부르는 계약이고, 여기에 억제를 다시
// 쌓으면 두 곳이 같은 판단을 하게 된다. 그 계약은 toolhub 쪽 테스트가 지킨다.
func TestBroadcastForeground(t *testing.T) {
	b := &fakeBroker{}
	notify := BroadcastForeground(b)
	notify("t1", "claude")
	notify("t1", "")
	if b.count() != 2 {
		t.Fatalf("Broadcast 호출=%d want 2", b.count())
	}
	if !bytes.Contains(b.sent[0], []byte(`"name":"claude"`)) {
		t.Fatalf("첫 payload=%s", b.sent[0])
	}
	if !bytes.Contains(b.sent[1], []byte(`"name":""`)) {
		t.Fatalf("둘째 payload=%s", b.sent[1])
	}
}

// fakeHub는 List 호출 횟수만 세는 toolhub.ToolHub 대역이다.
type fakeHub struct{ calls atomic.Int64 }

func (f *fakeHub) List() []map[string]interface{} {
	f.calls.Add(1)
	return nil
}
func (f *fakeHub) Create(string, uint16, uint16) (*toolhub.Tool, error) { return nil, nil }
func (f *fakeHub) Get(string) *toolhub.Tool                             { return nil }
func (f *fakeHub) Cwd(string) string                                    { return "" }
func (f *fakeHub) Busy(string) bool                                     { return false }
func (f *fakeHub) Delete(string)                                        {}
func (f *fakeHub) Write(string, []byte) error                           { return nil }
func (f *fakeHub) SendPaste(string, []byte, bool) error                 { return nil }
func (f *fakeHub) Resize(string, uint16, uint16) error                  { return nil }
func (f *fakeHub) SnapshotTool(string) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (f *fakeHub) IsLive(string) bool                        { return false }
func (f *fakeHub) IsDaemon() bool                            { return false }
func (f *fakeHub) SetBackground(string, bool) bool           { return false }
func (f *fakeHub) BackgroundList() []toolhub.BackgroundEntry { return nil }

// TestStartForegroundPollStops는 드라이버가 stopCh 에서 실제로 멈추는 것을
// 확인한다. 멈추지 않으면 서버 종료 후에도 티커가 남아 데몬에 list RPC 를 계속
// 쏜다.
func TestStartForegroundPollStops(t *testing.T) {
	h := &fakeHub{}
	stop := make(chan struct{})
	StartForegroundPoll(h, stop)
	close(stop)
	time.Sleep(ForegroundInterval + 200*time.Millisecond)
	if got := h.calls.Load(); got != 0 {
		t.Fatalf("정지 후 List 호출=%d — 0 이어야 한다", got)
	}
}

// TestStartForegroundPollNilHub는 도구 허브가 없을 때(구성 실패 경로) 조용히
// 아무것도 하지 않는 것을 고정한다 — FR-TAN-24 의 "오류를 내지 않는다"와 같은
// 태도다.
func TestStartForegroundPollNilHub(t *testing.T) {
	stop := make(chan struct{})
	defer close(stop)
	StartForegroundPoll(nil, stop) // panic 하지 않으면 통과
}
