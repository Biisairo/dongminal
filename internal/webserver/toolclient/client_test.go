package toolclient

import (
	"dongminal/internal/daemon/ipc"

	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ── ToolClient tests ────────────────────────────────────────────────────

func TestToolClientRequestResponse(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"echo": req.Method}}
	})
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("DialToolClient: %v", err)
	}
	defer pc.Close()

	resp, err := pc.call("test_method", map[string]interface{}{"key": "val"})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if resp["echo"] != "test_method" {
		t.Fatalf("echo=%q", resp["echo"])
	}
}

func TestToolClientCreate(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
			"id": "99", "name": "S99", "pid": 12345, "cols": 80, "rows": 24,
		}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()

	tool, err := pc.Create("/tmp", 80, 24)
	if err != nil || tool.ID != "99" {
		t.Fatalf("Create: err=%v id=%q", err, tool.ID)
	}
}

func TestToolClientList(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
			"tools": []interface{}{
				map[string]interface{}{"id": "1", "name": "S1"},
				map[string]interface{}{"id": "2", "name": "S2"},
			},
		}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	if len(pc.List()) != 2 {
		t.Fatal("List len != 2")
	}
}

func TestToolClientWriteBase64(t *testing.T) {
	var received string
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		var p struct {
			Data string `json:"data"`
		}
		json.Unmarshal(req.Params, &p)
		received = p.Data
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()

	pc.Write("1", []byte("hello world"))
	dec, _ := base64.StdEncoding.DecodeString(received)
	if string(dec) != "hello world" {
		t.Fatalf("data=%q", string(dec))
	}
}

func TestToolClientDelete(t *testing.T) {
	var killed string
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		var p struct {
			ID string `json:"id"`
		}
		json.Unmarshal(req.Params, &p)
		killed = p.ID
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	pc.Delete("42")
	if killed != "42" {
		t.Fatalf("killed=%q", killed)
	}
}

