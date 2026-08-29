package ipc

import (
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// toolTempDir 는 ToolManager 의 데이터 디렉터리를 내주되, **비동기 기록이 멎은
// 뒤에** 정리되도록 한다.
//
// ToolManager.Create/Delete 는 `go m.SaveAll()` 로 tools.json 을 비동기 기록한다
// (toolhub/tool.go:928·1008). 그 쓰기가 t.TempDir() 정리보다 늦으면 정리가
// `directory not empty` 로 실패하고, **본문이 통과한 뒤에 테스트가 깨진다.**
// 전량 병렬 실행에서만 드러난다 (2026-08-28 관측).
//
// httpapi/background_test.go 에 같은 이유의 짝이 있다. 한쪽만 고치면 다른 쪽이
// 남는다 — 원인은 toolhub 의 fire-and-forget 저장이고 테스트가 그것을 기다릴
// 수단이 없다는 것이다.
func toolTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		prev, stable := "", 0
		for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
			cur := ""
			if ents, err := os.ReadDir(dir); err == nil {
				for _, e := range ents {
					if info, err := e.Info(); err == nil {
						cur += fmt.Sprintf("%s:%d:%d;", e.Name(), info.Size(), info.ModTime().UnixNano())
					}
				}
			}
			if cur == prev {
				if stable++; stable >= 2 {
					return
				}
			} else {
				stable = 0
			}
			prev = cur
			time.Sleep(20 * time.Millisecond)
		}
	})
	return dir
}

// ── Protocol tests ──────────────────────────────────────────────────────

func TestPanedJSONLinesFraming(t *testing.T) {
	req := toolipc.PanedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":123}`)}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	b = append(b, '\n')
	var decoded toolipc.PanedRequest
	if err := json.Unmarshal(bytes.TrimSuffix(b, []byte{'\n'}), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.ID != 1 || decoded.Method != "hello" {
		t.Fatalf("decoded=%+v", decoded)
	}
}

func TestPanedBase64RoundTrip(t *testing.T) {
	for _, input := range [][]byte{
		{}, []byte("hello"), []byte("\x1b[31mred\x1b[0m"), []byte("\x00\x01\xff"),
		bytes.Repeat([]byte("x"), 4096),
	} {
		enc := base64.StdEncoding.EncodeToString(input)
		dec, _ := base64.StdEncoding.DecodeString(enc)
		if !bytes.Equal(dec, input) {
			t.Fatalf("round-trip mismatch")
		}
	}
}

// ── Method dispatch tests ──────────────────────────────────────────────

// newTestConn builds a panedConn over an in-memory pipe via the real
// newPanedConn path (queue + writeLoop). The peer end is drained so writes
// never block.
func newTestConn(pm *toolhub.ToolManager) *panedConn {
	c1, c2 := net.Pipe()
	pc := newPanedConn(c1, pm)
	go func() { _, _ = io.Copy(io.Discard, c2) }()
	return pc
}

func TestPanedMethodDispatch(t *testing.T) {
	pc := newTestConn(toolhub.NewToolManager(toolTempDir(t), nil))
	tests := []struct {
		name   string
		method string
		params string
	}{
		{"hello", "hello", `{"server_pid":1}`},
		{"create", "create", `{"cwd":"/tmp","cols":80,"rows":24}`},
		{"restore", "restore", `{"id":"9","name":"R","cwd":"/tmp","cols":80,"rows":24}`},
		{"kill", "kill", `{"id":"1"}`},
		{"write", "write", `{"id":"1","data":"` + base64.StdEncoding.EncodeToString([]byte("hi")) + `"}`},
		{"resize", "resize", `{"id":"1","cols":100,"rows":30}`},
		{"list", "list", `{}`},
		{"snapshot", "snapshot", `{"id":"1"}`},
		{"cwd", "cwd", `{"id":"1"}`},
		{"busy", "busy", `{"id":"1"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: tt.method, Params: json.RawMessage(tt.params)})
		})
	}
}

func TestPanedUnknownMethod(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{pm: toolhub.NewToolManager(toolTempDir(t), nil), encoder: json.NewEncoder(&buf)}
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "bogus", Params: json.RawMessage(`{}`)})

	raw := bytes.TrimRight(buf.Bytes(), "\n")
	t.Logf("raw output: %s", raw)
	var resp toolipc.PanedError
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Error.Code != -32601 {
		t.Fatalf("code=%d want -32601", resp.Error.Code)
	}
}

func TestPanedHelloReturnsToolIDs(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	pm.Create("/tmp", 80, 24)
	pm.Create("/tmp", 80, 24)

	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":1}`)})

	var resp toolipc.PanedResponse
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &resp)
	resultMap := resp.Result.(map[string]interface{})
	toolIDs := resultMap["tool_ids"].([]interface{})
	if len(toolIDs) != 2 {
		t.Fatalf("tool_ids len=%d want 2", len(toolIDs))
	}
}

