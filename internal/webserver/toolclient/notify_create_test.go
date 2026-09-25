package toolclient

import (
	"bufio"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-2 · FR-OPT-2-3 — 응답 없는 입력 알림과 create 비동기.

func dialFake(t *testing.T, sock string) *ToolClient {
	t.Helper()
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(pc.Close)
	return pc
}

func noLine(t *testing.T, lines <-chan string) {
	t.Helper()
	select {
	case l := <-lines:
		t.Fatalf("더 나가면 안 되는 요청이 나갔다: %s", l)
	case <-time.After(100 * time.Millisecond):
	}
}

// notify 를 말하는 데몬에게 키 입력·리사이즈는 id 없는 알림 한 줄이다. 응답을
// 기다리지 않는다 — 가짜 데몬은 답하지 않는다. 키 하나의 프레임: 2 → 1.
func TestInputNotifyOneFrame(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "features": []string{toolipc.FeatureNotify}}, func(req toolipc.PanedRequest) any {
		return nil
	})
	pc := dialFake(t, sock)
	nextLine(t, lines) // hello
	var d toolhub.DaemonHub = pc
	for i := 0; i < 3; i++ {
		d.InputNotify("t1", []byte("a"))
	}
	d.ResizeNotify("t1", 100, 30)
	for i := 0; i < 3; i++ {
		if got, want := nextLine(t, lines), `{"method":"input","params":{"data":"YQ==","id":"t1"}}`; got != want {
			t.Fatalf("input 알림\n got %s\nwant %s", got, want)
		}
	}
	if got, want := nextLine(t, lines), `{"method":"resizenotify","params":{"cols":100,"id":"t1","rows":30}}`; got != want {
		t.Fatalf("resize 알림\n got %s\nwant %s", got, want)
	}
	noLine(t, lines)
}

// 교차 판: 새 서버 · 옛 데몬. notify 를 말하지 않으면 종전의 write·resize RPC 다 —
// 옛 데몬은 input 을 모르는 메서드로 답한다.
func TestInputNotifyLegacyDaemon(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc := dialFake(t, sock)
	nextLine(t, lines) // hello
	pc.InputNotify("t1", []byte("a"))
	pc.ResizeNotify("t1", 100, 30)
	if got, want := nextLine(t, lines), `{"id":1,"method":"write","params":{"data":"YQ==","id":"t1"}}`; got != want {
		t.Fatalf("옛 데몬 입력\n got %s\nwant %s", got, want)
	}
	if got, want := nextLine(t, lines), `{"id":2,"method":"resize","params":{"cols":100,"id":"t1","rows":30}}`; got != want {
		t.Fatalf("옛 데몬 리사이즈\n got %s\nwant %s", got, want)
	}
}

