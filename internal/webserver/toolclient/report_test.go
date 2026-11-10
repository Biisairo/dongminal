package toolclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-20·23(종단) — 보고 소켓에 온 보고가 서버 연결이 붙은
// 채로도 받아지고, 그 보고가 report push 로 서버 콜백에 닿는다 (§3.2a).
func TestReportPush(t *testing.T) {
	ps, sock := recordsDaemon(t)
	dir, err := os.MkdirTemp("", "rtc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, agentrec.SocketFile)
	if err := ps.ListenReports(path); err != nil {
		t.Fatal(err)
	}
	go ps.ServeReports()

	c, err := DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	got := make(chan toolipc.ReportEvent, 1)
	c.SetOnReport(func(ev toolipc.ReportEvent) { got <- ev })

	conn, err := platform.Current().IPC.Dial(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	body := json.RawMessage(`{"toolId":"t1","reason":"done"}`)
	if err := json.NewEncoder(conn).Encode(agentrec.Request{Method: agentrec.MethodNotify, Body: body}); err != nil {
		t.Fatal(err)
	}
	var r agentrec.Reply
	if err := json.NewDecoder(conn).Decode(&r); err != nil || !r.OK {
		t.Fatalf("reply=%+v err=%v", r, err)
	}
	select {
	case ev := <-got:
		if ev.Method != agentrec.MethodNotify || string(ev.Body) != string(body) {
			t.Fatalf("ev=%+v", ev)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("report push 가 콜백에 닿지 않았다")
	}
}