func TestPanedKillRemovesTool(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	// toolId 는 uuid 이므로 생성 결과에서 받아야 한다 (FR-UNI-7). 이전에는 첫 도구가
	// 항상 "1" 이라는 카운터 전제에 의존했다.
	tl, err := pm.Create("/tmp", 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	pc := newTestConn(pm)

	if !pm.IsLive(tl.ID) {
		t.Fatal("tool should be live before kill")
	}
	params, _ := json.Marshal(map[string]string{"id": tl.ID})
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "kill", Params: params})
	time.Sleep(200 * time.Millisecond) // allow async cleanup
	if pm.IsLive(tl.ID) {
		t.Fatal("tool should be dead after kill")
	}
}

// ── Push event tests ────────────────────────────────────────────────────

func TestPanedPushOutputBase64(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	raw := []byte("hello\x1b[31mworld\x1b[0m\n")
	pc.pushOutputData("1", raw)

	var ev struct {
		Event string `json:"event"`
		Tool  string `json:"tool"`
		Data  string `json:"data"`
	}
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &ev)
	if ev.Event != "output" || ev.Tool != "1" {
		t.Fatalf("ev=%+v", ev)
	}
	dec, _ := base64.StdEncoding.DecodeString(ev.Data)
	if !bytes.Equal(dec, raw) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestPanedPushExit(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	pc.pushExit("1", 0)

	var ev struct {
		Event string `json:"event"`
		Tool  string `json:"tool"`
		Code  int    `json:"code"`
	}
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &ev)
	if ev.Event != "exit" || ev.Tool != "1" {
		t.Fatalf("ev=%+v", ev)
	}
}

func TestPanedPushOutputStopped(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	pc.stopped.Store(true)
	pc.pushOutputData("1", []byte("x"))
	if buf.Len() > 0 {
		t.Fatal("pushOutputData should no-op when stopped")
	}
}

// ── Integration tests ───────────────────────────────────────────────────

func shortPath(t *testing.T, name string) string { return t.TempDir() + "/" + name }

func TestPanedServerListenAccept(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	pm.Create("/tmp", 80, 24)

	sockPath := shortPath(t, "t.sock")
	pidPath := shortPath(t, "t.pid")
	ps := NewPanedServer(pm, sockPath, pidPath)
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	if _, err := os.Stat(sockPath); os.IsNotExist(err) {
		t.Fatal("socket not created")
	}

	// Accept in a loop so multiple connections work
	go func() {
		for {
			if err := ps.Accept(); err != nil {
				return
			}
		}
	}()

	conn, err := platform.Current().IPC.Dial(sockPath, time.Second)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	enc.Encode(toolipc.PanedRequest{ID: 1, Method: "hello", Params: json.RawMessage(`{"server_pid":1}`)})
	var resp toolipc.PanedResponse
	if err := dec.Decode(&resp); err != nil {
		t.Fatalf("hello response: %v", err)
	}
	if resp.ID != 1 {
		t.Fatalf("id=%d want 1", resp.ID)
	}
	conn.Close()
}

func TestPanedServerCloseCleanup(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	sockPath := shortPath(t, "c.sock")
	pidPath := shortPath(t, "c.pid")

	ps := NewPanedServer(pm, sockPath, pidPath)
	ps.Listen()
	ps.Close()

	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Fatal("socket not removed")
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatal("pidfile not removed")
	}
}

