package httpapi

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/daemon/ipc"

	"dongminal/internal/webserver/toolclient"

	"dongminal/internal/shared/toolhub"

	"encoding/base64"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// TestDaemonFullFlow verifies the complete daemon lifecycle:
// create → write input → read output → attention detection → activity → exit cleanup.
func TestDaemonFullFlow(t *testing.T) {
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	// Start dongminald
	pm := toolhub.NewToolManager(dataDir, nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	go func() { ps.Accept() }()

	// Connect dongminal
	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("toolclient.DialToolClient: %v", err)
	}
	defer pc.Close()

	// Create attention tracker (simulating dongminal's setup)
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 500) // 500ms idle threshold for fast test

	// Wire exit → activity cleanup
	pc.OnExit = func(toolID string, code int) {
		tracker.SetActivity(toolID, "ended", "", "")
	}
	pc.FlushEarlyPushes()

	// Record SSE broadcasts
	var sseMu sync.Mutex
	var sseEvents []string
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
				Args   struct {
					ToolID string `json:"toolId"`
					State  string `json:"state"`
					Reason string `json:"reason"`
				} `json:"args"`
			}
			if err := json.Unmarshal(msg, &ev); err == nil {
				sseMu.Lock()
				sseEvents = append(sseEvents, ev.Action)
				sseMu.Unlock()
			}
		}
	}()
	defer cmdHub.Remove(sub)

	// Create a tool
	tool, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	toolID := tool.ID

	// Give the shell time to start and produce output (prompt)
	time.Sleep(200 * time.Millisecond)

	// Subscribe to output
	outputCh := make(chan []byte, 32)
	_, unsub := pc.Subscribe(toolID, outputCh)
	defer unsub()

	// Feed output to attention tracker
	go func() {
		for data := range outputCh {
			tracker.FeedOutput(toolID, data)
		}
	}()

	// Write input to trigger output
	if err := pc.Write(toolID, []byte("echo hello\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Wait for output
	select {
	case <-outputCh:
		// got some output
	case <-time.After(2 * time.Second):
		t.Fatal("no output received from tool")
	}

	// Set activity
	tracker.SetActivity(toolID, "working", "claude", "testing")

	// Snapshot
	snap, err := pc.SnapshotTool(toolID)
	if err != nil {
		t.Fatalf("SnapshotTool: %v", err)
	}
	if snap.Data == nil {
		t.Fatal("snapshot data is nil")
	}

	// Kill tool → should trigger exit → activity cleanup
	pc.Delete(toolID)
	time.Sleep(300 * time.Millisecond)

	// Verify activity was cleared
	if a := tracker.Activity(toolID); a != nil {
		t.Fatal("activity should be nil after exit")
	}

	// Verify SSE events include activity "ended" or similar
	sseMu.Lock()
	found := false
	for _, ev := range sseEvents {
		if ev == "tool_activity" {
			found = true
			break
		}
	}
	sseMu.Unlock()
	if !found {
		t.Log("SSE events:", sseEvents)
		t.Fatal("expected tool_activity SSE event")
	}
}

// TestDaemonAttentionDetection verifies L1 OSC attention detection
// in daemon mode via hub.AttnTracker.
func TestDaemonAttentionDetection(t *testing.T) {
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 10000)

	var sseMu sync.Mutex
	var attentionEvents []string
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			sseMu.Lock()
			attentionEvents = append(attentionEvents, ev.Action)
			sseMu.Unlock()
		}
	}()
	defer cmdHub.Remove(sub)

	// Feed output with OSC 9 notification
	oscNotify := []byte("\x1b]9;done\x07")
	tracker.FeedOutput("test-tool", oscNotify)

	time.Sleep(50 * time.Millisecond)

	sseMu.Lock()
	hasAttention := false
	for _, ev := range attentionEvents {
		if ev == "tool_attention" {
			hasAttention = true
		}
	}
	sseMu.Unlock()

	if !hasAttention {
		t.Fatal("expected tool_attention SSE event for OSC 9")
	}

	// Clear attention
	tracker.Attend("test-tool")
	time.Sleep(50 * time.Millisecond)
	sseMu.Lock()
	hasClear := false
	for _, ev := range attentionEvents {
		if ev == "tool_attention_clear" {
			hasClear = true
		}
	}
	sseMu.Unlock()
	if !hasClear {
		t.Fatal("expected tool_attention_clear SSE event")
	}
}

