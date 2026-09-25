package ipc

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-2 · FR-OPT-2-3 — 응답 없는 알림과 읽기 루프 밖의 생성.

// 알림(input·resizenotify)에는 응답이 없다. 없는 도구에 보내도 같다 — 보낸 쪽이
// 기다리지 않으므로 알릴 곳이 없다.
func TestNotifyNoReply(t *testing.T) {
	for _, m := range []struct{ method, params string }{
		{toolipc.MethodInput, `{"data":"aGk=","id":"none"}`},
		{toolipc.MethodResizeNotify, `{"cols":80,"id":"none","rows":24}`},
	} {
		got := wireOf(t, func(pc *panedConn) {
			pc.dispatch(&toolipc.PanedRequest{Method: m.method, Params: json.RawMessage(m.params)})
		})
		if got != "" {
			t.Fatalf("%s 알림에 응답이 나갔다: %s", m.method, got)
		}
	}
}

// 알림은 RPC 와 같은 자리(pm.Write·pm.Resize)에 닿는다.
func TestInputNotifyReachesTool(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	tl, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete(tl.ID)
	pc := newTestConn(pm)
	params, _ := json.Marshal(toolipc.ResizeParams{ID: tl.ID, Cols: 101, Rows: 33})
	pc.dispatch(&toolipc.PanedRequest{Method: toolipc.MethodResizeNotify, Params: params})
	if c, r, _ := pm.Get(tl.ID).Size(); c != 101 || r != 33 {
		t.Fatalf("size=%dx%d — resizenotify 가 닿지 않았다", c, r)
	}
	params, _ = json.Marshal(toolipc.WriteParams{ID: tl.ID, Data: []byte("echo notify-ok\n")})
	pc.dispatch(&toolipc.PanedRequest{Method: toolipc.MethodInput, Params: params})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snap, _ := pm.SnapshotToolSince(tl.ID, -1)
		if strings.Contains(string(snap.Data), "notify-ok") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("input 알림이 PTY 에 닿지 않았다")
}

// 데몬은 알림을 안다고 말한다 (D-OPT-1).
func TestDaemonSaysNotify(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureNotify) {
		t.Fatalf("DaemonFeatures=%v — notify 가 없다", toolipc.DaemonFeatures)
	}
}

func releaseOnce(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}

// pipeDaemon 은 handle() 을 도는 연결과, 그 반대편에 요청을 쓰고 응답을 읽는 손잡이다.
func pipeDaemon(t *testing.T, pm *toolhub.ToolManager) (send func(id int64, method string, params any), recv func() int64) {
	t.Helper()
	c1, c2 := net.Pipe()
	pc := newPanedConn(c1, pm)
	go func() { _ = pc.handle() }()
	t.Cleanup(func() { c2.Close(); pc.stop() })
	enc := json.NewEncoder(c2)
	sc := bufio.NewScanner(c2)
	lines := make(chan string, 64)
	go func() {
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	send = func(id int64, method string, params any) {
		raw, _ := json.Marshal(params)
		_ = c2.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := enc.Encode(toolipc.PanedRequest{ID: id, Method: method, Params: raw}); err != nil {
			t.Fatalf("send: %v", err)
		}
	}
	recv = func() int64 {
		t.Helper()
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatal("연결이 닫혔다")
			}
			var m struct {
				ID int64 `json:"id"`
			}
			_ = json.Unmarshal([]byte(l), &m)
			return m.ID
		case <-time.After(2 * time.Second):
			t.Fatal("응답이 오지 않았다")
		}
		return -1
	}
	return send, recv
}

// 샌드박스 배치(컨테이너 생성)가 멎어 있는 동안에도 같은 연결의 list 가 답을 받는다.
// 종전에는 dispatch 가 create 를 끝낼 때까지 다음 요청을 읽지 않았다.
func TestCreateDoesNotBlockDispatch(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	release := make(chan struct{})
	t.Cleanup(func() { releaseOnce(release) })
	pm.SetPlacer(func(toolhub.Placement) (*platform.ProcSpec, error) {
		<-release
		return nil, errors.New("placer released")
	})
	send, recv := pipeDaemon(t, pm)
	send(1, toolipc.MethodCreate, toolipc.CreateParams{Cwd: "/tmp", Cols: 80, Rows: 24, Profile: "p"})
	send(2, toolipc.MethodList, struct{}{})
	if id := recv(); id != 2 {
		t.Fatalf("첫 응답 id=%d — create 가 멎은 동안 list(2) 가 먼저 와야 한다", id)
	}
	releaseOnce(release)
	if id := recv(); id != 1 {
		t.Fatalf("둘째 응답 id=%d — create(1) 의 응답이어야 한다", id)
	}
}

// 느린 생성은 연결마다 panedSlowMax 개까지만 동시에 돈다.
func TestCreateConcurrencyBounded(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	release := make(chan struct{})
	t.Cleanup(func() { releaseOnce(release) })
	var cur, peak atomic.Int64
	pm.SetPlacer(func(toolhub.Placement) (*platform.ProcSpec, error) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		<-release
		cur.Add(-1)
		return nil, errors.New("placer released")
	})
	send, recv := pipeDaemon(t, pm)
	total := panedSlowMax + 2
	for i := 1; i <= total; i++ {
		send(int64(i), toolipc.MethodCreate, toolipc.CreateParams{Cwd: "/tmp", Cols: 80, Rows: 24, Profile: "p"})
	}
	// 동기: 뒤에 보낸 list 가 답을 받았으면 앞의 create 는 모두 읽혔다.
	send(100, toolipc.MethodList, struct{}{})
	if id := recv(); id != 100 {
		t.Fatalf("id=%d — list 가 먼저 와야 한다", id)
	}
	deadline := time.Now().Add(2 * time.Second)
	for cur.Load() < int64(panedSlowMax) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := peak.Load(); got != int64(panedSlowMax) {
		t.Fatalf("동시 배치 %d — %d 이어야 한다", got, panedSlowMax)
	}
	releaseOnce(release)
	for i := 0; i < total; i++ {
		recv()
	}
}