func TestToolClientResize(t *testing.T) {
	var resized struct {
		id         string
		cols, rows uint16
	}
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		var p struct {
			ID   string `json:"id"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		json.Unmarshal(req.Params, &p)
		resized.id, resized.cols, resized.rows = p.ID, p.Cols, p.Rows
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	pc.Resize("3", 200, 60)
	if resized.id != "3" || resized.cols != 200 || resized.rows != 60 {
		t.Fatalf("resize: %+v", resized)
	}
}

func TestToolClientSnapshot(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
			"data":           base64.StdEncoding.EncodeToString([]byte("buffered")),
			"totalBytesIn":   float64(100),
			"totalBytesDrop": float64(5),
			"retained":       float64(95),
		}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	snap, _ := pc.SnapshotTool("1")
	if string(snap.Data) != "buffered" || snap.TotalBytesIn != 100 {
		t.Fatalf("snap=%+v", snap)
	}
}

func TestToolClientPushOutput(t *testing.T) {
	outputCh := make(chan []byte, 1)
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
			"version": 1, "tool_ids": []interface{}{"1"},
		}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()

	pc.Subscribe("1", outputCh) // test only checks registration

	// Simulate push via the fake paned - write directly to the conn
	// (the fake paned doesn't push output, so we need another approach)
	// For now, test that subscription works by verifying the channel is registered
	pc.subMu.RLock()
	_, ok := pc.subbers["1"][outputCh]
	pc.subMu.RUnlock()
	if !ok {
		t.Fatal("outputCh not subscribed")
	}
}

func TestToolClientReconnect(t *testing.T) {
	d := t.TempDir()
	sockPath := d + "/s"
	dataDir := d + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm1 := toolhub.NewToolManager(dataDir, nil)
	ps1 := ipc.NewPanedServer(pm1, sockPath, "")
	ps1.Listen()
	go func() { ps1.Accept() }()

	pc1, _ := DialToolClient(sockPath)
	p, _ := pc1.Create("/tmp", 80, 24)
	toolID := p.ID
	pc1.Close()
	ps1.Close()
	time.Sleep(200 * time.Millisecond)

	pm2 := toolhub.NewToolManager(dataDir, nil)
	pm2.LoadAll(map[string]struct{}{toolID: {}})
	if !pm2.IsLive(toolID) {
		t.Fatalf("tool %s should be live after LoadAll", toolID)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

func startFakePaned(t *testing.T, handler func(toolipc.PanedRequest) interface{}) string {
	t.Helper()
	sockPath := t.TempDir() + "/s"
	ln, _ := net.Listen("unix", sockPath)

	go func() {
		conn, _ := ln.Accept()
		enc := json.NewEncoder(conn)
		dec := json.NewDecoder(conn)
		for {
			var req toolipc.PanedRequest
			if err := dec.Decode(&req); err != nil {
				return
			}
			resp := handler(req)
			enc.Encode(resp)
		}
	}()
	time.Sleep(10 * time.Millisecond)
	return sockPath
}

// TestToolClientAutoReconnect verifies the supervisor redials dongminald after
// the daemon dies and a fresh one binds the same socket (FR-13).
func TestToolClientAutoReconnect(t *testing.T) {
	d := t.TempDir()
	sockPath := d + "/s"
	dataDir := d + "/d"
	os.MkdirAll(dataDir, 0o755)

	acceptLoop := func(ps *ipc.PanedServer) {
		for {
			if err := ps.Accept(); err != nil {
				return
			}
		}
	}

	pm1 := toolhub.NewToolManager(dataDir, nil)
	ps1 := ipc.NewPanedServer(pm1, sockPath, "")
	if err := ps1.Listen(); err != nil {
		t.Fatalf("Listen1: %v", err)
	}
	go acceptLoop(ps1)

	pc, err := DialPaneClientWithReconnect(sockPath, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	if _, err := pc.Create("/tmp", 80, 24); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Kill the daemon → client connection drops, supervisor starts redialing.
	ps1.Close()
	time.Sleep(150 * time.Millisecond)

	// Bring up a replacement daemon on the same socket.
	pm2 := toolhub.NewToolManager(dataDir, nil)
	pm2.LoadAll(allToolIDs(dataDir))
	ps2 := ipc.NewPanedServer(pm2, sockPath, "")
	if err := ps2.Listen(); err != nil {
		t.Fatalf("Listen2: %v", err)
	}
	defer ps2.Close()
	go acceptLoop(ps2)

	// The client should reconnect (backoff ≤ a few seconds) and serve RPCs.
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if l := pc.List(); l != nil {
			return // reconnected and hello/list succeeded
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("client did not reconnect to replacement daemon")
}

// silentListener accepts connections but never replies, to exercise the RPC
// timeout (FR-14).
func TestToolClientCallTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("5s timeout test")
	}
	d := t.TempDir()
	sockPath := d + "/s"
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			// Drain without ever responding.
			go func() { _, _ = io.Copy(io.Discard, conn) }()
		}
	}()

	start := time.Now()
	_, err = DialPaneClientWithReconnect(sockPath, nil)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected hello to time out, got nil error")
	}
	if elapsed < panedCallTimeout || elapsed > panedCallTimeout+3*time.Second {
		t.Fatalf("timeout elapsed=%v, expected ~%v", elapsed, panedCallTimeout)
	}
}

// TestToolClientConnected verifies Connected() reflects live/lost/closed state,
// so handleWS can avoid false toolhub.OpExit during a daemon reconnect window (edge D).
func TestToolClientConnected(t *testing.T) {
	d := t.TempDir()
	sockPath := d + "/s"
	os.MkdirAll(d+"/d", 0o755)
	pm := toolhub.NewToolManager(d+"/d", nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	go func() { ps.Accept() }()

	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if !pc.Connected() {
		t.Fatal("Connected() should be true right after dial")
	}

	// Kill the daemon → connection drops; Connected() must report false during
	// the reconnect window (no replacement daemon is started here).
	ps.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !pc.Connected() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if pc.Connected() {
		t.Fatal("Connected() should be false after daemon died")
	}

	pc.Close()
	if pc.Connected() {
		t.Fatal("Connected() should be false after Close")
	}
}

// allToolIDs는 tools.json 의 전 항목을 참조 집합으로 취급한다. LoadAll 의
// 참조 필터(FR-EM-14)를 우회해 "재시작 후 복원" 자체를 검증하는 용도.
func allToolIDs(dataDir string) map[string]struct{} {
	out := map[string]struct{}{}
	b, err := os.ReadFile(filepath.Join(dataDir, "tools.json"))
	if err != nil {
		return out
	}
	var states []toolhub.ToolState
	if json.Unmarshal(b, &states) != nil {
		return out
	}
	for _, s := range states {
		out[s.ID] = struct{}{}
	}
	return out
}

// ── 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N) ──────────────────────────

// TestToolClientForegroundNameOverIPC는 전경 이름이 데몬에서 조회되어 목록
// 응답에 실려 오는 것을 고정한다 (FR-TAN-7, V-TAN-9).
//
// R1 이 HIGH 인 이유가 이것이다 — PTY 를 가진 것은 데몬이고, 웹 서버는 PTMX 가
// 없어 스스로 tcgetpgrp 을 부를 수 없다. 여기서 두 모드가 같은 값을 내는지를
// 직접 비교한다: pm.List()가 direct 모드가 보는 것이고, pc.List()가 데몬 모드가
// 소켓 너머로 받는 것이다.
func TestToolClientForegroundNameOverIPC(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	d := t.TempDir()
	sockPath := d + "/s"
	dataDir := d + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm := toolhub.NewToolManager(dataDir, nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() {
		for {
			if err := ps.Accept(); err != nil {
				return
			}
		}
	}()

	fgCh := make(chan string, 16)
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	// SetOnForeground 로 건다 — dial 직후부터 readLoop 가 이 필드를 읽으므로
	// 맨 대입은 잠금을 지나지 않는다 (client.go 의 setter 주석).
	pc.SetOnForeground(func(_, name string) { fgCh <- name })

	tool, err := pc.Create(dataDir, 80, 24)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer pm.Delete(tool.ID)
	if err := pc.Write(tool.ID, []byte("sleep 30\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	fgOf := func(list []map[string]interface{}) string {
		for _, m := range list {
			if id, _ := m["id"].(string); id == tool.ID {
				n, _ := m["fgName"].(string)
				return n
			}
		}
		return "<도구 없음>"
	}

	deadline := time.Now().Add(10 * time.Second)
	var daemonName string
	for time.Now().Before(deadline) {
		daemonName = fgOf(pc.List())
		if daemonName == "sleep" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if daemonName != "sleep" {
		t.Fatalf("데몬 모드 fgName=%q — sleep 이어야 한다", daemonName)
	}
	if direct := fgOf(pm.List()); direct != daemonName {
		t.Fatalf("direct 모드 fgName=%q, 데몬 모드=%q — 같아야 한다 (C-1)", direct, daemonName)
	}

	// 값이 바뀐 순간에는 push 로도 나간다 (FR-TAN-9).
	select {
	case name := <-fgCh:
		if name != "sleep" {
			t.Fatalf("fg push=%q want sleep", name)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("전경 이름이 바뀌었는데 fg push 가 오지 않았다")
	}
}

// TestToolClientForegroundPushDispatch는 fg push 이벤트가 콜백으로 전달되는
// 것을 고정한다. 콜백이 없으면 조용히 버려진다 — 같은 값이 목록 응답에도
// 실리므로 잃는 것이 없다.
func TestToolClientForegroundPushDispatch(t *testing.T) {
	sockPath := t.TempDir() + "/s"
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		enc := json.NewEncoder(conn)
		dec := json.NewDecoder(conn)
		for {
			var req toolipc.PanedRequest
			if err := dec.Decode(&req); err != nil {
				return
			}
			enc.Encode(toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"version": 1}})
			enc.Encode(map[string]interface{}{"event": "fg", "tool": "t1", "name": "claude"})
		}
	}()

	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	got := make(chan [2]string, 4)
	// 맨 대입이 아니라 setter 다 — 이 fake 는 hello 응답 직후 곧바로 `fg` 를
	// 밀므로, readLoop 가 배선보다 먼저 이 필드를 읽는다.
	pc.SetOnForeground(func(id, name string) { got <- [2]string{id, name} })
	pc.call("list", struct{}{})

	select {
	case ev := <-got:
		if ev[0] != "t1" || ev[1] != "claude" {
			t.Fatalf("fg push=%v want [t1 claude]", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fg push 가 콜백에 닿지 않았다")
	}
}
