package toolclient

import (
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// ── OPTIMIZE_REFACTOR_SRS FR-OPT-1-2 (IPC-M1): 재접속 뒤의 구독 재동기 ──
//
// 끊긴 동안 끝난 도구의 exit push 는 오지 않는다. 재접속한 클라이언트가 살아 있는
// id 와 대조하지 않으면 그 구독은 exitCh 가 닫히지 않은 채 남고 onExit 도 돌지 않는다.

// fakeReconnectPaned 는 연결마다 lists[n] 을 list 응답으로 주는 가짜 데몬이다.
// lists[n] 이 nil 이면 그 연결의 list 는 오류다. drop 을 닫으면 첫 연결을 끊는다.
// 항목 "id:fg" 는 그 도구의 전경 이름을 fg 로 싣는다.
func fakeReconnectPaned(t *testing.T, lists [][]string, drop <-chan struct{}) string {
	t.Helper()
	sockPath := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for n := 0; ; n++ {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			var ids []string
			if n < len(lists) {
				ids = lists[n]
			}
			if n == 0 {
				go func(c net.Conn) { <-drop; c.Close() }(conn)
			}
			go serveReconnectConn(conn, ids)
		}
	}()
	return sockPath
}

func serveReconnectConn(conn net.Conn, ids []string) {
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	var mu sync.Mutex
	for {
		var req toolipc.PanedRequest
		if err := dec.Decode(&req); err != nil {
			return
		}
		var resp interface{}
		switch req.Method {
		case "list":
			if ids == nil {
				resp = map[string]interface{}{"id": req.ID, "error": map[string]interface{}{"code": 1, "message": "boom"}}
				break
			}
			tools := []interface{}{}
			for _, e := range ids {
				id, fg, _ := strings.Cut(e, ":")
				tools = append(tools, map[string]interface{}{"id": id, "name": id, "fgName": fg})
			}
			resp = toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"tools": tools}}
		default:
			resp = toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"version": toolipc.ProtocolVersion}}
		}
		mu.Lock()
		enc.Encode(resp)
		mu.Unlock()
	}
}

func waitClosed[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatalf("%s: 닫히지 않고 값이 왔다", what)
		}
	case <-time.After(8 * time.Second):
		t.Fatalf("%s: 재접속 뒤에도 닫히지 않았다", what)
	}
}

func assertOpen[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case <-ch:
		t.Fatalf("%s: 닫히면 안 된다", what)
	default:
	}
}

// 끊긴 동안 사라진 도구(t2: 구독 있음, t3: 구독 없음)는 exit 가 합성되고, 살아 있는
// 도구(t1)의 구독은 exit 없이 출력 채널이 닫혀 브라우저가 since 로 재동기한다.
func TestTCResyncSubs(t *testing.T) {
	drop := make(chan struct{})
	sockPath := fakeReconnectPaned(t, [][]string{{"t1", "t2", "t3"}, {"t1"}}, drop)
	pc, err := DialPaneClientWithReconnect(sockPath, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	var mu sync.Mutex
	exited := map[string]bool{}
	pc.SetOnExit(func(id string, _ toolhub.ExitInfo) {
		mu.Lock()
		exited[id] = true
		mu.Unlock()
	})
	if l := pc.List(); len(l) != 3 {
		t.Fatalf("첫 목록 len=%d want 3", len(l))
	}
	ch1 := make(chan OutChunk, 4)
	ex1, _ := pc.Subscribe("t1", ch1)
	ch2 := make(chan OutChunk, 4)
	ex2, _ := pc.Subscribe("t2", ch2)

	close(drop)

	waitClosed(t, ex2, "사라진 도구 t2 의 exitCh")
	waitClosed(t, ch1, "살아 있는 도구 t1 의 출력 채널")
	assertOpen(t, ex1, "살아 있는 도구 t1 의 exitCh")

	// onExit 는 채널을 닫은 **뒤에** 돈다 — 채널이 닫힌 것만으로는 합성이 끝났다고
	// 볼 수 없으므로 기한 안에서 기다린다.
	deadline := time.Now().Add(8 * time.Second)
	for {
		mu.Lock()
		if exited["t2"] && exited["t3"] {
			break
		}
		if time.Now().After(deadline) {
			defer mu.Unlock()
			t.Fatalf("사라진 도구의 onExit 가 합성되지 않았다: %v", exited)
		}
		mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	defer mu.Unlock()
	if exited["t1"] {
		t.Fatal("살아 있는 도구 t1 에 onExit 가 불렸다")
	}
	pc.subMu.RLock()
	n := len(pc.subbers)
	pc.subMu.RUnlock()
	if n != 0 {
		t.Fatalf("재동기 뒤 subbers 가 남았다: %d", n)
	}
}

// 재접속 뒤 목록을 모르면(list 실패) 죽었다고 판정하지 않는다 — exit 를 합성하지
// 않고, 구독은 전부 재동기(출력 채널 닫기)로 돌린다. 재접속한 브라우저의 snapshot
// 이 존재를 다시 판정한다.
func TestTCResyncUnknown(t *testing.T) {
	drop := make(chan struct{})
	sockPath := fakeReconnectPaned(t, [][]string{{"t1"}, nil}, drop)
	pc, err := DialPaneClientWithReconnect(sockPath, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	var mu sync.Mutex
	var exits int
	pc.SetOnExit(func(string, toolhub.ExitInfo) {
		mu.Lock()
		exits++
		mu.Unlock()
	})
	pc.List()
	ch1 := make(chan OutChunk, 4)
	ex1, _ := pc.Subscribe("t1", ch1)

	close(drop)

	waitClosed(t, ch1, "t1 의 출력 채널")
	assertOpen(t, ex1, "t1 의 exitCh")
	mu.Lock()
	defer mu.Unlock()
	if exits != 0 {
		t.Fatalf("목록을 모르는데 exit 를 %d 번 합성했다", exits)
	}
}

// 끊긴 동안 바뀐 전경 이름은 push 로 오지 않는다 — 데몬 티커가 그 사이에 캐시를
// 고치고 받을 연결이 없어 버린다 (FR-OPT-2-1). 재접속 뒤 목록과 대조해 달라진 것만
// onForeground 로 메운다. 같은 값(t2)은 되풀이하지 않는다 (FR-TAN-9).
func TestTCResyncForeground(t *testing.T) {
	drop := make(chan struct{})
	sockPath := fakeReconnectPaned(t, [][]string{{"t1", "t2"}, {"t1:htop", "t2"}}, drop)
	pc, err := DialPaneClientWithReconnect(sockPath, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	got := make(chan [2]string, 4)
	pc.SetOnForeground(func(id, name string) { got <- [2]string{id, name} })
	pc.List()

	close(drop)

	select {
	case g := <-got:
		if g != [2]string{"t1", "htop"} {
			t.Fatalf("onForeground=%v want [t1 htop]", g)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("재접속 뒤 달라진 전경 이름이 알려지지 않았다")
	}
	select {
	case g := <-got:
		t.Fatalf("바뀌지 않은 도구까지 알렸다: %v", g)
	case <-time.After(200 * time.Millisecond):
	}
}
