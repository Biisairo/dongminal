//go:build !windows

package ipc

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
)

// DAEMON_SESSION_KEEP_SRS FR-DSK-14·24: 두 소켓의 리스너를 fd 로 넘기고, 새 쪽이 소켓 파일을
// 다시 만들지 않고 그대로 받는다.
func TestHandover_ListenersSurvive(t *testing.T) {
	dir, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := platform.Current().IPC.Endpoint(dir)
	report := filepath.Join(dir, agentrec.SocketFile)

	old := NewPanedServer(recordsPM(t), sock, filepath.Join(dir, "paned.pid"))
	if err := old.Listen(); err != nil {
		t.Fatal(err)
	}
	if err := old.ListenReports(report); err != nil {
		t.Fatal(err)
	}
	pf, rf, err := old.ListenerFiles()
	if err != nil {
		t.Fatal(err)
	}
	pl, err := net.FileListener(pf)
	if err != nil {
		t.Fatal(err)
	}
	rl, err := net.FileListener(rf)
	if err != nil {
		t.Fatal(err)
	}

	pidPath := filepath.Join(dir, "paned.pid")
	os.Remove(pidPath)
	next := NewPanedServer(recordsPM(t), sock, pidPath)
	next.ListenInherited(pl, rl, report)
	if _, err := os.Stat(pidPath); err != nil {
		t.Fatalf("물려받은 뒤 pidfile 이 없다: %v", err)
	}

	// 새 쪽이 받는다 — 옛 쪽은 exec 로 사라졌다고 본다.
	go func() { _ = next.Accept() }()
	served := make(chan struct{})
	go func() { next.ServeReports(); close(served) }()
	t.Cleanup(func() { next.Close(); <-served })

	c, err := platform.Current().IPC.Dial(sock, time.Second)
	if err != nil {
		t.Fatalf("paned.sock: %v", err)
	}
	c.Close()
	if r := ask(t, report, agentrec.Request{Method: "daemon.hello"}, 2*time.Second); !r.OK {
		t.Fatalf("보고 소켓 hello = %+v", r)
	}
}

// FR-DSK-14·23: 데몬 전체 기록(계정 한도)을 담고 되넣는다.
func TestHandover_GlobalRecordsRoundTrip(t *testing.T) {
	a := NewPanedServer(recordsPM(t), "", "")
	a.records.set("limits", json.RawMessage(`{"claude":1}`))
	b := NewPanedServer(recordsPM(t), "", "")
	b.ImportGlobal(a.ExportGlobal())
	if got := string(b.records.snapshot()["limits"]); got != `{"claude":1}` {
		t.Fatalf("limits = %q", got)
	}
}
