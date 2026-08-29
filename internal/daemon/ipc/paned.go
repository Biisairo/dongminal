package ipc

import (
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

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
	"time"
)

// ── Connection handler ──────────────────────────────────────────────────

// panedOutQueue bounds the per-connection outbound buffer. Output pushes are
// dropped when it overflows (a slow/dead dongminal must never stall the daemon
// or other tools); responses/exit events block until enqueued (FR-11/FR-18).
const panedOutQueue = 1024

type panedConn struct {
	conn    net.Conn
	pm      *toolhub.ToolManager
	encoder *json.Encoder
	stopped atomic.Bool

	// out is the single outbound queue drained by writeLoop. Centralizing all
	// socket writes through one goroutine serializes the json.Encoder (no race,
	// FR-11) and decouples each tool's readPTY goroutine from socket I/O so one
	// slow dongminal cannot block other tools or RPC responses (FR-18).
	out       chan interface{}
	done      chan struct{}
	doneOnce  sync.Once
	dropped   atomic.Int64
	writerEnd chan struct{}

	// wireTool is set by PanedServer to hook tool output/exit into this conn.
	wireTool func(p *toolhub.Tool)
}

func newPanedConn(conn net.Conn, pm *toolhub.ToolManager) *panedConn {
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
		var req toolipc.PanedRequest
		if err := dec.Decode(&req); err != nil {
			return err
		}
		if pc.stopped.Load() {
			return nil
		}
		pc.dispatch(&req)
	}
}

func (pc *panedConn) dispatch(req *toolipc.PanedRequest) {
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
	case "setbackground":
		resp = pc.setBackground(req)
	case "backgroundlist":
		resp = pc.backgroundList(req)
	default:
		resp = toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32601, Message: "unknown method: " + req.Method}}
	}
	pc.enqueue(resp, false)
}

// ── Request handlers ────────────────────────────────────────────────────

func (pc *panedConn) hello(req *toolipc.PanedRequest) interface{} {
	tools := pc.pm.List()
	ids := make([]string, 0, len(tools))
	for _, m := range tools {
		if id, ok := m["id"].(string); ok {
			ids = append(ids, id)
		}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"version":  1,
		"tool_ids": ids,
	}}
}

func (pc *panedConn) create(req *toolipc.PanedRequest) interface{} {
	var p struct {
		Cwd  string `json:"cwd"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	tool, err := pc.pm.Create(p.Cwd, p.Cols, p.Rows)
	if err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32603, Message: err.Error()}}
	}
	if pc.wireTool != nil {
		pc.wireTool(tool)
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"id": tool.ID, "name": tool.Name, "pid": tool.CmdProcessPID(),
		"cols": p.Cols, "rows": p.Rows,
	}}
}

func (pc *panedConn) restore(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Cwd  string `json:"cwd"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	if err := pc.pm.Restore(p.ID, p.Name, p.Cwd, p.Cols, p.Rows); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32603, Message: err.Error()}}
	}
	if pc.wireTool != nil {
		if restored := pc.pm.Get(p.ID); restored != nil {
			pc.wireTool(restored)
		}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"id": p.ID, "cols": p.Cols, "rows": p.Rows,
	}}
}

func (pc *panedConn) kill(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	pc.pm.Delete(p.ID)
	return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) write(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	raw, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: "invalid base64"}}
	}
	pc.pm.Write(p.ID, raw)
	return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) resize(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID   string `json:"id"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	pc.pm.Resize(p.ID, p.Cols, p.Rows)
	return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
}

func (pc *panedConn) list(req *toolipc.PanedRequest) interface{} {
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"tools": pc.pm.List(),
	}}
}

func (pc *panedConn) snapshot(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	snap, err := pc.pm.SnapshotTool(p.ID)
	if err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32603, Message: err.Error()}}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"data":           base64.StdEncoding.EncodeToString(snap.Data),
		"totalBytesIn":   snap.TotalBytesIn,
		"totalBytesDrop": snap.TotalBytesDrop,
		"retained":       snap.Retained,
	}}
}

func (pc *panedConn) cwd(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"cwd": pc.pm.Cwd(p.ID),
	}}
}

func (pc *panedConn) busy(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"busy": pc.pm.Busy(p.ID),
	}}
}

func (pc *panedConn) setBackground(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID         string `json:"id"`
		Background bool   `json:"background"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"ok": pc.pm.SetBackground(p.ID, p.Background),
	}}
}

