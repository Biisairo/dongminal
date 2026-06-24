package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// PaneClient is a dongminal-side client that connects to dongminald
// over a Unix socket and implements the PaneHub interface via JSON-RPC
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

type PaneClient struct {
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
	OnOutput    func(paneID string, data []byte)
	OnExit      func(paneID string, code int)
	earlyPushes []earlyPush

	// Per-pane WS subscribers: output channel → its exit-signal channel. The
	// exit channel is closed when the pane exits so the WS handler can send
	// OpExit and tear down (parity with direct-mode pane.kill).
	subMu   sync.RWMutex
	subbers map[string]map[chan []byte]chan struct{}
	dropped atomic.Int64
}

type earlyPush struct {
	event string
	pane  string
	data  []byte
	code  int
}

// DialPaneClient connects to the dongminald Unix socket, sends hello, and
// returns a ready-to-use PaneClient with auto-reconnect (no daemon respawn).
func DialPaneClient(sockPath string) (*PaneClient, error) {
	return DialPaneClientWithReconnect(sockPath, nil)
}

// DialPaneClientWithReconnect is DialPaneClient plus a spawnDaemon callback the
// supervisor invokes to respawn dongminald when dials keep failing (FR-13).
func DialPaneClientWithReconnect(sockPath string, spawnDaemon func() error) (*PaneClient, error) {
	pc := &PaneClient{
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
func (pc *PaneClient) connect() error {
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
func (pc *PaneClient) supervise() {
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
		log.Printf("paneclient: connection lost, reconnecting...")
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
				log.Printf("paneclient: reconnected")
				break
			}
			fails++
			if pc.spawnDaemon != nil && fails%panedRespawnEvery == 0 {
				log.Printf("paneclient: respawning dongminald after %d failed dials", fails)
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
func (pc *PaneClient) readLoop(conn net.Conn, cd chan struct{}) {
	dec := json.NewDecoder(conn)
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			if !pc.stopped.Load() {
				log.Printf("paneclient read: %v", err)
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
func (pc *PaneClient) connLost(cd chan struct{}) {
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
func (pc *PaneClient) dropIfCurrent(cd chan struct{}) {
	pc.mu.Lock()
	if pc.connDone == cd && pc.conn != nil {
		pc.conn.Close()
	}
	pc.mu.Unlock()
}

// handleResponse delivers a response to the waiting caller.
func (pc *PaneClient) handleResponse(id int64, raw json.RawMessage) {
	pc.mu.Lock()
	ch := pc.pending[id]
	delete(pc.pending, id)
	pc.mu.Unlock()
	if ch != nil {
		ch <- raw
	}
}

// handlePush dispatches a server-pushed event to per-pane subscribers
// and to the global OnOutput/OnExit callbacks.
func (pc *PaneClient) handlePush(event string, raw json.RawMessage) {
	switch event {
	case "output":
		var ev struct {
			Pane string `json:"pane"`
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
			pc.OnOutput(ev.Pane, data)
		}
		// Dispatch to per-pane output channels. Non-blocking: a single slow
		// WS subscriber must never stall readLoop (which serves every pane).
		// Drops are counted/logged rather than silently lost (FR-18).
		pc.subMu.RLock()
		chans := pc.subbers[ev.Pane]
		pc.subMu.RUnlock()
		for ch := range chans {
			select {
			case ch <- data:
			default:
				if n := pc.dropped.Add(1); n == 1 || n%256 == 0 {
					log.Printf("paneclient: WS output backpressure pane=%s dropped=%d (slow browser?)", ev.Pane, n)
				}
			}
		}
	case "exit":
		var ev struct {
			Pane string `json:"pane"`
			Code int    `json:"code"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
		// Signal every WS subscriber of this pane so it can send OpExit and
		// tear down (parity with direct-mode pane.kill). Closing + removing
		// under subMu means no concurrent output dispatch sends on a closed chan.
		pc.subMu.Lock()
		subs := pc.subbers[ev.Pane]
		delete(pc.subbers, ev.Pane)
		pc.subMu.Unlock()
		for _, exitCh := range subs {
			close(exitCh)
		}
		// Global exit callback (activity cleanup). Buffer if not yet wired.
		pc.mu.Lock()
		if pc.OnExit != nil {
			pc.mu.Unlock()
			pc.OnExit(ev.Pane, ev.Code)
		} else {
			pc.earlyPushes = append(pc.earlyPushes, earlyPush{event: "exit", pane: ev.Pane, code: ev.Code})
			pc.mu.Unlock()
		}
	}
}

// FlushEarlyPushes replays any buffered exit events that arrived before
// the OnExit callback was set.
func (pc *PaneClient) FlushEarlyPushes() {
	pc.mu.Lock()
	pushes := pc.earlyPushes
	pc.earlyPushes = nil
	pc.mu.Unlock()
	for _, p := range pushes {
		if p.event == "exit" && pc.OnExit != nil {
			pc.OnExit(p.pane, p.code)
		}
	}
}

// call sends a request and blocks until the response arrives, the connection
// is lost, the call times out (FR-14), or the client closes.
func (pc *PaneClient) call(method string, params interface{}) (map[string]interface{}, error) {
	pc.mu.Lock()
	if pc.enc == nil {
		pc.mu.Unlock()
		return nil, fmt.Errorf("paneclient not connected")
	}
	id := pc.nextID
	pc.nextID++
	ch := make(chan json.RawMessage, 1)
	pc.pending[id] = ch
	cd := pc.connDone
	enc := pc.enc
	pc.mu.Unlock()

	req := panedRequest{ID: id, Method: method}
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
		var resp panedResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			// Try error response
			var errResp panedError
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
		return nil, fmt.Errorf("paneclient closed")
	}
}

// Close shuts down the client connection and stops the reconnect supervisor.
func (pc *PaneClient) Close() {
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

// Subscribe registers an output channel for a pane. It returns exitCh (closed
// when the pane exits) and an unsubscribe function. unsubscribe removes the
// channel; it does not close exitCh (the pane-exit path owns that close).
func (pc *PaneClient) Subscribe(paneID string, ch chan []byte) (exitCh <-chan struct{}, unsubscribe func()) {
	ex := make(chan struct{})
	pc.subMu.Lock()
	if pc.subbers[paneID] == nil {
		pc.subbers[paneID] = map[chan []byte]chan struct{}{}
	}
	pc.subbers[paneID][ch] = ex
	pc.subMu.Unlock()
	return ex, func() {
		pc.subMu.Lock()
		delete(pc.subbers[paneID], ch)
		pc.subMu.Unlock()
	}
}

// IsDaemon reports whether this PaneClient is in daemon mode (always true).
// Used by handleWS to detect daemon mode at runtime.
func (pc *PaneClient) IsDaemon() bool { return true }

// Connected reports whether a live daemon connection is currently established.
// During a reconnect window it returns false, so callers can distinguish a
// genuinely missing pane from a transient outage and avoid telling the browser
// the pane is gone.
func (pc *PaneClient) Connected() bool {
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

// ── PaneHub implementation ──────────────────────────────────────────────

func (pc *PaneClient) List() []map[string]interface{} {
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil
	}
	raw, ok := resp["panes"]
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

func (pc *PaneClient) Create(cwd string, cols, rows uint16) (*Pane, error) {
	resp, err := pc.call("create", map[string]interface{}{
		"cwd": cwd, "cols": cols, "rows": rows,
	})
	if err != nil {
		return nil, err
	}
	id, _ := resp["id"].(string)
	name, _ := resp["name"].(string)
	return &Pane{ID: id, Name: name}, nil
}

func (pc *PaneClient) Get(id string) *Pane {
	// PaneClient doesn't have local state; we check liveness via List
	panes := pc.List()
	for _, m := range panes {
		if m["id"].(string) == id {
			name, _ := m["name"].(string)
			return &Pane{ID: id, Name: name}
		}
	}
	return nil
}

func (pc *PaneClient) Delete(id string) {
	pc.call("kill", map[string]interface{}{"id": id})
}

func (pc *PaneClient) Restore(id, name, cwd string, cols, rows uint16) error {
	_, err := pc.call("restore", map[string]interface{}{
		"id": id, "name": name, "cwd": cwd, "cols": cols, "rows": rows,
	})
	return err
}

func (pc *PaneClient) IsLive(id string) bool {
	return pc.Get(id) != nil
}

func (pc *PaneClient) SaveAll() {}
func (pc *PaneClient) LoadAll() {}

func (pc *PaneClient) Write(id string, data []byte) error {
	_, err := pc.call("write", map[string]interface{}{
		"id":   id,
		"data": base64.StdEncoding.EncodeToString(data),
	})
	return err
}

func (pc *PaneClient) Resize(id string, cols, rows uint16) error {
	_, err := pc.call("resize", map[string]interface{}{
		"id": id, "cols": cols, "rows": rows,
	})
	return err
}

func (pc *PaneClient) Cwd(id string) string {
	resp, err := pc.call("cwd", map[string]interface{}{"id": id})
	if err != nil {
		return ""
	}
	cwd, _ := resp["cwd"].(string)
	return cwd
}

func (pc *PaneClient) Busy(id string) bool {
	resp, err := pc.call("busy", map[string]interface{}{"id": id})
	if err != nil {
		return false
	}
	busy, _ := resp["busy"].(bool)
	return busy
}

func (pc *PaneClient) SnapshotPane(id string) (PaneSnapshot, error) {
	resp, err := pc.call("snapshot", map[string]interface{}{"id": id})
	if err != nil {
		return PaneSnapshot{}, err
	}
	dataStr, _ := resp["data"].(string)
	data, _ := base64.StdEncoding.DecodeString(dataStr)
	totalIn, _ := resp["totalBytesIn"].(float64)
	totalDrop, _ := resp["totalBytesDrop"].(float64)
	retained, _ := resp["retained"].(float64)
	return PaneSnapshot{
		Data:           data,
		TotalBytesIn:   int64(totalIn),
		TotalBytesDrop: int64(totalDrop),
		Retained:       int(retained),
	}, nil
}

// Ensure PaneClient implements PaneHub.
var _ PaneHub = (*PaneClient)(nil)
