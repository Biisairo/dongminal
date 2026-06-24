package server

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"
)

// TestDaemonFullFlow verifies the complete daemon lifecycle:
// create → write input → read output → attention detection → activity → exit cleanup.
func TestDaemonFullFlow(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	// Start dongminald
	pm := NewPaneManager(dataDir, nil)
	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	go func() { ps.Accept() }()

	// Connect dongminal
	pc, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("DialPaneClient: %v", err)
	}
	defer pc.Close()

	// Create attention tracker (simulating dongminal's setup)
	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 500) // 500ms idle threshold for fast test

	// Wire exit → activity cleanup
	pc.OnExit = func(paneID string, code int) {
		tracker.SetActivity(paneID, "ended", "", "")
	}
	pc.FlushEarlyPushes()

	// Record SSE broadcasts
	var sseMu sync.Mutex
	var sseEvents []string
	sub := hub.add()
	go func() {
		for msg := range sub.ch {
			var ev struct {
				Action string `json:"action"`
				Args   struct {
					PaneID string `json:"paneId"`
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
	defer hub.remove(sub)

	// Create a pane
	pane, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	paneID := pane.ID

	// Give the shell time to start and produce output (prompt)
	time.Sleep(200 * time.Millisecond)

	// Subscribe to output
	outputCh := make(chan []byte, 32)
	_, unsub := pc.Subscribe(paneID, outputCh)
	defer unsub()

	// Feed output to attention tracker
	go func() {
		for data := range outputCh {
			tracker.FeedOutput(paneID, data)
		}
	}()

	// Write input to trigger output
	if err := pc.Write(paneID, []byte("echo hello\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Wait for output
	select {
	case <-outputCh:
		// got some output
	case <-time.After(2 * time.Second):
		t.Fatal("no output received from pane")
	}

	// Set activity
	tracker.SetActivity(paneID, "working", "claude", "testing")

	// Snapshot
	snap, err := pc.SnapshotPane(paneID)
	if err != nil {
		t.Fatalf("SnapshotPane: %v", err)
	}
	if snap.Data == nil {
		t.Fatal("snapshot data is nil")
	}

	// Kill pane → should trigger exit → activity cleanup
	pc.Delete(paneID)
	time.Sleep(300 * time.Millisecond)

	// Verify activity was cleared
	if a := tracker.Activity(paneID); a != nil {
		t.Fatal("activity should be nil after exit")
	}

	// Verify SSE events include activity "ended" or similar
	sseMu.Lock()
	found := false
	for _, ev := range sseEvents {
		if ev == "pane_activity" {
			found = true
			break
		}
	}
	sseMu.Unlock()
	if !found {
		t.Log("SSE events:", sseEvents)
		t.Fatal("expected pane_activity SSE event")
	}
}

// TestDaemonAttentionDetection verifies L1 OSC attention detection
// in daemon mode via AttnTracker.
func TestDaemonAttentionDetection(t *testing.T) {
	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 10000)

	var sseMu sync.Mutex
	var attentionEvents []string
	sub := hub.add()
	go func() {
		for msg := range sub.ch {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			sseMu.Lock()
			attentionEvents = append(attentionEvents, ev.Action)
			sseMu.Unlock()
		}
	}()
	defer hub.remove(sub)

	// Feed output with OSC 9 notification
	oscNotify := []byte("\x1b]9;done\x07")
	tracker.FeedOutput("test-pane", oscNotify)

	time.Sleep(50 * time.Millisecond)

	sseMu.Lock()
	hasAttention := false
	for _, ev := range attentionEvents {
		if ev == "pane_attention" {
			hasAttention = true
		}
	}
	sseMu.Unlock()

	if !hasAttention {
		t.Fatal("expected pane_attention SSE event for OSC 9")
	}

	// Clear attention
	tracker.Attend("test-pane")
	time.Sleep(50 * time.Millisecond)
	sseMu.Lock()
	hasClear := false
	for _, ev := range attentionEvents {
		if ev == "pane_attention_clear" {
			hasClear = true
		}
	}
	sseMu.Unlock()
	if !hasClear {
		t.Fatal("expected pane_attention_clear SSE event")
	}
}

// TestDaemonReconnectPreservesPanes verifies that panes survive
// a dongminal reconnection (dongminald stays alive).
func TestDaemonReconnectPreservesPanes(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	// Start dongminald with a pane created directly in PaneManager
	pm := NewPaneManager(dataDir, nil)
	p, err := pm.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	paneID := p.ID

	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	// First dongminal connection
	go func() { ps.Accept() }()
	pc1, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("Dial1: %v", err)
	}

	// Verify pane exists
	panes1 := pc1.List()
	found := false
	for _, m := range panes1 {
		if m["id"].(string) == paneID {
			found = true
		}
	}
	if !found {
		t.Fatal("pane not found in list after first connection")
	}

	// Simulate dongminal restart: close client, accept new connection
	pc1.Close()
	time.Sleep(100 * time.Millisecond)

	// Second dongminal connects
	go func() { ps.Accept() }()
	pc2, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("Dial2: %v", err)
	}
	defer pc2.Close()

	// Verify pane still exists
	panes2 := pc2.List()
	found = false
	for _, m := range panes2 {
		if m["id"].(string) == paneID {
			found = true
		}
	}
	if !found {
		t.Fatal("pane not found after reconnection")
	}

	// Output should still flow
	_ = pm.Write(paneID, []byte("echo reconnect_test\n"))
	time.Sleep(200 * time.Millisecond)

	snap, _ := pm.SnapshotPane(paneID)
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
	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 200) // 200ms threshold
	// Idle only fires when a foreground process is running (FR-15).
	tracker.SetBusyProbe(func(string) bool { return true })

	var sseMu sync.Mutex
	var attentionReasons []string
	sub := hub.add()
	go func() {
		for msg := range sub.ch {
			var ev struct {
				Action string `json:"action"`
				Args   struct {
					Reason string `json:"reason"`
				} `json:"args"`
			}
			json.Unmarshal(msg, &ev)
			if ev.Action == "pane_attention" {
				sseMu.Lock()
				attentionReasons = append(attentionReasons, ev.Args.Reason)
				sseMu.Unlock()
			}
		}
	}()
	defer hub.remove(sub)

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

// TestDaemonPaneCreateDeleteLifecycle verifies create → list → delete → not in list.
func TestDaemonPaneCreateDeleteLifecycle(t *testing.T) {
	sockPath := t.TempDir() + "/s"

	pm := NewPaneManager(t.TempDir(), nil)
	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()

	go func() { ps.Accept() }()

	pc, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("DialPaneClient: %v", err)
	}
	defer pc.Close()

	// Create 3 panes
	for i := 0; i < 3; i++ {
		_, err := pc.Create("/tmp", 80, 24)
		if err != nil {
			t.Fatalf("Create %d: %v", i, err)
		}
	}

	// List should show 3
	if len(pc.List()) != 3 {
		t.Fatalf("expected 3 panes, got %d", len(pc.List()))
	}

	// Delete middle pane
	ids := make([]string, 0)
	for _, m := range pc.List() {
		ids = append(ids, m["id"].(string))
	}
	pc.Delete(ids[1])
	time.Sleep(100 * time.Millisecond)

	// List should show 2
	if len(pc.List()) != 2 {
		t.Fatalf("expected 2 panes after delete, got %d", len(pc.List()))
	}
}

// TestDaemonPanedServerSocketCleanup verifies that Listen removes stale
// socket and Close cleans up.
func TestDaemonPanedServerSocketCleanup(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	pidPath := dir + "/p"

	// Create a stale socket file
	if f, err := os.Create(sockPath); err == nil {
		f.Close()
	}

	pm := NewPaneManager(t.TempDir(), nil)
	ps := NewPanedServer(pm, sockPath, pidPath)
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

// TestDaemonAttnTrackerMultiplePanes verifies attention tracking
// works independently for multiple panes.
func TestDaemonAttnTrackerMultiplePanes(t *testing.T) {
	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 10000)

	// Signal attention for pane A (FeedOutput first to register)
	tracker.FeedOutput("A", []byte("prompt"))
	tracker.SignalAttention("A", "done")
	if !tracker.Attention("A") {
		t.Fatal("pane A should have attention")
	}

	// Signal attention for pane B
	tracker.SignalAttention("B", "waiting")
	if !tracker.Attention("B") {
		t.Fatal("pane B should have attention")
	}

	// Attend A
	tracker.Attend("A")
	if tracker.Attention("A") {
		t.Fatal("pane A should NOT have attention after attend")
	}
	if !tracker.Attention("B") {
		t.Fatal("pane B should still have attention")
	}

	// Clear all
	cleared := tracker.ClearAllAttention()
	if cleared != 1 { // only B was remaining
		t.Fatalf("ClearAllAttention cleared=%d want 1", cleared)
	}
	if tracker.Attention("B") {
		t.Fatal("pane B should NOT have attention after clear-all")
	}
}

// TestDaemonConcurrentPushAndRequest exercises the IPC write path under
// concurrency: a pane streams output (push events from the readPTY goroutine)
// while the client hammers RPC requests (responses from the handle goroutine).
// Both encode onto the same json.Encoder; without writeMu serialization this
// races and corrupts the JSON-Lines stream (FR-11). Run with -race.
func TestDaemonConcurrentPushAndRequest(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm := NewPaneManager(dataDir, nil)
	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("DialPaneClient: %v", err)
	}
	defer pc.Close()

	// Create a pane and subscribe so push events flow.
	pane, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	outputCh := make(chan []byte, 256)
	_, unsub := pc.Subscribe(pane.ID, outputCh)
	defer unsub()
	go func() {
		for range outputCh {
		}
	}()

	// Flood output from the pane (push events) ...
	if err := pc.Write(pane.ID, []byte("for i in $(seq 1 2000); do echo concurrency_probe_$i; done\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// ... while concurrently issuing many RPCs (responses).
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 400; i++ {
			pc.List()
			_ = pc.Cwd(pane.ID)
			_ = pc.Busy(pane.ID)
		}
	}()

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("concurrent RPC loop did not finish — stream likely corrupted/blocked")
	}

	// The connection must still be usable (stream not corrupted).
	if l := pc.List(); len(l) != 1 {
		t.Fatalf("expected 1 pane after concurrent IO, got %d", len(l))
	}
}

