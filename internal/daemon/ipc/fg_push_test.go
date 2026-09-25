package ipc

import (
	"bytes"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1: 데몬 모드에서는 list 폴이 없으므로 fg push 가
// 이름을 전하는 유일한 길이다. 큐가 차 있어도 버리지 않고 자리가 날 때까지 기다린다.
func TestPushForegroundNotDropped(t *testing.T) {
	pc := &panedConn{out: make(chan interface{}, 1), done: make(chan struct{})}
	pc.out <- "busy"
	returned := make(chan struct{})
	go func() { pc.pushForeground("t1", "vim"); close(returned) }()
	// 큐가 찬 동안 돌아오면 버린 것이다. 기다리는 쪽은 자리가 날 때까지 돌아오지 않는다.
	select {
	case <-returned:
		t.Fatal("큐가 찬 채로 돌아왔다 — fg push 를 버렸다")
	case <-time.After(100 * time.Millisecond):
	}
	<-pc.out
	select {
	case v := <-pc.out:
		ev, ok := v.(toolipc.ForegroundEvent)
		if !ok || ev.Tool != "t1" || ev.Name != "vim" {
			t.Fatalf("push=%#v", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("큐가 찬 동안의 fg push 가 버려졌다")
	}
}

// FR-OPT-2-1: list 핸들러는 전경을 조회하지 않고 캐시만 싣는다 (ListCached). 조회는
// 데몬의 티커가 돌린다 — dispatch 안에서 돌면 그동안 이 연결의 입력이 줄을 선다.
func TestListHandlerDoesNotProbe(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	if err := pm.Restore("5", "R", t.TempDir(), 80, 24); err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete("5")
	var probes atomic.Int64
	restore := toolhub.SetForegroundProbe(func(ids []string) map[string]string {
		probes.Add(1)
		return map[string]string{"5": "vim"}
	})
	defer restore()

	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodList, Params: json.RawMessage(`{}`)})
	if n := probes.Load(); n != 0 {
		t.Fatalf("list 핸들러가 전경을 %d회 조회했다 — 0 이어야 한다", n)
	}
	// 바꿔 끼운 조회가 실제로 쓰이는지 — 티커의 갱신은 한 번 부른다.
	pm.RefreshForeground()
	if n := probes.Load(); n != 1 {
		t.Fatalf("RefreshForeground 가 조회를 %d회 불렀다 — 1 이어야 한다", n)
	}
	// 캐시에 든 값은 list 가 싣는다.
	buf.Reset()
	pc.dispatch(&toolipc.PanedRequest{ID: 2, Method: toolipc.MethodList, Params: json.RawMessage(`{}`)})
	if !bytes.Contains(buf.Bytes(), []byte(`"fgName":"vim"`)) || probes.Load() != 1 {
		t.Fatalf("list=%s probes=%d — 캐시의 vim 을 조회 없이 실어야 한다", buf.Bytes(), probes.Load())
	}
}