// TestDaemonReconnectPreservesTools verifies that tools survive
// a dongminal reconnection (dongminald stays alive).
func TestDaemonReconnectPreservesTools(t *testing.T) {
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	// Start dongminald with a tool created directly in toolhub.ToolManager
	pm := toolhub.NewToolManager(dataDir, nil)
	p, err := pm.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	toolID := p.ID

	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	// First dongminal connection
	go func() { ps.Accept() }()
	pc1, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("Dial1: %v", err)
	}

	// Verify tool exists
	tools1 := pc1.List()
	found := false
	for _, m := range tools1 {
		if m["id"].(string) == toolID {
			found = true
		}
	}
	if !found {
		t.Fatal("tool not found in list after first connection")
	}

	// Simulate dongminal restart: close client, accept new connection
	pc1.Close()
	time.Sleep(100 * time.Millisecond)

	// Second dongminal connects
	go func() { ps.Accept() }()
	pc2, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("Dial2: %v", err)
	}
	defer pc2.Close()

	// Verify tool still exists
	tools2 := pc2.List()
	found = false
	for _, m := range tools2 {
		if m["id"].(string) == toolID {
			found = true
		}
	}
	if !found {
		t.Fatal("tool not found after reconnection")
	}

	// Output should still flow
	_ = pm.Write(toolID, []byte("echo reconnect_test\n"))
	time.Sleep(200 * time.Millisecond)

	snap, _ := pm.SnapshotTool(toolID)
	if len(snap.Data) == 0 {
		t.Fatal("snapshot empty after write — output not flowing")
	}
}

// TestDaemonBase64RoundTrip verifies base64 encoding/decoding
// for terminal escape sequences through the relay chain.
func TestDaemonBase64RoundTrip(t *testing.T) {
	inputs := [][]byte{
		[]byte("\x1b[31mred\x1b[0m"),
		[]byte("\x1b]9;done\x07"),
		[]byte("\x1b[?1;2c"),
		[]byte("\x1b[60;3R"),
		[]byte("\x00\x01\xff"),
		bytesRepeat(4096, 'x'),
	}

	for _, input := range inputs {
		encoded := base64.StdEncoding.EncodeToString(input)
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatalf("decode %q: %v", input, err)
		}
		if len(decoded) != len(input) {
			t.Fatalf("length mismatch: %d vs %d", len(decoded), len(input))
		}
		for i := range input {
			if decoded[i] != input[i] {
				t.Fatalf("byte mismatch at %d: %d vs %d for input %q", i, decoded[i], input[i], input)
			}
		}
	}
}

// TestDaemonAttnTrackerL2Idle verifies L2 idle detection fires
// after the threshold when no new output arrives.
func TestDaemonAttnTrackerL2Idle(t *testing.T) {
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 200) // 200ms threshold
	// Idle only fires when a foreground process is running (FR-15).
	tracker.SetBusyProbe(func(string) bool { return true })

	var sseMu sync.Mutex
	var attentionReasons []string
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
				Args   struct {
					Reason string `json:"reason"`
				} `json:"args"`
			}
			json.Unmarshal(msg, &ev)
			if ev.Action == "tool_attention" {
				sseMu.Lock()
				attentionReasons = append(attentionReasons, ev.Args.Reason)
				sseMu.Unlock()
			}
		}
	}()
	defer cmdHub.Remove(sub)

	// Feed initial output to arm the idle detector
	tracker.FeedOutput("p1", []byte("prompt"))

	// Start sweeper
	stopCh := make(chan struct{})
	tracker.StartSweeper(stopCh)
	defer close(stopCh)

	// Wait for idle threshold to trigger (ticker fires every 1s)
	time.Sleep(1500 * time.Millisecond)

	sseMu.Lock()
	hasIdle := false
	for _, r := range attentionReasons {
		if r == "idle" {
			hasIdle = true
		}
	}
	sseMu.Unlock()

	if !hasIdle {
		t.Log("attention reasons:", attentionReasons)
		t.Fatal("expected L2 idle attention to fire after 200ms threshold")
	}
}

