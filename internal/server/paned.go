package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
)

// ── Protocol types ──────────────────────────────────────────────────────

type panedRequest struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type panedResponse struct {
	ID     int64       `json:"id"`
	Result interface{} `json:"result"`
}

type panedError struct {
	ID    int64       `json:"id"`
	Error panedErrObj `json:"error"`
}

type panedErrObj struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ── Connection handler ──────────────────────────────────────────────────

// panedOutQueue bounds the per-connection outbound buffer. Output pushes are
// dropped when it overflows (a slow/dead dongminal must never stall the daemon
// or other panes); responses/exit events block until enqueued (FR-11/FR-18).
const panedOutQueue = 1024

type panedConn struct {
	conn    net.Conn
	pm      *PaneManager
	encoder *json.Encoder
	stopped atomic.Bool

	// out is the single outbound queue drained by writeLoop. Centralizing all
	// socket writes through one goroutine serializes the json.Encoder (no race,
	// FR-11) and decouples each pane's readPTY goroutine from socket I/O so one
	// slow dongminal cannot block other panes or RPC responses (FR-18).
	out       chan interface{}
	done      chan struct{}
	doneOnce  sync.Once
	dropped   atomic.Int64
	writerEnd chan struct{}

	// wirePane is set by PanedServer to hook pane output/exit into this conn.
	wirePane func(p *Pane)
}

func newPanedConn(conn net.Conn, pm *PaneManager) *panedConn {
	pc := &panedConn{
		conn:      conn,
		pm:        pm,
		encoder:   json.NewEncoder(conn),
		out:       make(chan interface{}, panedOutQueue),
		done:      make(chan struct{}),
		writerEnd: make(chan struct{}),
	}
	go pc.writeLoop()
	return pc
}

// writeLoop is the sole writer to the socket. It exits on stop or write error.
func (pc *panedConn) writeLoop() {
	defer close(pc.writerEnd)
	for {
		select {
		case msg := <-pc.out:
			if err := pc.encoder.Encode(msg); err != nil {
				pc.stop()
				return
			}
		case <-pc.done:
			return
		}
	}
}

// stop marks the connection stopped, closes the socket, and signals writeLoop.
func (pc *panedConn) stop() {
	pc.doneOnce.Do(func() {
		pc.stopped.Store(true)
		close(pc.done)
		pc.conn.Close()
	})
}

// enqueue pushes a message onto the outbound queue. droppable messages
// (output) are discarded under backpressure; reliable messages (responses,
// exit) wait until space is available or the connection stops.
func (pc *panedConn) enqueue(v interface{}, droppable bool) {
	if pc.stopped.Load() {
		return
	}
	// Fallback for connections not started via newPanedConn (e.g. unit tests
	// that inspect encoder output synchronously): no writer goroutine exists,
	// so encode inline. Production always uses newPanedConn.
	if pc.out == nil {
		_ = pc.encoder.Encode(v)
		return
	}
	if droppable {
		select {
		case pc.out <- v:
		case <-pc.done:
		default:
			if n := pc.dropped.Add(1); n == 1 || n%256 == 0 {
				log.Printf("paned: output backpressure — dropped %d chunks (slow dongminal?)", n)
			}
		}
		return
	}
	select {
	case pc.out <- v:
	case <-pc.done:
	}
}

func (pc *panedConn) handle() error {
	defer pc.stop()
	dec := json.NewDecoder(pc.conn)
	for {
		var req panedRequest
		if err := dec.Decode(&req); err != nil {
			return err
		}
		if pc.stopped.Load() {
			return nil
		}
		pc.dispatch(&req)
	}
}

func (pc *panedConn) dispatch(req *panedRequest) {
	var resp interface{}
	switch req.Method {
	case "hello":
		resp = pc.hello(req)
	case "create":
		resp = pc.create(req)
	case "restore":
		resp = pc.restore(req)
	case "kill":
		resp = pc.kill(req)
	case "write":
		resp = pc.write(req)
	case "resize":
		resp = pc.resize(req)
	case "list":
		resp = pc.list(req)
	case "snapshot":
		resp = pc.snapshot(req)
	case "cwd":
		resp = pc.cwd(req)
	case "busy":
		resp = pc.busy(req)
	default:
		resp = panedError{ID: req.ID, Error: panedErrObj{Code: -32601, Message: "unknown method: " + req.Method}}
	}
	pc.enqueue(resp, false)
}

// ── Request handlers ────────────────────────────────────────────────────

func (pc *panedConn) hello(req *panedRequest) interface{} {
	panes := pc.pm.List()
	ids := make([]string, 0, len(panes))
	for _, m := range panes {
		ids = append(ids, m["id"].(string))
	}
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"version":  1,
		"pane_ids": ids,
	}}
}

func (pc *panedConn) create(req *panedRequest) interface{} {
	var p struct {
		Cwd  string `json:"cwd"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return panedError{ID: req.ID, Error: panedErrObj{Code: -32602, Message: err.Error()}}
	}
	pane, err := pc.pm.Create(p.Cwd, p.Cols, p.Rows)
	if err != nil {
		return panedError{ID: req.ID, Error: panedErrObj{Code: -32603, Message: err.Error()}}
	}
	if pc.wirePane != nil {
		pc.wirePane(pane)
	}
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"id": pane.ID, "name": pane.Name, "pid": pane.CmdProcessPID(),
		"cols": p.Cols, "rows": p.Rows,
	}}
}

func (pc *panedConn) restore(req *panedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Cwd  string `json:"cwd"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return panedError{ID: req.ID, Error: panedErrObj{Code: -32602, Message: err.Error()}}
	}
	if err := pc.pm.Restore(p.ID, p.Name, p.Cwd, p.Cols, p.Rows); err != nil {
		return panedError{ID: req.ID, Error: panedErrObj{Code: -32603, Message: err.Error()}}
	}
	if pc.wirePane != nil {
		if restored := pc.pm.Get(p.ID); restored != nil {
			pc.wirePane(restored)
		}
	}
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"id": p.ID, "cols": p.Cols, "rows": p.Rows,
	}}
}

