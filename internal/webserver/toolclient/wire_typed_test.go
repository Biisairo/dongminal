package toolclient

import (
	"bufio"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-6 · FR-OPT-2-8 — 서버가 보내는 바이트와 받는 방식.

// rawFake 는 받은 요청 줄을 **바이트 그대로** 모으는 가짜 데몬이다. hello 에는 hello
// 를, 나머지에는 reply 를 답한다.
func rawFake(t *testing.T, hello any, reply func(req toolipc.PanedRequest) any) (string, <-chan string) {
	t.Helper()
	sock := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	lines := make(chan string, 64)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		enc := json.NewEncoder(conn)
		sc := bufio.NewScanner(conn)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			line := sc.Text()
			var req toolipc.PanedRequest
			if json.Unmarshal([]byte(line), &req) != nil {
				return
			}
			select {
			case lines <- line:
			default:
			}
			if req.Method == toolipc.MethodHello {
				enc.Encode(toolipc.PanedResponse{ID: req.ID, Result: hello})
				continue
			}
			enc.Encode(reply(req))
		}
	}()
	return sock, lines
}

func nextLine(t *testing.T, lines <-chan string) string {
	t.Helper()
	select {
	case l := <-lines:
		return l
	case <-time.After(2 * time.Second):
		t.Fatal("요청이 오지 않았다")
		return ""
	}
}

// hello 는 쓰이지 않던 `server_pid` 를 싣지 않는다 (IPC-24). 서버가 아는 기능이
// 없으면 features 키도 없다 — 옛 데몬은 params 를 읽지 않으므로 무엇이든 호환된다.
func TestHelloParamsWire(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	if got, want := nextLine(t, lines), `{"id":0,"method":"hello","params":{}}`; got != want {
		t.Fatalf("hello 바이트\n got %s\nwant %s", got, want)
	}
}

// 서버→데몬 요청 바이트는 종전과 같다 (FR-OPT-0-3). 종전 map 부호화가 낸 글자를 골든으로 둔다.
func TestRequestWireGolden(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	nextLine(t, lines)

	steps := []struct {
		do   func()
		want string
	}{
		{func() {
			pc.Create("/tmp", 80, 24, toolhub.Placement{WindowUUID: "w", Profile: "p", Command: "c", Work: "k", ExtraEnv: []string{"A=1"}})
		}, `"method":"create","params":{"cols":80,"command":"c","cwd":"/tmp","extraEnv":["A=1"],"profile":"p","rows":24,"window":"w","work":"k"}}`},
		{func() { pc.Create("/", 1, 2, toolhub.Placement{}) },
			`"method":"create","params":{"cols":1,"command":"","cwd":"/","extraEnv":null,"profile":"","rows":2,"window":"","work":""}}`},
		{func() { pc.Delete("a") }, `"method":"kill","params":{"id":"a"}}`},
		{func() { pc.Terminate("a", 1500*time.Millisecond) }, `"method":"terminate","params":{"graceMs":1500,"id":"a"}}`},
		{func() { pc.Restore("a", "R", "/h", 100, 30) }, `"method":"restore","params":{"cols":100,"cwd":"/h","id":"a","name":"R","rows":30}}`},
		{func() { pc.Write("a", []byte("hi")) }, `"method":"write","params":{"data":"aGk=","id":"a"}}`},
		{func() { pc.Write("a", nil) }, `"method":"write","params":{"data":"","id":"a"}}`},
		{func() { pc.SendPaste("a", []byte("hi"), true) }, `"method":"paste","params":{"data":"aGk=","id":"a","submit":true}}`},
		{func() { pc.Resize("a", 90, 20) }, `"method":"resize","params":{"cols":90,"id":"a","rows":20}}`},
		{func() { pc.Cwd("a") }, `"method":"cwd","params":{"id":"a"}}`},
		{func() { pc.Busy("a") }, `"method":"busy","params":{"id":"a"}}`},
		{func() { pc.SetBackground("a", true) }, `"method":"setbackground","params":{"background":true,"id":"a"}}`},
		{func() { pc.BackgroundList() }, `"method":"backgroundlist","params":{}}`},
		{func() { pc.invalidateList(); pc.List() }, `"method":"list","params":{}}`},
		{func() { pc.SnapshotToolSince("a", 7) }, `"method":"snapshot","params":{"id":"a","since":7}}`},
	}
	for _, s := range steps {
		s.do()
		got := nextLine(t, lines)
		i := strings.Index(got, `"method"`)
		if i < 0 || got[i:] != s.want {
			t.Errorf("요청 바이트\n got %s\nwant …%s", got, s.want)
		}
	}
}