func bytesRepeat(n int, b byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

// TestDaemonToolCreateDeleteLifecycle verifies create → list → delete → not in list.
func TestDaemonToolCreateDeleteLifecycle(t *testing.T) {
	sockPath := t.TempDir() + "/s"

	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.WaitSaves)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	go func() { ps.Accept() }()

	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("toolclient.DialToolClient: %v", err)
	}
	defer pc.Close()

	// Create 3 tools
	for i := 0; i < 3; i++ {
		_, err := pc.Create("/tmp", 80, 24)
		if err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	// List should show 3
	if len(pc.List()) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(pc.List()))
	}

	// Delete middle tool
	ids := make([]string, 0)
	for _, m := range pc.List() {
		ids = append(ids, m["id"].(string))
	}
	pc.Delete(ids[1])
	time.Sleep(100 * time.Millisecond)

	// List should show 2
	if len(pc.List()) != 2 {
		t.Fatalf("expected 2 tools after delete, got %d", len(pc.List()))
	}
}

// TestDaemonPanedServerSocketCleanup verifies that Listen removes stale
// socket and Close cleans up.
func TestDaemonPanedServerSocketCleanup(t *testing.T) {
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	pidPath := dir + "/p"

	// Create a stale socket file
	if f, err := os.Create(sockPath); err == nil {
		f.Close()
	}

	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.WaitSaves)
	ps := ipc.NewPanedServer(pm, sockPath, pidPath)
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}

	// Verify pidfile
	if _, err := os.Stat(pidPath); os.IsNotExist(err) {
		t.Fatal("pidfile not created")
	}

	// Close should remove both
	if err := ps.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Fatal("socket not removed on Close")
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatal("pidfile not removed on Close")
	}
}

// TestDaemonAttnTrackerMultipleTools verifies attention tracking
// works independently for multiple tools.
func TestDaemonAttnTrackerMultipleTools(t *testing.T) {
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 10000)

	// Signal attention for tool A (FeedOutput first to register)
	tracker.FeedOutput("A", []byte("prompt"))
	tracker.SignalAttention("A", "done")
	if !tracker.Attention("A") {
		t.Fatal("tool A should have attention")
	}

	// Signal attention for tool B
	tracker.SignalAttention("B", "waiting")
	if !tracker.Attention("B") {
		t.Fatal("tool B should have attention")
	}

	// Attend A
	tracker.Attend("A")
	if tracker.Attention("A") {
		t.Fatal("tool A should NOT have attention after attend")
	}
	if !tracker.Attention("B") {
		t.Fatal("tool B should still have attention")
	}

	// Clear all
	cleared := tracker.ClearAllAttention()
	if cleared != 1 { // only B was remaining
		t.Fatalf("ClearAllAttention cleared=%d want 1", cleared)
	}
	if tracker.Attention("B") {
		t.Fatal("tool B should NOT have attention after clear-all")
	}
}

// TestDaemonConcurrentPushAndRequest exercises the IPC write path under
// concurrency: a tool streams output (push events from the readPTY goroutine)
// while the client hammers RPC requests (responses from the handle goroutine).
// Both encode onto the same json.Encoder; without writeMu serialization this
// races and corrupts the JSON-Lines stream (FR-11). Run with -race.
func TestDaemonConcurrentPushAndRequest(t *testing.T) {
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm := toolhub.NewToolManager(dataDir, nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("toolclient.DialToolClient: %v", err)
	}
	defer pc.Close()

	// Create a tool and subscribe so push events flow.
	tool, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	outputCh := make(chan []byte, 256)
	_, unsub := pc.Subscribe(tool.ID, outputCh)
	defer unsub()
	go func() {
		for range outputCh {
		}
	}()

	// Flood output from the tool (push events) ...
	if err := pc.Write(tool.ID, []byte("for i in $(seq 1 2000); do echo concurrency_probe_$i; done\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// ... while concurrently issuing many RPCs (responses).
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 400; i++ {
			pc.List()
			_ = pc.Cwd(tool.ID)
			_ = pc.Busy(tool.ID)
		}
	}()

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("concurrent RPC loop did not finish — stream likely corrupted/blocked")
	}

	// The connection must still be usable (stream not corrupted).
	if l := pc.List(); len(l) != 1 {
		t.Fatalf("expected 1 tool after concurrent IO, got %d", len(l))
	}
}