func TestPanedCreateWriteSnapshotFlow(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}

	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "create", Params: json.RawMessage(`{"cwd":"/tmp","cols":80,"rows":24}`)})
	buf.Reset()

	data := base64.StdEncoding.EncodeToString([]byte("echo test\n"))
	pc.dispatch(&toolipc.PanedRequest{ID: 2, Method: "write", Params: json.RawMessage(fmt.Sprintf(`{"id":"1","data":"%s"}`, data))})

	buf.Reset()
	pc.dispatch(&toolipc.PanedRequest{ID: 3, Method: "snapshot", Params: json.RawMessage(`{"id":"1"}`)})

	var resp toolipc.PanedResponse
	json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &resp)
	if _, ok := resp.Result.(map[string]interface{})["data"]; !ok {
		t.Fatal("snapshot missing data")
	}
}

func TestPanedRestore(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}

	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "restore", Params: json.RawMessage(`{"id":"5","name":"R","cwd":"/home","cols":100,"rows":30}`)})

	if !pm.IsLive("5") {
		t.Fatal("restored tool should be live")
	}
}

// TestPanedListenRejectsLiveSocket verifies Listen refuses to clobber a socket
// already served by a live daemon (concurrent cold-start guard).
func TestPanedListenRejectsLiveSocket(t *testing.T) {
	sock := t.TempDir() + "/s"
	ps1 := NewPanedServer(toolhub.NewToolManager(toolTempDir(t), nil), sock, "")
	if err := ps1.Listen(); err != nil {
		t.Fatalf("Listen1: %v", err)
	}
	defer ps1.Close()
	go func() { ps1.Accept() }()

	ps2 := NewPanedServer(toolhub.NewToolManager(toolTempDir(t), nil), sock, "")
	if err := ps2.Listen(); err == nil {
		ps2.Close()
		t.Fatal("Listen2 should reject a live socket, got nil error")
	}
}

// TestPanedListenRemovesStaleSocket verifies a stale (dead) socket is replaced.
func TestPanedListenRemovesStaleSocket(t *testing.T) {
	sock := t.TempDir() + "/s"
	ps1 := NewPanedServer(toolhub.NewToolManager(toolTempDir(t), nil), sock, "")
	if err := ps1.Listen(); err != nil {
		t.Fatalf("Listen1: %v", err)
	}
	ps1.Close() // socket file may linger but no listener

	ps2 := NewPanedServer(toolhub.NewToolManager(toolTempDir(t), nil), sock, "")
	if err := ps2.Listen(); err != nil {
		t.Fatalf("Listen2 should reclaim stale socket: %v", err)
	}
	ps2.Close()
}

// ── 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N) ──────────────────────────

// TestPanedListCarriesForegroundName은 list 응답이 전경 이름을 싣고 나가는 것을
// 고정한다 (FR-TAN-7). 이름만을 위한 새 method 를 만들지 않는다 — 기존 도구
// 목록에 편승한다 (FR-TAN-8, NFR-CNV-2).
func TestPanedListCarriesForegroundName(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	tl, err := pm.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete(tl.ID)
	if err := pm.Write(tl.ID, []byte("sleep 30\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	fgOf := func() string {
		var buf bytes.Buffer
		pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
		pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: "list", Params: json.RawMessage(`{}`)})
		var resp toolipc.PanedResponse
		json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &resp)
		result, _ := resp.Result.(map[string]interface{})
		tools, _ := result["tools"].([]interface{})
		for _, item := range tools {
			m, _ := item.(map[string]interface{})
			if id, _ := m["id"].(string); id == tl.ID {
				name, _ := m["fgName"].(string)
				return name
			}
		}
		return "<도구 없음>"
	}

	deadline := time.Now().Add(10 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		if got = fgOf(); got == "sleep" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("list 의 fgName=%q — sleep 이어야 한다", got)
}

// TestPanedPushForeground은 전경 이름 push 의 와이어 모양을 고정한다.
func TestPanedPushForeground(t *testing.T) {
	var buf bytes.Buffer
	pc := &panedConn{encoder: json.NewEncoder(&buf)}
	pc.pushForeground("t1", "claude")

	var ev map[string]interface{}
	if err := json.Unmarshal(bytes.TrimRight(buf.Bytes(), "\n"), &ev); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if ev["event"] != "fg" || ev["tool"] != "t1" || ev["name"] != "claude" {
		t.Fatalf("push=%v", ev)
	}
}
