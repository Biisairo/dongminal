package ipc

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/json"
	"net"
	"sync"
	"sync/atomic"
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
	case "terminate":
		// 유예를 기다리는 동안 이 연결의 다른 요청을 막지 않는다 — 응답은 id 로
		// 짝지어지므로 순서가 바뀌어도 클라이언트는 제 응답을 찾는다.
		go pc.enqueue(pc.terminate(req), false)
		return
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
		resp = toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeMethodNotFound, Message: "unknown method: " + req.Method}}
	}
	pc.enqueue(resp, false)
}