// TestDaemonAttnTrackerL2IdleBusyGate verifies idle does NOT fire when the
// busy probe reports no foreground process (a bare prompt) — FR-15.
func TestDaemonAttnTrackerL2IdleBusyGate(t *testing.T) {
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 100)
	tracker.SetBusyProbe(func(string) bool { return false }) // not busy

	var mu sync.Mutex
	var reasons []string
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			mu.Lock()
			reasons = append(reasons, ev.Action)
			mu.Unlock()
		}
	}()
	defer cmdHub.Remove(sub)

	tracker.FeedOutput("p1", []byte("prompt"))
	stopCh := make(chan struct{})
	tracker.StartSweeper(stopCh)
	defer close(stopCh)

	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	for _, r := range reasons {
		if r == "tool_attention" {
			t.Fatal("idle attention must not fire when tool is not busy (FR-15)")
		}
	}
}

// TestDaemonAttnTrackerL2IdleSuppressedWhileWorking verifies idle does NOT fire
// when the agent is actively working (activity state "working"). A thinking
// agent that pauses output is not waiting for input.
func TestDaemonAttnTrackerL2IdleSuppressedWhileWorking(t *testing.T) {
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 100)
	tracker.SetBusyProbe(func(string) bool { return true }) // busy

	var mu sync.Mutex
	var reasons []string
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			mu.Lock()
			reasons = append(reasons, ev.Action)
			mu.Unlock()
		}
	}()
	defer cmdHub.Remove(sub)

	tracker.FeedOutput("p1", []byte("output"))
	tracker.SetActivity("p1", "working", "bash", "running")
	stopCh := make(chan struct{})
	tracker.StartSweeper(stopCh)
	defer close(stopCh)

	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	for _, r := range reasons {
		if r == "tool_attention" {
			mu.Unlock()
			t.Fatal("idle attention must not fire while agent is working")
		}
	}
	mu.Unlock()

	// Agent stops working → idle should fire.
	tracker.SetActivity("p1", "ended", "", "")
	tracker.FeedOutput("p1", []byte("more output"))
	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, r := range reasons {
		if r == "tool_attention" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("idle attention must fire after agent stops working")
	}
}

// TestDaemonExitClosesSubscriber verifies a tool exit closes the per-subscriber
// exit channel so the WS handler can send toolhub.OpExit (parity with direct mode).
func TestDaemonExitClosesSubscriber(t *testing.T) {
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	os.MkdirAll(dir+"/d", 0o755)
	pm := toolhub.NewToolManager(dir+"/d", nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	tool, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	outputCh := make(chan []byte, 8)
	exitCh, unsub := pc.Subscribe(tool.ID, outputCh)
	defer unsub()

	pc.Delete(tool.ID) // triggers shell teardown → exit push

	select {
	case <-exitCh:
		// good: WS handler would now send toolhub.OpExit
	case <-time.After(3 * time.Second):
		t.Fatal("exitCh not closed after tool exit — browser terminal would hang")
	}
}

// TestDaemonAttentionWithoutSubscriber verifies OnOutput-driven attention
// detection fires even when no WS client is subscribed to the tool (FR-15).
func TestDaemonAttentionWithoutSubscriber(t *testing.T) {
	// 이 검사는 셸에게 `printf '\033]9;done\007'` 를 시켜 OSC 알림을 만든다 —
	// POSIX 셸 문법이다. pwsh 에는 그 printf 도 그 이스케이프도 없다.
	// Windows 의 같은 계층은 windows-runtime 잡의 종단간(서버→데몬→PTY)이
	// 실제로 왕복시켜 덮는다 (FR-WTP-32).
	if !testpath.POSIXShell() {
		t.Skip("POSIX 셸 문법으로 OSC 를 만드는 검사다")
	}
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	os.MkdirAll(dir+"/d", 0o755)
	pm := toolhub.NewToolManager(dir+"/d", nil)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 10000)
	pc.OnOutput = tracker.FeedOutput // wire detection like main.go

	var mu sync.Mutex
	var attn bool
	sub := cmdHub.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			if ev.Action == "tool_attention" {
				mu.Lock()
				attn = true
				mu.Unlock()
			}
		}
	}()
	defer cmdHub.Remove(sub)

	tool, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// NOTE: deliberately NOT subscribing any output channel.
	time.Sleep(200 * time.Millisecond)
	// Emit an OSC 9 notification from the shell.
	if err := pc.Write(tool.ID, []byte("printf '\\033]9;done\\007'\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ok := attn
		mu.Unlock()
		if ok {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("attention not detected without a WS subscriber (OnOutput not wired through readLoop?)")
}
