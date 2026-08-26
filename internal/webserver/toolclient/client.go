package toolclient

import (
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ToolClient is a dongminal-side client that connects to dongminald
// over a Unix socket and implements the toolhub.ToolHub interface via JSON-RPC
// style request/response (DAEMON_SPLIT_SRS Phase 3).
const (
	// panedCallTimeout bounds a single RPC. On expiry the connection is
	// dropped and the supervisor reconnects (DAEMON_SPLIT_SRS FR-14).
	panedCallTimeout = 5 * time.Second
	// panedMaxBackoff caps the reconnect backoff (FR-13).
	panedMaxBackoff = 30 * time.Second
	// panedRespawnEvery: respawn dongminald after this many consecutive
	// failed dials (socket gone → daemon likely dead).
	panedRespawnEvery = 3
)

type ToolClient struct {
	sockPath    string
	spawnDaemon func() error // respawns dongminald on repeated dial failure; nil disables respawn

	mu       sync.Mutex
	conn     net.Conn
	enc      *json.Encoder
	pending  map[int64]chan json.RawMessage
	nextID   int64
	connDone chan struct{} // closed when the current connection dies

	stopped   atomic.Bool
	closeOnce sync.Once
	closed    chan struct{}

	// Push event callbacks. OnOutput runs once per output chunk in the readLoop
	// goroutine (attention/activity detection — DAEMON_SPLIT_SRS §6.2); it is
	// independent of WS subscribers so detection works even with no browser and
	// never double-counts or races attnCarry across multiple subscribers.
	OnOutput    func(toolID string, data []byte)
	OnExit      func(toolID string, code int)
	earlyPushes []earlyPush

	// Per-tool WS subscribers: output channel → its exit-signal channel. The
	// exit channel is closed when the tool exits so the WS handler can send
	// toolhub.OpExit and tear down (parity with direct-mode tool.kill).
	subMu   sync.RWMutex
	subbers map[string]map[chan []byte]chan struct{}
	dropped atomic.Int64
}

type earlyPush struct {
	event string
	tool  string
	data  []byte
	code  int
}

// DialToolClient connects to the dongminald Unix socket, sends hello, and
// returns a ready-to-use ToolClient with auto-reconnect (no daemon respawn).
func DialToolClient(sockPath string) (*ToolClient, error) {
	return DialPaneClientWithReconnect(sockPath, nil)
}

// DialPaneClientWithReconnect is DialToolClient plus a spawnDaemon callback the
// supervisor invokes to respawn dongminald when dials keep failing (FR-13).
func DialPaneClientWithReconnect(sockPath string, spawnDaemon func() error) (*ToolClient, error) {
	pc := &ToolClient{
		sockPath:    sockPath,
		spawnDaemon: spawnDaemon,
		pending:     make(map[int64]chan json.RawMessage),
		closed:      make(chan struct{}),
		subbers:     map[string]map[chan []byte]chan struct{}{},
	}
	if err := pc.connect(); err != nil {
		return nil, fmt.Errorf("dial paned: %w", err)
	}
	go pc.supervise()
	return pc, nil
}

// connect establishes one connection, starts its readLoop, and completes the
// hello handshake. Safe to call repeatedly (initial dial + each reconnect).
func (pc *ToolClient) connect() error {
	conn, err := net.Dial("unix", pc.sockPath)
	if err != nil {
		return err
	}
	cd := make(chan struct{})
	pc.mu.Lock()
	pc.conn = conn
	pc.enc = json.NewEncoder(conn)
	pc.connDone = cd
	pc.mu.Unlock()

	go pc.readLoop(conn, cd)

	if _, err := pc.call("hello", map[string]interface{}{"server_pid": 0}); err != nil {
		conn.Close()
		return fmt.Errorf("hello: %w", err)
	}
	return nil
}

// supervise watches for connection loss and reconnects with exponential
// backoff, respawning dongminald when dials keep failing (FR-13).
func (pc *ToolClient) supervise() {
	for {
		pc.mu.Lock()
		cd := pc.connDone
		pc.mu.Unlock()
		select {
		case <-pc.closed:
			return
		case <-cd:
		}
		if pc.stopped.Load() {
			return
		}
		log.Printf("toolclient: connection lost, reconnecting...")
		backoff := time.Second
		fails := 0
		for {
			if pc.stopped.Load() {
				return
			}
			select {
			case <-pc.closed:
				return
			case <-time.After(backoff):
			}
			if err := pc.connect(); err == nil {
				log.Printf("toolclient: reconnected")
				break
			}
			fails++
			if pc.spawnDaemon != nil && fails%panedRespawnEvery == 0 {
				log.Printf("toolclient: respawning dongminald after %d failed dials", fails)
				_ = pc.spawnDaemon()
			}
			if backoff < panedMaxBackoff {
				backoff *= 2
				if backoff > panedMaxBackoff {
					backoff = panedMaxBackoff
				}
			}
		}
	}
}

// readLoop decodes responses and push events for a single connection. On
// connection death it signals connLost so the supervisor can reconnect.
func (pc *ToolClient) readLoop(conn net.Conn, cd chan struct{}) {
	dec := json.NewDecoder(conn)
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			if !pc.stopped.Load() {
				log.Printf("toolclient read: %v", err)
			}
			break
		}

		// Peek at the "id" field to distinguish response from push event.
		var peek struct {
			ID    *int64 `json:"id"`
			Event string `json:"event"`
		}
		if err := json.Unmarshal(raw, &peek); err != nil {
			continue
		}

		if peek.Event != "" {
			pc.handlePush(peek.Event, raw)
		} else if peek.ID != nil {
			pc.handleResponse(*peek.ID, raw)
		}
	}
	pc.connLost(cd)
}

