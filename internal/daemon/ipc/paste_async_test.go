package ipc

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// asyncConn 은 응답을 채널로 받는 연결이다 (writeLoop 없이 out 만 둔다).
func asyncConn(t *testing.T, ids ...string) *panedConn {
	t.Helper()
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	for _, id := range ids {
		if err := pm.Restore(id, "R", t.TempDir(), 80, 24); err != nil {
			t.Skipf("PTY 생성 불가(환경): %v", err)
		}
		t.Cleanup(func() { pm.Delete(id) })
	}
	return &panedConn{pm: pm, out: make(chan interface{}, 16), done: make(chan struct{})}
}

func respID(t *testing.T, v interface{}) int64 {
	t.Helper()
	b, _ := json.Marshal(v)
	var r struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(b, &r)
	return r.ID
}

func guardedPaste(id int64, tool string) *toolipc.PanedRequest {
	return &toolipc.PanedRequest{ID: id, Method: toolipc.MethodPaste,
		Params: json.RawMessage(`{"id":"` + tool + `","data":"aGk=","submit":true,"foreground":"claude"}`)}
}

// S6: 전경 조건이 있는 paste 가 전경 조회·제출 틈을 기다리는 동안에도 이 연결의 다른
// 요청은 바로 답한다.
func TestGuardedPasteDoesNotBlockDispatch(t *testing.T) {
	pc := asyncConn(t, "a")
	release := make(chan struct{})
	t.Cleanup(toolhub.SetForegroundProbe(func(ids []string) map[string]string {
		<-release
		return map[string]string{ids[0]: "claude"}
	}))
	// 읽기 루프 자리. 지금 구현이 막히면 이 고루틴이 멈출 뿐 시험은 시한으로 끝난다.
	go func() {
		pc.dispatch(guardedPaste(1, "a"))
		pc.dispatch(&toolipc.PanedRequest{ID: 2, Method: toolipc.MethodBusy, Params: json.RawMessage(`{"id":"a"}`)})
	}()
	select {
	case v := <-pc.out:
		if respID(t, v) != 2 {
			close(release)
			t.Fatalf("먼저 온 응답 id=%d", respID(t, v))
		}
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("조건부 paste 가 다른 요청을 막았다")
	}
	close(release)
	select {
	case v := <-pc.out:
		if respID(t, v) != 1 {
			t.Fatalf("paste 응답 id=%d", respID(t, v))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("paste 응답이 없다")
	}
}

// S6: 같은 도구의 조건부 paste 끼리는 차례를 지킨다 — 한 paste 의 글과 제출 사이에 다른
// paste 가 끼지 않는다. 다른 도구는 기다리지 않는다.
func TestGuardedPasteSerializedPerTool(t *testing.T) {
	pc := asyncConn(t, "a", "b")
	var mu sync.Mutex
	inA, maxA := 0, 0
	var probes atomic.Int32
	t.Cleanup(toolhub.SetForegroundProbe(func(ids []string) map[string]string {
		probes.Add(1)
		if ids[0] == "a" {
			mu.Lock()
			inA++
			if inA > maxA {
				maxA = inA
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			inA--
			mu.Unlock()
		}
		return map[string]string{ids[0]: "claude"}
	}))
	pc.dispatch(guardedPaste(1, "a"))
	pc.dispatch(guardedPaste(2, "a"))
	pc.dispatch(guardedPaste(3, "b"))
	got := map[int64]bool{}
	for range 3 {
		select {
		case v := <-pc.out:
			got[respID(t, v)] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("응답이 모자란다 %v", got)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if maxA != 1 {
		t.Fatalf("같은 도구의 paste 가 겹쳤다 (동시 %d)", maxA)
	}
	if probes.Load() != 6 {
		t.Fatalf("전경 조회 %d, 기대 6 (paste 마다 2)", probes.Load())
	}
}