// Marshal 오류는 삼키지 않고 호출자에게 돌려준다 (IPC-22). 종전에는 params 가 null 로
// 나가 데몬이 엉뚱한 것을 답했다.
func TestCallMarshalErrorReturned(t *testing.T) {
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	_, err = pc.callWithin("x", func() {}, time.Second)
	var ute *json.UnsupportedTypeError
	if !errors.As(err, &ute) {
		t.Fatalf("Marshal 오류가 돌아오지 않았다: %v", err)
	}
	pc.mu.Lock()
	n := len(pc.pending)
	pc.mu.Unlock()
	if n != 0 {
		t.Fatalf("pending=%d — 실패한 호출이 남았다", n)
	}
}

// 소켓 쓰기는 pc.mu 밖에서 한다 (IPC-22). 쓰기가 막혀도 콜백 배선·응답 배달이 서지 않는다.
func TestBlockedWriteDoesNotHoldMu(t *testing.T) {
	sock := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	release := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		dec := json.NewDecoder(conn)
		var req toolipc.PanedRequest
		if dec.Decode(&req) == nil {
			json.NewEncoder(conn).Encode(toolipc.PanedResponse{ID: req.ID, Result: map[string]any{"version": toolipc.ProtocolVersion}})
		}
		// 이제 읽지 않는다 — 큰 쓰기는 커널 버퍼를 채우고 멈춘다.
		<-release
		conn.Close()
	}()
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	writeDone := make(chan struct{})
	go func() {
		pc.Write("a", make([]byte, 32<<20))
		close(writeDone)
	}()
	// 쓰기가 막힐 때까지 기다린다 — 끝나 버렸으면 이 검사는 아무것도 재지 않는다.
	select {
	case <-writeDone:
		t.Fatal("쓰기가 막히지 않았다 — 버퍼가 예상보다 크다")
	case <-time.After(200 * time.Millisecond):
	}
	got := make(chan struct{})
	go func() {
		pc.SetOnOutput(nil)
		close(got)
	}()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		close(release)
		<-writeDone
		pc.Close()
		t.Fatal("막힌 소켓 쓰기가 pc.mu 를 쥐고 있다")
	}
	close(release)
	<-writeDone
	pc.Close()
}

// hello.features 협상 (D-OPT-1): 데몬이 말한 기능만 쓴다. 말하지 않은 옛 데몬은
// 아무것도 갖지 않는다 — 판은 그대로 두고 강등한다.
func TestHelloFeaturesNegotiated(t *testing.T) {
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "build": "b", "features": []string{"f1"}}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	if !pc.HasFeature("f1") {
		t.Fatal("데몬이 말한 기능을 못 읽었다")
	}
	if pc.HasFeature("f2") {
		t.Fatal("말하지 않은 기능을 가졌다고 읽었다")
	}
}

// 옛 데몬(tool_ids 를 싣고 features 가 없다)과도 붙는다.
func TestHelloLegacyDaemonNoFeatures(t *testing.T) {
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "build": "old", "tool_ids": []string{"a"}}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("옛 데몬을 거부했다: %v", err)
	}
	defer pc.Close()
	if pc.HasFeature("f1") || pc.DaemonInfo().Build != "old" {
		t.Fatalf("info=%+v", pc.DaemonInfo())
	}
}

// 수신은 한 번 해석한다 (IPC-13). 해석 못 할 push 하나는 버리고 연결은 잇는다 —
// 종전에도 그 push 만 버려졌다.
func TestBadPushDroppedConnectionKept(t *testing.T) {
	sock := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dec := json.NewDecoder(conn)
		for {
			var req toolipc.PanedRequest
			if dec.Decode(&req) != nil {
				return
			}
			if req.Method == toolipc.MethodHello {
				conn.Write([]byte(`{"id":0,"result":{"version":1}}` + "\n"))
				continue
			}
			conn.Write([]byte(`{"event":"output","tool":"a","data":"!!!","end":1}` + "\n"))
			conn.Write([]byte(`{"event":"size","tool":"a","cols":"x","rows":1}` + "\n"))
			conn.Write([]byte(`{"event":"output","tool":"a","data":"aGk=","end":2}` + "\n"))
			conn.Write([]byte(`{"id":` + itoa(req.ID) + `,"error":{"code":"bad","message":"m"}}` + "\n"))
		}
	}()
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	got := make(chan string, 4)
	pc.SetOnOutput(func(id string, data []byte, end int64) { got <- string(data) })
	start := time.Now()
	if _, err := pc.call("x", struct{}{}); err == nil {
		t.Fatal("해석 못 한 오류 응답이 성공으로 읽혔다")
	}
	if time.Since(start) > time.Second {
		t.Fatal("해석 못 한 응답이 시한까지 매달렸다")
	}
	select {
	case d := <-got:
		if d != "hi" {
			t.Fatalf("data=%q — 깨진 push 가 전달됐다", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("깨진 push 뒤의 push 가 오지 않았다 — 연결이 끊겼다")
	}
	if !pc.Connected() {
		t.Fatal("연결이 끊겼다")
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