// connLost closes connDone exactly once and fails all pending calls for the
// dead connection so blocked callers return promptly (FR-14).
func (pc *ToolClient) connLost(cd chan struct{}) {
	pc.mu.Lock()
	select {
	case <-cd:
		pc.mu.Unlock()
		return // already handled
	default:
	}
	close(cd)
	pending := pc.pending
	pc.pending = make(map[int64]chan json.RawMessage)
	pc.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}

// dropIfCurrent closes the live socket only if it still matches cd, forcing
// readLoop to error out and the supervisor to reconnect.
func (pc *ToolClient) dropIfCurrent(cd chan struct{}) {
	pc.mu.Lock()
	if pc.connDone == cd && pc.conn != nil {
		pc.conn.Close()
	}
	pc.mu.Unlock()
}

// handleResponse delivers a response to the waiting caller.
func (pc *ToolClient) handleResponse(id int64, raw json.RawMessage) {
	pc.mu.Lock()
	ch := pc.pending[id]
	delete(pc.pending, id)
	pc.mu.Unlock()
	if ch != nil {
		ch <- raw
	}
}

// handlePush dispatches a server-pushed event to per-tool subscribers
// and to the global OnOutput/OnExit callbacks.
func (pc *ToolClient) handlePush(event string, raw json.RawMessage) {
	switch event {
	case "output":
		var ev struct {
			Tool string `json:"tool"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
		data, err := base64.StdEncoding.DecodeString(ev.Data)
		if err != nil {
			return
		}
		// Attention/activity detection: once per chunk, in this single readLoop
		// goroutine — independent of WS subscribers (FR-15, §6.2).
		if pc.OnOutput != nil {
			pc.OnOutput(ev.Tool, data)
		}
		// Dispatch to per-tool output channels. Non-blocking: a single slow
		// WS subscriber must never stall readLoop (which serves every tool).
		// Drops are counted/logged rather than silently lost (FR-18).
		pc.subMu.RLock()
		chans := pc.subbers[ev.Tool]
		pc.subMu.RUnlock()
		for ch := range chans {
			select {
			case ch <- data:
			default:
				if n := pc.dropped.Add(1); n == 1 || n%256 == 0 {
					log.Printf("toolclient: WS output backpressure tool=%s dropped=%d (slow browser?)", ev.Tool, n)
				}
			}
		}
	case "exit":
		var ev struct {
			Tool string `json:"tool"`
			Code int    `json:"code"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
		// Signal every WS subscriber of this tool so it can send toolhub.OpExit and
		// tear down (parity with direct-mode tool.kill). Closing + removing
		// under subMu means no concurrent output dispatch sends on a closed chan.
		pc.subMu.Lock()
		subs := pc.subbers[ev.Tool]
		delete(pc.subbers, ev.Tool)
		pc.subMu.Unlock()
		for _, exitCh := range subs {
			close(exitCh)
		}
		// Global exit callback (activity cleanup). Buffer if not yet wired.
		pc.mu.Lock()
		if pc.OnExit != nil {
			pc.mu.Unlock()
			pc.OnExit(ev.Tool, ev.Code)
		} else {
			pc.earlyPushes = append(pc.earlyPushes, earlyPush{event: "exit", tool: ev.Tool, code: ev.Code})
			pc.mu.Unlock()
		}
	}
}

// FlushEarlyPushes replays any buffered exit events that arrived before
// the OnExit callback was set.
func (pc *ToolClient) FlushEarlyPushes() {
	pc.mu.Lock()
	pushes := pc.earlyPushes
	pc.earlyPushes = nil
	pc.mu.Unlock()
	for _, p := range pushes {
		if p.event == "exit" && pc.OnExit != nil {
			pc.OnExit(p.tool, p.code)
		}
	}
}

// call sends a request and blocks until the response arrives, the connection
// is lost, the call times out (FR-14), or the client closes.
func (pc *ToolClient) call(method string, params interface{}) (map[string]interface{}, error) {
	pc.mu.Lock()
	if pc.enc == nil {
		pc.mu.Unlock()
		return nil, fmt.Errorf("toolclient not connected")
	}
	id := pc.nextID
	pc.nextID++
	ch := make(chan json.RawMessage, 1)
	pc.pending[id] = ch
	cd := pc.connDone
	enc := pc.enc
	pc.mu.Unlock()

	req := toolipc.PanedRequest{ID: id, Method: method}
	paramBytes, _ := json.Marshal(params)
	req.Params = paramBytes

	pc.mu.Lock()
	err := enc.Encode(req)
	pc.mu.Unlock()
	if err != nil {
		pc.mu.Lock()
		delete(pc.pending, id)
		pc.mu.Unlock()
		return nil, err
	}

	select {
	case raw, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("paned connection lost")
		}
		var resp toolipc.PanedResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			// Try error response
			var errResp toolipc.PanedError
			if err2 := json.Unmarshal(raw, &errResp); err2 == nil {
				return nil, fmt.Errorf("paned error: %s", errResp.Error.Message)
			}
			return nil, err
		}
		result, ok := resp.Result.(map[string]interface{})
		if !ok {
			return map[string]interface{}{}, nil
		}
		return result, nil
	case <-cd:
		return nil, fmt.Errorf("paned connection lost")
	case <-time.After(panedCallTimeout):
		pc.mu.Lock()
		delete(pc.pending, id)
		pc.mu.Unlock()
		pc.dropIfCurrent(cd)
		return nil, fmt.Errorf("paned call %q timed out", method)
	case <-pc.closed:
		return nil, fmt.Errorf("toolclient closed")
	}
}