func (pc *panedConn) backgroundList(req *toolipc.PanedRequest) interface{} {
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"background": pc.pm.BackgroundList(),
	}}
}

// ── Push events ────────────────────────────────────────────────────────

// pushExit notifies dongminal that a tool exited. code is currently always 0:
// the readPTY exit path does not capture the shell's real exit status, and the
// frontend only needs the exit signal (not the code) to tear down the tool.
func (pc *panedConn) pushExit(toolID string, code int) {
	pc.enqueue(map[string]interface{}{
		"event": "exit", "tool": toolID, "code": code,
	}, false)
}

// pushForeground notifies dongminal that a tool's foreground process name
// changed (FR-TAN-9). Droppable: the same value also rides in every `list`
// response, so a push lost to backpressure self-heals on the next poll — and
// a name update must never stall the daemon.
func (pc *panedConn) pushForeground(toolID, name string) {
	pc.enqueue(map[string]interface{}{
		"event": "fg", "tool": toolID, "name": name,
	}, true)
}

func (pc *panedConn) pushOutputData(toolID string, data []byte) {
	pc.enqueue(map[string]interface{}{
		"event": "output", "tool": toolID,
		"data": base64.StdEncoding.EncodeToString(data),
	}, true)
}

// ── Unix socket server ──────────────────────────────────────────────────

type PanedServer struct {
	pm       *toolhub.ToolManager
	sockPath string
	pidPath  string

	mu       sync.Mutex
	listener net.Listener
	currConn *panedConn
}

// dialProbeTimeout 은 "이미 살아 있는 데몬이 있는가" 를 묻는 시도의 상한이다.
// 로컬 종단이므로 응답은 즉시 오거나 오지 않는다.
const dialProbeTimeout = 2 * time.Second

func NewPanedServer(pm *toolhub.ToolManager, sockPath, pidPath string) *PanedServer {
	ps := &PanedServer{pm: pm, sockPath: sockPath, pidPath: pidPath}
	// PTY 를 소유한 것은 데몬이므로 전경 조회도 여기서 일어난다 (FR-TAN-7).
	// 값은 list 응답에도 실리고, 바뀐 순간에는 이 push 로도 나간다 — 어느
	// 연결이 현재인지는 wireTool 과 같이 호출 시점에 푼다.
	pm.SetForegroundNotifier(func(toolID, name string) {
		ps.mu.Lock()
		c := ps.currConn
		ps.mu.Unlock()
		if c != nil {
			c.pushForeground(toolID, name)
		}
	})
	return ps
}

func (ps *PanedServer) Listen() error {
	// Guard against clobbering a live daemon's socket (concurrent cold starts).
	// If the existing socket still answers, another dongminald owns it — abort
	// rather than removing it and stealing its tools. A stale socket (dial
	// fails) is safe to remove.
	transport := platform.Current().IPC
	if conn, err := transport.Dial(ps.sockPath, dialProbeTimeout); err == nil {
		conn.Close()
		return fmt.Errorf("paned: %s already served by a live daemon", ps.sockPath)
	}
	transport.Remove(ps.sockPath)
	if err := os.MkdirAll(filepath.Dir(ps.sockPath), 0o755); err != nil {
		return err
	}
	ln, err := transport.Listen(ps.sockPath)
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

	// Wire output/exit from each tool through whichever dongminal connection
	// is current. The closures resolve ps.currConn dynamically, so a tool only
	// needs to be wired ONCE for its lifetime — reconnects reuse the same
	// closures and just swap currConn. `p.wired` guards against re-wiring
	// (which would nest exit handlers and re-trigger pushes). (FR-12)
	pc.wireTool = func(p *toolhub.Tool) {
		p.WireRelayOnce(func(baseExit func(string)) (func(string, []byte), func(string)) {
			return func(toolID string, data []byte) {
					ps.mu.Lock()
					c := ps.currConn
					ps.mu.Unlock()
					if c != nil {
						c.pushOutputData(toolID, data)
					}
				}, func(toolID string) {
					ps.mu.Lock()
					c := ps.currConn
					ps.mu.Unlock()
					if c != nil {
						c.pushExit(toolID, 0)
					}
					if baseExit != nil {
						baseExit(toolID)
					}
				}
		})
	}
	for _, p := range ps.pm.Snapshot() {
		pc.wireTool(p)
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
	platform.Current().IPC.Remove(ps.sockPath)
	if ps.pidPath != "" {
		os.Remove(ps.pidPath)
	}
	return nil
}
