package toolclient

import (
	"dongminal/internal/daemon/ipc"

	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/platform"

	"dongminal/internal/shared/testpath"
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

	tool, err := pc.Create("/tmp", 80, 24, toolhub.Placement{})
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
	outputCh := make(chan OutChunk, 1)
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
	t.Cleanup(pm1.StopSaving)
	ps1 := ipc.NewPanedServer(pm1, sockPath, "")
	ps1.Listen()
	go func() { ps1.Accept() }()

	pc1, _ := DialToolClient(sockPath)
	p, _ := pc1.Create("/tmp", 80, 24, toolhub.Placement{})
	toolID := p.ID
	pc1.Close()
	ps1.Close()
	// 저장은 요청 경로를 막지 않으려고 고루틴으로 떨어진다. 기다리지 않으면
	// tools.json 이 아직 쓰이지 않은 채로 pm2 가 읽어 간헐 실패한다 — 느린
	// 러너에서 실제로 났다. sleep 으로 눈감으면 그 실패는 되풀이된다.
	pm1.StopSaving()

	pm2 := toolhub.NewToolManager(dataDir, nil)
	t.Cleanup(pm2.StopSaving)
	pm2.LoadAll(map[string]struct{}{toolID: {}})
	if !pm2.IsLive(toolID) {
		t.Fatalf("tool %s should be live after LoadAll", toolID)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

func startFakePaned(t *testing.T, handler func(toolipc.PanedRequest) interface{}) string {
	t.Helper()
	sockPath := t.TempDir() + "/s"
	ln, _ := platform.Current().IPC.Listen(sockPath)

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
	// 고정 대기가 없다 (M9_SRS FR-M9-14 ①). 소켓은 `Listen` 이 **돌아온 순간**
	// 이미 묶여 있고, 붙는 쪽은 커널의 대기열에 들어간다 — 받는 고루틴이
	// `Accept` 에 닿았는지는 기다릴 사실이 아니다.
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
	t.Cleanup(pm1.StopSaving)
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
	if _, err := pc.Create("/tmp", 80, 24, toolhub.Placement{}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Kill the daemon → client connection drops, supervisor starts redialing.
	ps1.Close()
	// **도구가 디스크에 남았는가** (M9_SRS FR-M9-14 ①).
	//
	// 종전의 고정 대기 150ms 가 재던 것이 이것이다 — 이름은 "재다이얼을 시작할
	// 시간" 이었지만 실제로 그 값이 지키던 사실은 저장이었다. 대체 데몬은
	// `tools.json` 으로 도구를 되살리고, 아래 `pc.List()` 가 비지 않는 근거가
	// 그것이다. 끊김 인지를 대신 기다리자 저장 전에 pm2 가 서서 **재접속은
	// 됐는데 목록이 영영 비었다** (실측 5/5 실패).
	for deadline := time.Now().Add(5 * time.Second); len(allToolIDs(dataDir)) == 0 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if len(allToolIDs(dataDir)) == 0 {
		t.Fatal("도구가 디스크에 남지 않아 대체 데몬이 되살릴 것이 없다")
	}

	// Bring up a replacement daemon on the same socket.
	pm2 := toolhub.NewToolManager(dataDir, nil)
	t.Cleanup(pm2.StopSaving)
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
	ln, err := platform.Current().IPC.Listen(sockPath)
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
	t.Cleanup(pm.StopSaving)
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
	// 전경 프로세스 그룹은 POSIX 에만 있다 (FR-XPT-5 — Windows 의
	// ForegroundPGID 는 (0,false) 고정). 건너뛴 사실이 출력에 남도록
	// 빌드 태그가 아니라 Skip 으로 적는다 (FR-WTP-32).
	if !testpath.ForegroundGroups() {
		t.Skip("전경 프로세스 그룹이 없는 OS 다 — 붙일 이름이라는 개념이 없다")
	}

	t.Setenv("SHELL", "/bin/sh")
	d := t.TempDir()
	sockPath := d + "/s"
	dataDir := d + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm := toolhub.NewToolManager(dataDir, nil)
	t.Cleanup(pm.StopSaving)
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

	tool, err := pc.Create(dataDir, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer pm.Delete(tool.ID)
	if err := pc.Write(tool.ID, []byte("sleep 30\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	fgOf := func(list []toolhub.ToolInfo) string {
		for _, m := range list {
			if m.ID == tool.ID {
				return m.FgName
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
	ln, err := platform.Current().IPC.Listen(sockPath)
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

// TOOL_LIST_UNKNOWN_SRS TC-TLU-2 (FR-TLU-2): 도구가 **0개인 것**과 목록을
// **모르는 것**은 다르다. 데몬의 ToolManager 는 도구가 없으면 nil 슬라이스를
// 주고 그것이 JSON 에서 `"tools": null` 이 되므로, nil 목록만으로는 둘을 가를 수
// 없다 (SRS §2.3). 가르는 근거는 RPC 가 성공했는가 하나다.
//
// 셋을 서브테스트로 묶지 않는다 — `startFakePaned` 가 `t.TempDir()` 로 소켓을
// 만드는데, 서브테스트 이름이 경로에 들어가면 unix 소켓의 104바이트 한도를 넘는다.
func TestToolClientListOKEmpty(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"tools": nil}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	tools, ok := pc.ListOK()
	if !ok {
		t.Errorf("ok=false — 응답이 왔으므로 알고 있는 것이다")
	}
	if len(tools) != 0 {
		t.Errorf("tools=%d want 0", len(tools))
	}
}

func TestToolClientListOKUnknown(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		// hello 는 답한다 — 오류 응답이 dial 을 막지 않게 (M8 D-A-16 뒤로는 오류가 오류다).
		if req.Method == "hello" {
			return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{}}
		}
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeInternal, Message: "boom"}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	if _, ok := pc.ListOK(); ok {
		t.Errorf("ok=true — RPC 가 실패했으므로 모르는 것이다")
	}
}

func TestToolClientListDelegatesToListOK(t *testing.T) {
	sockPath := startFakePaned(t, func(req toolipc.PanedRequest) interface{} {
		return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
			"tools": []interface{}{map[string]interface{}{"id": "1", "name": "S1"}},
		}}
	})
	pc, _ := DialToolClient(sockPath)
	defer pc.Close()
	tools, ok := pc.ListOK()
	if !ok || len(tools) != 1 {
		t.Fatalf("ListOK: ok=%v len=%d", ok, len(tools))
	}
	if len(pc.List()) != 1 {
		t.Errorf("List 와 ListOK 가 다른 것을 준다")
	}
}

// ── M8 `GO-5`: 콜백 배선과 readLoop 의 레이스 ──
//
// readLoop 는 dial 이 돌아온 순간 이미 돌고 있고, 데몬은 접속 직후부터 `output`·
// `exit` 를 밀 수 있다. 배선(main.go)이 그 뒤에 오므로 콜백 필드는 setter 로만
// 걸리고 readLoop 는 잠금 아래에서 읽는다 — 이 둘은 `go test -race` 가 판정한다.

// fakePushingPaned 는 hello 에 답한 직후부터 `output` 을 계속 밀고 마지막에
// `exit` 를 미는 가짜 데몬이다. 배선이 끝나기 전에 push 가 도착하는 창을 만든다.
func fakePushingPaned(t *testing.T, outputs int) string {
	t.Helper()
	sockPath := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		enc := json.NewEncoder(conn)
		dec := json.NewDecoder(conn)
		var req toolipc.PanedRequest
		if err := dec.Decode(&req); err != nil {
			return
		}
		enc.Encode(toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"version": 1}})
		data := base64.StdEncoding.EncodeToString([]byte("x"))
		for i := 0; i < outputs; i++ {
			enc.Encode(map[string]interface{}{"event": "output", "tool": "t1", "data": data, "end": i + 1})
		}
		enc.Encode(map[string]interface{}{"event": "exit", "tool": "t1", "code": 7})
		// 클라이언트가 닫을 때까지 연결을 연다 — 먼저 닫으면 재접속이 돈다.
		io.Copy(io.Discard, conn)
	}()
	return sockPath
}

// 배선이 push 와 겹친다: 콜백을 setter 로 걸면서 readLoop 가 같은 필드를 읽는다.
// -race 아래에서 깨끗해야 하고, 배선 뒤의 push 는 콜백에 닿아야 한다.
func TestToolClientSetCbRace(t *testing.T) {
	sockPath := fakePushingPaned(t, 2000)
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	got := make(chan struct{}, 1)
	exited := make(chan int, 1)
	pc.SetOnOutput(func(toolID string, _ toolhub.ToolKind, data []byte, _ int64) {
		select {
		case got <- struct{}{}:
		default:
		}
	})
	pc.SetOnExit(func(toolID string, info toolhub.ExitInfo) { exited <- info.Code })

	select {
	case code := <-exited:
		if code != 7 {
			t.Fatalf("exit code=%d want 7", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exit push 가 콜백에 닿지 않았다")
	}
	select {
	case <-got:
	default:
		t.Fatal("배선 뒤의 output push 가 콜백에 닿지 않았다")
	}
}

// 배선 전에 도착한 `exit` 는 버려지지 않는다 — SetOnExit 가 그것을 재생한다
// (종전의 FlushEarlyPushes 가 하던 일이 setter 안으로 들어왔다).
func TestToolClientEarlyExitReplay(t *testing.T) {
	sockPath := fakePushingPaned(t, 0)
	pc, err := DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	// exit 가 readLoop 에 읽힐 때까지 기다린다 — 버퍼에 들어간 것을 확인한다.
	deadline := time.Now().Add(5 * time.Second)
	for {
		pc.mu.Lock()
		n := len(pc.earlyPushes)
		pc.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("배선 전의 exit 가 버퍼에 들어가지 않았다")
		}
		time.Sleep(time.Millisecond)
	}

	exited := make(chan int, 1)
	pc.SetOnExit(func(toolID string, info toolhub.ExitInfo) { exited <- info.Code })
	select {
	case code := <-exited:
		if code != 7 {
			t.Fatalf("exit code=%d want 7", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SetOnExit 가 버퍼된 exit 를 재생하지 않았다")
	}
}

// ── M8 `GO-6`: 목록 캐시 ──
//
// Get·IsLive 가 호출마다 전체 list RPC 를 왕복하던 자리다. 요청 하나가 멤버·도구마다
// 그것을 물어 `GET /api/runs` 한 번이 수십 번 직렬 왕복이었다.

// fakeCountingPaned 는 list RPC 횟수를 세고, 요청이 오면 그 사이에 이벤트도 민다.
func fakeCountingPaned(t *testing.T, lists *atomic.Int64, events <-chan map[string]interface{}) string {
	t.Helper()
	sockPath := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		enc := json.NewEncoder(conn)
		dec := json.NewDecoder(conn)
		var mu sync.Mutex
		go func() {
			for ev := range events {
				mu.Lock()
				enc.Encode(ev)
				mu.Unlock()
			}
		}()
		for {
			var req toolipc.PanedRequest
			if err := dec.Decode(&req); err != nil {
				return
			}
			var resp interface{}
			switch req.Method {
			case "list":
				lists.Add(1)
				resp = toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
					"tools": []interface{}{map[string]interface{}{"id": "t1", "name": "S1", "pid": 7, "fgName": "vim"}},
				}}
			default:
				resp = toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{"version": 1}}
			}
			mu.Lock()
			enc.Encode(resp)
			mu.Unlock()
		}
	}()
	return sockPath
}