func (pc *panedConn) kill(req *panedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(req.Params, &p)
	pc.pm.Delete(p.ID)
	return panedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) write(req *panedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Data string `json:"data"`
	}
	json.Unmarshal(req.Params, &p)
	raw, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return panedError{ID: req.ID, Error: panedErrObj{Code: -32602, Message: "invalid base64"}}
	}
	pc.pm.Write(p.ID, raw)
	return panedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) resize(req *panedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	json.Unmarshal(req.Params, &p)
	pc.pm.Resize(p.ID, p.Cols, p.Rows)
	return panedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) list(req *panedRequest) interface{} {
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"panes": pc.pm.List(),
	}}
}

func (pc *panedConn) snapshot(req *panedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(req.Params, &p)
	snap, _ := pc.pm.SnapshotPane(p.ID)
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"data":           base64.StdEncoding.EncodeToString(snap.Data),
		"totalBytesIn":   snap.TotalBytesIn,
		"totalBytesDrop": snap.TotalBytesDrop,
		"retained":       snap.Retained,
	}}
}

func (pc *panedConn) cwd(req *panedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(req.Params, &p)
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"cwd": pc.pm.Cwd(p.ID),
	}}
}

func (pc *panedConn) busy(req *panedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(req.Params, &p)
	return panedResponse{ID: req.ID, Result: map[string]interface{}{
		"busy": pc.pm.Busy(p.ID),
	}}
}

// ── Push events ────────────────────────────────────────────────────────

// pushExit notifies dongminal that a pane exited. code is currently always 0:
// the readPTY exit path does not capture the shell's real exit status, and the
// frontend only needs the exit signal (not the code) to tear down the pane.
func (pc *panedConn) pushExit(paneID string, code int) {
	pc.enqueue(map[string]interface{}{
		"event": "exit", "pane": paneID, "code": code,
	}, false)
}

func (pc *panedConn) pushOutputData(paneID string, data []byte) {
	pc.enqueue(map[string]interface{}{
		"event": "output", "pane": paneID,
		"data": base64.StdEncoding.EncodeToString(data),
	}, true)
}

// ── Unix socket server ──────────────────────────────────────────────────

type PanedServer struct {
	pm       *PaneManager
	sockPath string
	pidPath  string

	mu       sync.Mutex
	listener net.Listener
	currConn *panedConn
}

func NewPanedServer(pm *PaneManager, sockPath, pidPath string) *PanedServer {
	return &PanedServer{pm: pm, sockPath: sockPath, pidPath: pidPath}
}

func (ps *PanedServer) Listen() error {
	// Guard against clobbering a live daemon's socket (concurrent cold starts).
	// If the existing socket still answers, another dongminald owns it — abort
	// rather than removing it and stealing its panes. A stale socket (dial
	// fails) is safe to remove.
	if conn, err := net.Dial("unix", ps.sockPath); err == nil {
		conn.Close()
		return fmt.Errorf("paned: %s already served by a live daemon", ps.sockPath)
	}
	os.Remove(ps.sockPath)
	if err := os.MkdirAll(filepath.Dir(ps.sockPath), 0o755); err != nil {
		return err
	}
	ln, err := net.Listen("unix", ps.sockPath)
	if err != nil {
		return err
	}
	ps.listener = ln
	if ps.pidPath != "" {
		os.WriteFile(ps.pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644)
	}
	return nil
}

func (ps *PanedServer) Accept() error {
	conn, err := ps.listener.Accept()
	if err != nil {
		return err
	}

	ps.mu.Lock()
	// Close previous connection
	if ps.currConn != nil {
		ps.currConn.stop()
	}

	pc := newPanedConn(conn, ps.pm)

	// Wire output/exit from each pane through whichever dongminal connection
	// is current. The closures resolve ps.currConn dynamically, so a pane only
	// needs to be wired ONCE for its lifetime — reconnects reuse the same
	// closures and just swap currConn. `p.wired` guards against re-wiring
	// (which would nest exit handlers and re-trigger pushes). (FR-12)
	pc.wirePane = func(p *Pane) {
		if !p.wired.CompareAndSwap(false, true) {
			return
		}
		var baseExit func(string)
		if prev := p.relay.Load(); prev != nil {
			baseExit = prev.onExit
		}
		p.relay.Store(&paneRelay{
			onOutput: func(paneID string, data []byte) {
				ps.mu.Lock()
				c := ps.currConn
				ps.mu.Unlock()
				if c != nil {
					c.pushOutputData(paneID, data)
				}
			},
			onExit: func(paneID string) {
				ps.mu.Lock()
				c := ps.currConn
				ps.mu.Unlock()
				if c != nil {
					c.pushExit(paneID, 0)
				}
				if baseExit != nil {
					baseExit(paneID)
				}
			},
		})
	}
	for _, p := range ps.pm.Snapshot() {
		pc.wirePane(p)
	}
	ps.currConn = pc
	ps.mu.Unlock()

	return pc.handle()
}

func (ps *PanedServer) Close() error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.currConn != nil {
		ps.currConn.stop()
	}
	if ps.listener != nil {
		ps.listener.Close()
	}
	os.Remove(ps.sockPath)
	if ps.pidPath != "" {
		os.Remove(ps.pidPath)
	}
	return nil
}