// Close shuts down the client connection and stops the reconnect supervisor.
func (pc *ToolClient) Close() {
	pc.closeOnce.Do(func() {
		pc.stopped.Store(true)
		close(pc.closed)
		pc.mu.Lock()
		conn := pc.conn
		pc.mu.Unlock()
		if conn != nil {
			conn.Close()
		}
	})
}

// Subscribe registers an output channel for a tool. It returns exitCh (closed
// when the tool exits) and an unsubscribe function. unsubscribe removes the
// channel; it does not close exitCh (the tool-exit path owns that close).
func (pc *ToolClient) Subscribe(toolID string, ch chan []byte) (exitCh <-chan struct{}, unsubscribe func()) {
	ex := make(chan struct{})
	pc.subMu.Lock()
	if pc.subbers[toolID] == nil {
		pc.subbers[toolID] = map[chan []byte]chan struct{}{}
	}
	pc.subbers[toolID][ch] = ex
	pc.subMu.Unlock()
	return ex, func() {
		pc.subMu.Lock()
		delete(pc.subbers[toolID], ch)
		pc.subMu.Unlock()
	}
}

// IsDaemon reports whether this ToolClient is in daemon mode (always true).
// Used by handleWS to detect daemon mode at runtime.
func (pc *ToolClient) IsDaemon() bool { return true }

// Connected reports whether a live daemon connection is currently established.
// During a reconnect window it returns false, so callers can distinguish a
// genuinely missing tool from a transient outage and avoid telling the browser
// the tool is gone.
func (pc *ToolClient) Connected() bool {
	pc.mu.Lock()
	cd, conn := pc.connDone, pc.conn
	pc.mu.Unlock()
	if conn == nil || cd == nil {
		return false
	}
	select {
	case <-cd:
		return false // connection dead, supervisor reconnecting
	default:
		return true
	}
}

