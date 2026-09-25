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

// panedSlowMax 는 한 연결에서 읽기 루프 밖으로 뗀 create·restore 가 동시에 도는
// 상한이다 (FR-OPT-2-3). 샌드박스 배치는 컨테이너를 만들며 수 초를 쓴다.
const panedSlowMax = 4

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

	// slow 는 create·restore 의 연결당 세마포어다 (panedSlowMax).
	slow chan struct{}

	// wireTool is set by PanedServer to hook tool output/exit into this conn.
	wireTool func(p *toolhub.Tool)

	// serverFeatures 는 이 연결의 서버가 hello 에서 말한 기능이다 (D-OPT-1). hello 는
	// 연결의 첫 요청이고 dispatch 는 읽기 루프 한 고루틴이 돌므로 잠금이 없다.
	serverFeatures []string

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
		slow:      make(chan struct{}, panedSlowMax),
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
	case toolipc.MethodHello:
		resp = pc.hello(req)
	case toolipc.MethodCreate:
		// 배치(컨테이너 생성)가 이 연결의 입력·목록을 막지 않는다 (FR-OPT-2-3). 아직
		// id 가 없는 도구라 같은 도구의 write 와 순서가 얽히지 않는다.
		pc.goSlow(func() interface{} { return pc.create(req) })
		return
	case toolipc.MethodRestore:
		pc.goSlow(func() interface{} { return pc.restore(req) })
		return
	case toolipc.MethodKill:
		resp = pc.kill(req)
	case toolipc.MethodTerminate:
		// 유예를 기다리는 동안 이 연결의 다른 요청을 막지 않는다 — 응답은 id 로
		// 짝지어지므로 순서가 바뀌어도 클라이언트는 제 응답을 찾는다.
		go pc.enqueue(pc.terminate(req), false)
		return
	case toolipc.MethodWrite:
		resp = pc.write(req)
	case toolipc.MethodPaste:
		resp = pc.paste(req)
	case toolipc.MethodResize:
		resp = pc.resize(req)
	case toolipc.MethodInput:
		pc.input(req)
		return
	case toolipc.MethodResizeNotify:
		pc.resizeNotify(req)
		return
	case toolipc.MethodList:
		resp = pc.list(req)
	case toolipc.MethodSnapshot:
		resp = pc.snapshot(req)
	case toolipc.MethodCwd:
		resp = pc.cwd(req)
	case toolipc.MethodBusy:
		resp = pc.busy(req)
	case toolipc.MethodBusyMany:
		resp = pc.busyMany(req)
	case toolipc.MethodSetBackground:
		resp = pc.setBackground(req)
	case toolipc.MethodBackgroundList:
		resp = pc.backgroundList(req)
	default:
		resp = toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeMethodNotFound, Message: "unknown method: " + req.Method}}
	}
	pc.enqueue(resp, false)
}

// goSlow 는 fn 을 읽기 루프 밖에서 돌리고 그 응답을 enqueue 한다. 동시 수는 slow 가
// 묶는다. 자리를 기다리는 동안 연결이 멈추면 시작하지 않는다 — 받을 쪽이 없는 도구를
// 만들지 않는다. newPanedConn 을 거치지 않은 연결(slow 가 nil 인 단위 테스트)은
// enqueue 와 같이 제자리에서 돈다.
func (pc *panedConn) goSlow(fn func() interface{}) {
	if pc.slow == nil {
		pc.enqueue(fn(), false)
		return
	}
	go func() {
		select {
		case pc.slow <- struct{}{}:
		case <-pc.done:
			return
		}
		defer func() { <-pc.slow }()
		pc.enqueue(fn(), false)
	}()
}

// serverHas 는 이 연결의 서버가 name 기능을 말했는가다 (D-OPT-1).
func (pc *panedConn) serverHas(name string) bool {
	return toolipc.HasFeature(pc.serverFeatures, name)
}
