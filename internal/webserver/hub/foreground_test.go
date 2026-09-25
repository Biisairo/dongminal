package hub

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
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

func (f *fakeHub) List() []toolhub.ToolInfo {
	f.calls.Add(1)
	return nil
}
func (f *fakeHub) count() int64                       { return f.calls.Load() }
func (f *fakeHub) ListOK() ([]toolhub.ToolInfo, bool) { return f.List(), true }
func (f *fakeHub) Connected() bool                    { return true }
func (f *fakeHub) Daemon() toolhub.DaemonHub          { return nil }
func (f *fakeHub) Create(string, uint16, uint16, toolhub.Placement) (*toolhub.Tool, error) {
	return nil, nil
}
func (f *fakeHub) Get(string) *toolhub.Tool                  { return nil }
func (f *fakeHub) Cwd(string) string                         { return "" }
func (f *fakeHub) Busy(string) bool                          { return false }
func (f *fakeHub) BusyMany([]string) (map[string]bool, bool) { return map[string]bool{}, true }
func (f *fakeHub) Delete(string) error                       { return nil }
func (f *fakeHub) Terminate(string, time.Duration) error     { return nil }
func (f *fakeHub) Write(string, []byte) error                { return nil }
func (f *fakeHub) SendPaste(string, []byte, bool) error      { return nil }
func (f *fakeHub) Resize(string, uint16, uint16) error       { return nil }
func (f *fakeHub) SnapshotTool(string) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (f *fakeHub) IsLive(string) bool                        { return false }
func (f *fakeHub) SetBackground(string, bool) bool           { return false }
func (f *fakeHub) BackgroundList() []toolhub.BackgroundEntry { return nil }

// TestStartForegroundPollStops는 드라이버가 stopCh 에서 실제로 멈추는 것을
// 확인한다. 멈추지 않으면 서버 종료 후에도 티커가 남아 데몬에 list RPC 를 계속
// 쏜다.
func TestStartForegroundPollStops(t *testing.T) {
	h := &fakeHub{}
	stop := make(chan struct{})
	tick := make(chan time.Time, 1)
	StartForegroundPoll(h, stop, tick)
	close(stop)
	// ③ 관측 창 — 멈춘 뒤 틱을 넣어도 **더 돌지 않음**을 잰다. 루프가 stop 과 틱을
	// 함께 볼 수 있으므로 멈출 시간을 먼저 준다.
	time.Sleep(50 * time.Millisecond)
	tick <- time.Now()
	time.Sleep(50 * time.Millisecond)
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
	StartForegroundPoll(nil, stop, make(chan time.Time)) // panic 하지 않으면 통과
}

// fakeDaemonHub 는 기능만 답하는 DaemonHub 대역이다.
type fakeDaemonHub struct{ features map[string]bool }

func (f fakeDaemonHub) Subscribe(string, chan toolhub.OutChunk) (<-chan struct{}, func()) {
	return nil, func() {}
}
func (f fakeDaemonHub) SnapshotToolSince(string, int64) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (f fakeDaemonHub) DaemonInfo() toolhub.DaemonInfo      { return toolhub.DaemonInfo{} }
func (f fakeDaemonHub) Reconnects() int64                   { return 0 }
func (f fakeDaemonHub) HasFeature(name string) bool         { return f.features[name] }
func (f fakeDaemonHub) InputNotify(string, []byte)          {}
func (f fakeDaemonHub) ResizeNotify(string, uint16, uint16) {}

type fakeDaemonToolHub struct {
	fakeHub
	d fakeDaemonHub
}

func (f *fakeDaemonToolHub) Daemon() toolhub.DaemonHub { return f.d }

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1: 전경 티커를 도는 데몬에는 폴이 List 를 부르지
// 않는다. 직접 모드와 옛 데몬에는 틱마다 한 번 부른다.
func TestStartForegroundPollSkipsDaemonTicker(t *testing.T) {
	cases := []struct {
		name string
		h    interface {
			toolhub.ToolHub
			count() int64
		}
		want int64
	}{
		{"direct", &fakeHub{}, 3},
		{"legacy-daemon", &fakeDaemonToolHub{d: fakeDaemonHub{}}, 3},
		{"fgtick-daemon", &fakeDaemonToolHub{d: fakeDaemonHub{features: map[string]bool{toolipc.FeatureForegroundTick: true}}}, 0},
	}
	for _, c := range cases {
		stop := make(chan struct{})
		tick := make(chan time.Time)
		StartForegroundPoll(c.h, stop, tick)
		// 버퍼 없는 틱 — 넷째 틱이 넘어갔다면 앞 셋의 일은 끝났다.
		for i := 0; i < 4; i++ {
			tick <- time.Now()
		}
		close(stop)
		if got := c.h.count(); got < c.want || (c.want == 0 && got != 0) || got > c.want+1 {
			t.Errorf("%s: List 호출=%d want %d", c.name, got, c.want)
		}
	}
}
