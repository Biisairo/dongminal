package ipc

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"fmt"
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

	// build 는 이 데몬 바이너리의 판이다 (VERSION_HEALTH_SRS FR-VHL-1). `hello`
	// 가 프로토콜 판과 **따로** 싣는다 — 서버가 둘을 다르게 다루기 때문이다
	// (프로토콜 불일치는 거부, 빌드 불일치는 기록).
	build string
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
				dmlog.Warnf(nil, "paned: output backpressure — dropped %d chunks (slow dongminal?)", n)
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
	case "paste":
		resp = pc.paste(req)
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
	// FR-VHL-1: 판을 **둘로 나눠** 싣는다.
	//
	//   version — 프로토콜(문법) 판. 호환의 판정자이며 거의 바뀌지 않는다
	//   build   — 이 바이너리의 판. 릴리스마다 바뀐다
	//
	// 합치면 모든 릴리스가 프로토콜 불일치로 읽힌다 (D-1). 서버는 둘을 다르게
	// 다룬다 — 프로토콜이 다르면 연결을 거부하고(FR-VHL-3), 빌드가 다르면
	// 연결은 두고 헬스에 싣는다(FR-VHL-4).
	return toolipc.PanedResponse{ID: req.ID, Result: map[string]interface{}{
		"version":  toolipc.ProtocolVersion,
		"build":    pc.build,
		"tool_ids": ids,
	}}
}

func (pc *panedConn) create(req *toolipc.PanedRequest) interface{} {
	var p struct {
		Cwd     string `json:"cwd"`
		Cols    uint16 `json:"cols"`
		Rows    uint16 `json:"rows"`
		Window  string `json:"window"`
		Profile string `json:"profile"`
		Command string `json:"command"`
		Work    string `json:"work"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	tool, err := pc.pm.Create(p.Cwd, p.Cols, p.Rows,
		toolhub.Placement{WindowUUID: p.Window, Profile: p.Profile, Command: p.Command, Work: p.Work})
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
	// `GO-8`: 없는 도구를 지운 것도 사실대로 답한다. 클라이언트가 그것을 정상으로
	// 볼지는 클라이언트가 정한다.
	if err := pc.pm.Delete(p.ID); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32000, Message: err.Error()}}
	}
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
	// `GO-8`: **반환값을 버리지 않는다.** 종전에는 없는 도구에 쓴 것도 성공으로
	// 답했고, 브라우저는 자기가 보낸 키가 들어간 줄 알았다.
	if err := pc.pm.Write(p.ID, raw); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32000, Message: err.Error()}}
	}
	return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
}

// paste 는 감싸기 판단까지 **데몬에서** 한다. 셸이 bracketed paste 모드를 켰는지는
// PTY 출력을 읽는 이쪽만 알고, 클라이언트의 Get(id) 은 cmd 없는 합성 Tool 을 주기
// 때문이다 (BRACKETED_PASTE_SRS FR-BPW-4). cwd·busy 가 데몬 RPC 를 경유하는 것과
// 같은 이유다.
func (pc *panedConn) paste(req *toolipc.PanedRequest) interface{} {
	var p struct {
		ID     string `json:"id"`
		Data   string `json:"data"`
		Submit bool   `json:"submit"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: err.Error()}}
	}
	raw, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32602, Message: "invalid base64"}}
	}
	if err := pc.pm.SendPaste(p.ID, raw, p.Submit); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32000, Message: err.Error()}}
	}
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
	// `GO-8`: 리사이즈도 같다 — 없는 도구의 크기를 바꿨다고 답하지 않는다.
	if err := pc.pm.Resize(p.ID, p.Cols, p.Rows); err != nil {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: -32000, Message: err.Error()}}
	}
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
	// buildVersion 은 `hello` 가 싣는 빌드 판이다 (FR-VHL-1). `mu` 아래 둔다 —
	// 연결 수락과 같은 잠금이다.
	buildVersion string

	mu       sync.Mutex
	listener net.Listener
	currConn *panedConn
}

// dialProbeTimeout 은 "이미 살아 있는 데몬이 있는가" 를 묻는 시도의 상한이다.
// 로컬 종단이므로 응답은 즉시 오거나 오지 않는다.
const dialProbeTimeout = 2 * time.Second

// SetBuildVersion 은 이 데몬의 빌드 판을 새긴다 (FR-VHL-1).
//
// 값을 **주입받는** 이유는 층 때문이다. 판의 단일 출처는 `internal/ctl/cli.Version`
// 이고(빌드 때 ldflags 로 새겨진다) 데몬 층이 그것을 import 하면 아래에서 위를
// 보게 된다. `boot.Run(home, version)` 이 이미 그 값을 들고 있으므로 여기까지
// 잇기만 하면 된다.
//
// 새기지 않으면 **빈 값**이다. 빈 것은 "모른다" 이지 불일치가 아니다 (FR-VHL-5).
func (ps *PanedServer) SetBuildVersion(v string) {
	ps.mu.Lock()
	ps.buildVersion = v
	ps.mu.Unlock()
}

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
	// 04-secops P1-6: 소켓이 사는 자리는 0700 이다.
	if err := os.MkdirAll(filepath.Dir(ps.sockPath), 0o700); err != nil {
		return err
	}
	ln, err := transport.Listen(ps.sockPath)
	if err != nil {
		return err
	}
	ps.listener = ln
	if ps.pidPath != "" {
		// `GO-36`: **반환값을 버리지 않는다.** pidfile 이 쓰이지 않으면 `stop` 이
		// 이 데몬을 찾지 못해 정지도 재접속도 못 하는 고아가 된다 — 그 사실이
		// 기록 없이 지나가면 원인을 찾을 수 없다. 기동을 막지는 않는다: 소켓은
		// 이미 열렸고, pidfile 은 편의이지 기동의 조건이 아니다.
		if err := os.WriteFile(ps.pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
			dmlog.Errorf(nil, "paned: pidfile 쓰기 실패 %s: %v", ps.pidPath, err)
		}
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
	// FR-VHL-1: 연결마다 빌드 판을 내린다.
	//
	// **여기서 다시 잠그지 마라** — 이 함수는 위에서 이미 `ps.mu` 를 쥐고 있고,
	// `sync.Mutex` 는 재진입이 아니다. 한 번 그렇게 걸었더니 hello 가 영영
	// 답하지 않았고, 증상은 "연결이 그냥 실패한다" 였다 (2026-09-11).
	pc.build = ps.buildVersion

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