func TestToolClientListCache(t *testing.T) {
	var lists atomic.Int64
	events := make(chan map[string]interface{})
	defer close(events)
	pc, err := DialToolClient(fakeCountingPaned(t, &lists, events))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	for i := 0; i < 10; i++ {
		if pc.Get("t1") == nil || !pc.IsLive("t1") || pc.Get("nope") != nil {
			t.Fatal("조회 결과가 틀리다")
		}
	}
	if got := lists.Load(); got != 1 {
		t.Fatalf("Get/IsLive 30회에 list RPC %d회 (want 1 — TTL 안에서는 캐시)", got)
	}
	if tools := pc.List(); len(tools) != 1 || tools[0].FgName != "vim" || tools[0].PID != 7 {
		t.Fatalf("ToolInfo 디코드가 틀리다: %+v", tools)
	}
}

func TestToolClientListInval(t *testing.T) {
	var lists atomic.Int64
	events := make(chan map[string]interface{})
	defer close(events)
	pc, err := DialToolClient(fakeCountingPaned(t, &lists, events))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	pc.Get("t1")
	pc.Get("t1")
	if got := lists.Load(); got != 1 {
		t.Fatalf("list RPC %d회 (want 1)", got)
	}
	// exit push 가 캐시를 버린다 — 다음 조회는 다시 묻는다.
	events <- map[string]interface{}{"event": "exit", "tool": "t1", "code": 0}
	deadline := time.Now().Add(3 * time.Second)
	for {
		pc.Get("t1")
		if lists.Load() >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("exit push 뒤에도 캐시가 살아 있다")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// 변경 호출도 버린다.
	before := lists.Load()
	pc.Get("t1") // 캐시
	_ = pc.Delete("t1")
	pc.Get("t1")
	if lists.Load() != before+1 {
		t.Fatalf("Delete 뒤 캐시가 살아 있다: %d → %d", before, lists.Load())
	}
}

// 무효화가 진행 중인 list 응답보다 **뒤에** 오면 그 응답은 저장되지 않는다. 저장하면
// 방금 지운 도구가 TTL 동안 목록에 되살아난다 — e2e skill-contract 가 그렇게 깨졌다.
func TestToolClientListStaleGen(t *testing.T) {
	var lists atomic.Int64
	events := make(chan map[string]interface{})
	defer close(events)
	pc, err := DialToolClient(fakeCountingPaned(t, &lists, events))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	gen := pc.listGeneration()
	pc.invalidateList() // list 가 데몬에서 답해진 뒤, 응답이 도착하기 전의 무효화
	pc.storeList([]toolhub.ToolInfo{{ID: "stale"}}, gen)
	if _, ok := pc.cachedList(); ok {
		t.Fatal("낡은 세대의 응답이 캐시에 저장됐다")
	}
	pc.storeList([]toolhub.ToolInfo{{ID: "fresh"}}, pc.listGeneration())
	if tools, ok := pc.cachedList(); !ok || len(tools) != 1 || tools[0].ID != "fresh" {
		t.Fatalf("현재 세대의 응답은 저장돼야 한다: %v %v", tools, ok)
	}
}