// TestDaemonAttnTrackerL2IdleBusyGate verifies idle does NOT fire when the
// busy probe reports no foreground process (a bare prompt) — FR-15.
func TestDaemonAttnTrackerL2IdleBusyGate(t *testing.T) {
	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 100)
	tracker.SetBusyProbe(func(string) bool { return false }) // not busy

	var mu sync.Mutex
	var reasons []string
	sub := hub.add()
	go func() {
		for msg := range sub.ch {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			mu.Lock()
			reasons = append(reasons, ev.Action)
			mu.Unlock()
		}
	}()
	defer hub.remove(sub)

	tracker.FeedOutput("p1", []byte("prompt"))
	stopCh := make(chan struct{})
	tracker.StartSweeper(stopCh)
	defer close(stopCh)

	time.Sleep(1300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	for _, r := range reasons {
		if r == "pane_attention" {
			t.Fatal("idle attention must not fire when pane is not busy (FR-15)")
		}
	}
}

// TestDaemonExitClosesSubscriber verifies a pane exit closes the per-subscriber
// exit channel so the WS handler can send OpExit (parity with direct mode).
func TestDaemonExitClosesSubscriber(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	os.MkdirAll(dir+"/d", 0o755)
	pm := NewPaneManager(dir+"/d", nil)
	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	pane, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	outputCh := make(chan []byte, 8)
	exitCh, unsub := pc.Subscribe(pane.ID, outputCh)
	defer unsub()

	pc.Delete(pane.ID) // triggers shell teardown → exit push

	select {
	case <-exitCh:
		// good: WS handler would now send OpExit
	case <-time.After(3 * time.Second):
		t.Fatal("exitCh not closed after pane exit — browser terminal would hang")
	}
}