// ── toolhub.ToolHub implementation ──────────────────────────────────────────────

func (pc *ToolClient) List() []map[string]interface{} {
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil
	}
	raw, ok := resp["tools"]
	if !ok {
		return nil
	}
	arr, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if ok {
			out = append(out, m)
		}
	}
	return out
}

func (pc *ToolClient) Create(cwd string, cols, rows uint16) (*toolhub.Tool, error) {
	resp, err := pc.call("create", map[string]interface{}{
		"cwd": cwd, "cols": cols, "rows": rows,
	})
	if err != nil {
		return nil, err
	}
	id, _ := resp["id"].(string)
	name, _ := resp["name"].(string)
	return &toolhub.Tool{ID: id, Name: name}, nil
}

func (pc *ToolClient) Get(id string) *toolhub.Tool {
	// ToolClient doesn't have local state; we check liveness via List
	tools := pc.List()
	for _, m := range tools {
		if m["id"].(string) == id {
			name, _ := m["name"].(string)
			return &toolhub.Tool{ID: id, Name: name}
		}
	}
	return nil
}

func (pc *ToolClient) Delete(id string) {
	pc.call("kill", map[string]interface{}{"id": id})
}

func (pc *ToolClient) Restore(id, name, cwd string, cols, rows uint16) error {
	_, err := pc.call("restore", map[string]interface{}{
		"id": id, "name": name, "cwd": cwd, "cols": cols, "rows": rows,
	})
	return err
}

func (pc *ToolClient) IsLive(id string) bool {
	return pc.Get(id) != nil
}

func (pc *ToolClient) SaveAll()                    {}
func (pc *ToolClient) LoadAll(map[string]struct{}) {}

func (pc *ToolClient) Write(id string, data []byte) error {
	_, err := pc.call("write", map[string]interface{}{
		"id":   id,
		"data": base64.StdEncoding.EncodeToString(data),
	})
	return err
}

func (pc *ToolClient) Resize(id string, cols, rows uint16) error {
	_, err := pc.call("resize", map[string]interface{}{
		"id": id, "cols": cols, "rows": rows,
	})
	return err
}

func (pc *ToolClient) Cwd(id string) string {
	resp, err := pc.call("cwd", map[string]interface{}{"id": id})
	if err != nil {
		return ""
	}
	cwd, _ := resp["cwd"].(string)
	return cwd
}

func (pc *ToolClient) Busy(id string) bool {
	resp, err := pc.call("busy", map[string]interface{}{"id": id})
	if err != nil {
		return false
	}
	busy, _ := resp["busy"].(bool)
	return busy
}

func (pc *ToolClient) SetBackground(id string, bg bool) bool {
	resp, err := pc.call("setbackground", map[string]interface{}{"id": id, "background": bg})
	if err != nil {
		return false
	}
	ok, _ := resp["ok"].(bool)
	return ok
}

func (pc *ToolClient) BackgroundList() []toolhub.BackgroundEntry {
	resp, err := pc.call("backgroundlist", map[string]interface{}{})
	if err != nil {
		return nil
	}
	raw, ok := resp["background"]
	if !ok {
		return nil
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var out []toolhub.BackgroundEntry
	if json.Unmarshal(blob, &out) != nil {
		return nil
	}
	return out
}

func (pc *ToolClient) SnapshotTool(id string) (toolhub.ToolSnapshot, error) {
	resp, err := pc.call("snapshot", map[string]interface{}{"id": id})
	if err != nil {
		return toolhub.ToolSnapshot{}, err
	}
	dataStr, _ := resp["data"].(string)
	data, _ := base64.StdEncoding.DecodeString(dataStr)
	totalIn, _ := resp["totalBytesIn"].(float64)
	totalDrop, _ := resp["totalBytesDrop"].(float64)
	retained, _ := resp["retained"].(float64)
	return toolhub.ToolSnapshot{
		Data:           data,
		TotalBytesIn:   int64(totalIn),
		TotalBytesDrop: int64(totalDrop),
		Retained:       int(retained),
	}, nil
}

// Ensure ToolClient implements toolhub.ToolHub.
var _ toolhub.ToolHub = (*ToolClient)(nil)
