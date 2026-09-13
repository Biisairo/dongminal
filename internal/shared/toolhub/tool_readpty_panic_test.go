package toolhub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/platform"
)

// wsPair 는 실제 *websocket.Conn 한 쌍이다 — 서버 쪽은 도구의 클라이언트가
// 되고(SafeConn), 클라이언트 쪽에서 도구가 보낸 프레임을 읽는다.
func wsPair(t *testing.T) (server, client *websocket.Conn) {
	t.Helper()
	got := make(chan *websocket.Conn, 1)
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		got <- c
	}))
	t.Cleanup(ts.Close)
	client = dialEcho(t, ts)
	t.Cleanup(func() { client.Close() })
	select {
	case server = <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("ws upgrade 가 오지 않았다")
	}
	return server, client
}

// M8 `GO-7`: readPTY 가 패닉해도 도구는 반죽음으로 남지 않는다.
//
// 종전에는 recover 가 로그만 남기고 돌아갔다 — PTY 와 프로세스가 남고, 클라이언트는
// OpExit 을 받지 못해 재연결을 되풀이하고(무한 재연결의 조건), tools.json 에 계속
// 기재됐다. 패닉 뒤에는 EOF 경로와 같은 순서 — kill() 그리고 onExit — 가 돈다.
func TestTool_ReadPTYPanic_KillsAndSignalsExit(t *testing.T) {
	exited := make(chan string, 1)
	p, err := StartTool("t-panic", "panic", t.TempDir(), 80, 24, func(id string) { exited <- id }, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	t.Cleanup(p.kill)

	server, client := wsPair(t)
	if !p.AddClient(NewSafeConn(server)) {
		t.Fatal("AddClient 가 거절했다")
	}

	// 패닉 주입 — 릴레이의 onOutput 은 readPTY 고루틴 안에서 불린다.
	p.WireRelayOnce(func(prevExit func(string)) (func(string, []byte, int64), func(string)) {
		return func(string, []byte, int64) { panic("injected readPTY panic") }, prevExit
	})
	if err := p.Write([]byte("echo panic-probe\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case <-p.Wait():
	case <-time.After(5 * time.Second):
		t.Fatal("패닉 뒤 kill() 이 돌지 않았다 — done 이 닫히지 않았다")
	}
	select {
	case id := <-exited:
		if id != "t-panic" {
			t.Fatalf("onExit id=%q", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("패닉 뒤 onExit 이 불리지 않았다")
	}

	// 클라이언트는 OpExit 을 받는다 (앞선 OpOutput 프레임은 건너뛴다).
	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, msg, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("OpExit 이 오지 않았다: %v", err)
		}
		if len(msg) > 0 && msg[0] == OpExit {
			break
		}
	}
	if pid := p.CmdProcessPID(); pid > 0 && platform.Current().Process.Alive(pid) {
		t.Fatalf("패닉 뒤에도 프로세스 %d 가 살아 있다", pid)
	}
}