// HTTP send-input 의 Write 는 알림을 말하는 데몬에게도 RPC 다 — 오류를 돌려줘야 한다 (GO-8).
func TestWriteStaysRPC(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "features": []string{toolipc.FeatureNotify}}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeServer, Message: "toolhub: tool not found"}}
	})
	pc := dialFake(t, sock)
	nextLine(t, lines)
	if err := pc.Write("gone", []byte("a")); err == nil {
		t.Fatal("없는 도구에 쓴 Write 가 성공으로 돌아왔다")
	}
	if got, want := nextLine(t, lines), `{"id":1,"method":"write","params":{"data":"YQ==","id":"gone"}}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

// concFake 는 create 를 읽기 루프 밖에서 답하는 가짜 데몬이다 — 새 데몬의 모양.
// create 가 오면 created 로 알리고 release 가 닫힐 때까지 기다린 뒤 도구 "new" 를
// 목록에 넣고 답한다. holdList 면 첫 list 를 붙들었다가 create 응답 **뒤에** 낡은
// 목록으로 답한다. 그 밖의 list 는 지금 목록으로 곧장 답한다.
type concFake struct {
	created  chan struct{}
	listed   chan struct{}
	release  chan struct{}
	holdList bool
	delay    time.Duration

	mu    sync.Mutex
	tools []toolhub.ToolInfo
}

func (f *concFake) serve(t *testing.T) string {
	t.Helper()
	sock := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var wmu sync.Mutex
		enc := json.NewEncoder(conn)
		send := func(v any) {
			wmu.Lock()
			enc.Encode(v)
			wmu.Unlock()
		}
		var held *toolipc.PanedRequest
		var staleTools []toolhub.ToolInfo
		sc := bufio.NewScanner(conn)
		for sc.Scan() {
			var req toolipc.PanedRequest
			if json.Unmarshal(sc.Bytes(), &req) != nil {
				return
			}
			switch req.Method {
			case toolipc.MethodHello:
				send(toolipc.PanedResponse{ID: req.ID, Result: map[string]any{"version": toolipc.ProtocolVersion}})
			case toolipc.MethodList:
				f.mu.Lock()
				cur := f.tools
				f.mu.Unlock()
				if f.holdList && held == nil {
					r := req
					held, staleTools = &r, cur
					f.listed <- struct{}{}
					continue
				}
				send(toolipc.PanedResponse{ID: req.ID, Result: toolipc.ListResult{Tools: cur}})
			case toolipc.MethodCreate:
				id := req.ID
				go func() {
					f.created <- struct{}{}
					<-f.release
					time.Sleep(f.delay)
					f.mu.Lock()
					f.tools = append(f.tools, toolhub.ToolInfo{ID: "new", Name: "new"})
					f.mu.Unlock()
					send(toolipc.PanedResponse{ID: id, Result: toolipc.CreateResult{ID: "new", Name: "new", Cols: 80, Rows: 24}})
				}()
				if f.holdList && held != nil {
					// create 응답이 먼저 나가고 붙든 list 가 낡은 목록으로 뒤따른다.
					h, stale := held, staleTools
					go func() {
						<-f.release
						time.Sleep(f.delay + 50*time.Millisecond)
						send(toolipc.PanedResponse{ID: h.ID, Result: toolipc.ListResult{Tools: stale}})
					}()
				}
			}
		}
	}()
	return sock
}

func newConcFake() *concFake {
	return &concFake{created: make(chan struct{}, 8), listed: make(chan struct{}, 8), release: make(chan struct{})}
}

func hasTool(tools []toolhub.ToolInfo, id string) bool {
	for _, t := range tools {
		if t.ID == id {
			return true
		}
	}
	return false
}

func waitCh(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("%s 가 오지 않았다", what)
	}
}

// 세대 검사 (FR-OPT-2-3 의 전제 확인). 데몬이 create 를 기다리는 동안의 list 는
// create 앞의 목록으로 곧장 답을 받는다. 그 목록이 캐시에 남아도 Create 가 돌아온
// 뒤의 List 는 새 도구를 본다 — Create 가 돌아온 뒤 무효화한다.
func TestListDuringCreate(t *testing.T) {
	f := newConcFake()
	pc := dialFake(t, f.serve(t))
	done := make(chan error, 1)
	go func() {
		_, err := pc.Create("/tmp", 80, 24, toolhub.Placement{})
		done <- err
	}()
	waitCh(t, f.created, "create")
	tools, ok := pc.ListOK()
	if !ok || hasTool(tools, "new") {
		t.Fatalf("create 중의 list: ok=%v tools=%v — 앞의 목록이어야 한다", ok, tools)
	}
	close(f.release)
	if err := <-done; err != nil {
		t.Fatalf("create: %v", err)
	}
	if tools, ok := pc.ListOK(); !ok || !hasTool(tools, "new") {
		t.Fatalf("Create 뒤의 list 가 새 도구를 보지 못했다: ok=%v tools=%v", ok, tools)
	}
}

// create 보다 먼저 보낸 list 의 답이 create 응답 **뒤에** 와도(데몬이 create 를 끝낸
// 뒤 list 의 답을 큐에 넣은 경우) 그 낡은 목록은 캐시되지 않는다 — Create 가 보내기
// 전에 올린 세대가 막는다.
func TestStaleListAfterCreate(t *testing.T) {
	f := newConcFake()
	f.holdList = true
	pc := dialFake(t, f.serve(t))
	listDone := make(chan []toolhub.ToolInfo, 1)
	go func() {
		tools, _ := pc.ListOK()
		listDone <- tools
	}()
	waitCh(t, f.listed, "list")
	createDone := make(chan error, 1)
	go func() {
		_, err := pc.Create("/tmp", 80, 24, toolhub.Placement{})
		createDone <- err
	}()
	waitCh(t, f.created, "create")
	close(f.release)
	if err := <-createDone; err != nil {
		t.Fatalf("create: %v", err)
	}
	if stale := <-listDone; hasTool(stale, "new") {
		t.Fatalf("붙든 list 는 낡은 목록이어야 한다: %v", stale)
	}
	if tools, ok := pc.ListOK(); !ok || !hasTool(tools, "new") {
		t.Fatalf("낡은 list 응답이 캐시에 남았다: ok=%v tools=%v", ok, tools)
	}
}

// 샌드박스 배치는 기본 시한(panedCallTimeout)보다 오래 걸린다. Create 는 전용 시한
// (toolCreateTimeout)을 쓴다 — 기본 시한이 지나도 연결을 끊지 않고 답을 받는다.
func TestCreateOutlivesCallTimeout(t *testing.T) {
	t.Parallel()
	if toolCreateTimeout <= panedCallTimeout {
		t.Fatalf("toolCreateTimeout=%v — panedCallTimeout(%v) 보다 길어야 한다", toolCreateTimeout, panedCallTimeout)
	}
	f := newConcFake()
	f.delay = panedCallTimeout + 300*time.Millisecond
	close(f.release)
	pc := dialFake(t, f.serve(t))
	tl, err := pc.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if tl.ID != "new" || pc.Reconnects() != 0 {
		t.Fatalf("id=%q reconnects=%d", tl.ID, pc.Reconnects())
	}
}