// TestDaemonAttentionWithoutSubscriber verifies OnOutput-driven attention
// detection fires even when no WS client is subscribed to the pane (FR-15).
func TestDaemonAttentionWithoutSubscriber(t *testing.T) {
	dir := t.TempDir()
	sockPath := dir + "/s"
	os.MkdirAll(dir+"/d", 0o755)
	pm := NewPaneManager(dir+"/d", nil)
	ps := NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()

	pc, err := DialPaneClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	hub := NewCommandHub()
	tracker := NewAttnTracker(hub, 10000)
	pc.OnOutput = tracker.FeedOutput // wire detection like main.go

	var mu sync.Mutex
	var attn bool
	sub := hub.add()
	go func() {
		for msg := range sub.ch {
			var ev struct {
				Action string `json:"action"`
			}
			json.Unmarshal(msg, &ev)
			if ev.Action == "pane_attention" {
				mu.Lock()
				attn = true
				mu.Unlock()
			}
		}
	}()
	defer hub.remove(sub)

	pane, err := pc.Create("/tmp", 80, 24)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// NOTE: deliberately NOT subscribing any output channel.
	time.Sleep(200 * time.Millisecond)
	// Emit an OSC 9 notification from the shell.
	if err := pc.Write(pane.ID, []byte("printf '\\033]9;done\\007'\n")); err != nil {
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
