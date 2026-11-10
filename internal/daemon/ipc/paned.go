package ipc

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"errors"

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

	// toolQueue 는 paste 를 도구마다 도착 순서대로 세운다. 그 도구에 줄이 있는 동안은
	// write·input 도 뒤에 선다 (S6, I-68).
	toolQueue serialQueue

	// wireTool is set by PanedServer to hook tool output/exit into this conn.
	wireTool func(p *toolhub.Tool)

	// serverFeatures 는 이 연결의 서버가 hello 에서 말한 기능이다 (D-OPT-1). hello 는
	// 연결의 첫 요청이고, 뒤따르는 생존 확인 hello(FR-OPT-2-1)도 같은 값을 싣는다.
	// dispatch 는 읽기 루프 한 고루틴이 돌므로 잠금이 없다.
	serverFeatures []string

	// build 는 이 데몬 바이너리의 판이다 (VERSION_HEALTH_SRS FR-VHL-1). `hello`
	// 가 프로토콜 판과 **따로** 싣는다 — 서버가 둘을 다르게 다루기 때문이다
	// (프로토콜 불일치는 거부, 빌드 불일치는 기록).
	build string

	// records 는 데몬의 전역 에이전트 기록이다 (AGENT_RECORD_DAEMON_SRS FR-ARD-10).
	// PanedServer 가 연결마다 같은 것을 싣는다.
	records *globalRecords

	// reports 는 이 연결의 서버가 hello 에서 reports 기능을 말했는가다 (§3.2a). 보고
	// 소켓의 고루틴이 읽으므로 serverFeatures 와 따로 원자값으로 둔다.
	reports atomic.Bool

	// attention 은 이 연결의 서버가 attn push 를 아는가다 (AGENT_RECORD_DAEMON_SRS §3.3a).
	// 도구의 알림(readPTY·스위퍼·보고)이 읽으므로 원자값이다.
	attention atomic.Bool

	// srv 는 이 연결을 받은 서버다 — report 메서드가 보고 소켓과 같은 반영을 딛는다.
	srv *PanedServer
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
		// 짝지어지므로 순서가 바뀌어도 클라이언트는 제 응답을 찾는다. go 문의 인자는
		// 부르는 고루틴에서 먼저 평가되므로 terminate 를 클로저 안에서 부른다.
		go func() { pc.enqueue(pc.terminate(req), false) }()
		return
	case toolipc.MethodWrite:
		// 그 도구에 줄이 있으면 뒤에 선다 — 앞선 paste 의 글과 제출 사이에 끼지 않는다.
		if id := pc.toolOf(req); id != "" && pc.toolQueue.busy(id) {
			if pc.toolQueue.run(id, func() {
				if !pc.isDone() {
					pc.enqueue(pc.write(req), false)
				}
			}) {
				return
			}
			resp = errResp(req, toolipc.CodeServer, errToolQueueFull)
			break
		}
		resp = pc.write(req)
	case toolipc.MethodPaste:
		p, perr := decodeParams[toolipc.PasteParams](req)
		if perr != nil {
			resp = *perr
			break
		}
		// S6·I-68: paste 는 제출 틈(120ms)과 전경 조회를 기다린다. 읽기 루프에서 돌면
		// 그동안 이 연결의 다른 도구 입력·RPC 가 멈춘다. 그래서 도구별 줄에 도착 순서대로
		// 세운다 — 같은 도구의 paste·write·input 은 변경 전처럼 차례를 지킨다.
		if pc.toolQueue.run(p.ID, func() {
			if !pc.isDone() {
				pc.enqueue(pc.pasteWith(req, p), false)
			}
		}) {
			return
		}
		resp = errResp(req, toolipc.CodeServer, errToolQueueFull)
	case toolipc.MethodResize:
		resp = pc.resize(req)
	case toolipc.MethodInput:
		if id := pc.toolOf(req); id != "" && pc.toolQueue.busy(id) {
			// 줄이 넘치면 버린다 — 응답이 없는 요청이다.
			pc.toolQueue.run(id, func() {
				if !pc.isDone() {
					pc.input(req)
				}
			})
			return
		}
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
	case toolipc.MethodRecordSet:
		resp = pc.recordSet(req)
	case toolipc.MethodRecords:
		resp = pc.recordsSnapshot(req)
	case toolipc.MethodAttnConfig:
		resp = pc.attnConfig(req)
	case toolipc.MethodAttend:
		resp = pc.attend(req)
	case toolipc.MethodAttendAll:
		resp = okResp(req, toolipc.AttendAllResult{Cleared: pc.pm.ClearAllAttention()})
	case toolipc.MethodReport:
		resp = pc.report(req)
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

// serialQueueMax 는 한 도구의 줄에서 기다릴 수 있는 일의 수다.
const serialQueueMax = 256

var errToolQueueFull = errors.New("도구의 입력 줄이 가득 찼다")

// isDone 은 연결이 멈췄는가다. 줄에서 기다린 일은 시작 전에 본다.
func (pc *panedConn) isDone() bool {
	select {
	case <-pc.done:
		return true
	default:
		return false
	}
}

// serialQueue 는 키마다 일을 넣은 순서대로 하나씩 돌린다. 넣기는 부르는 쪽(읽기 루프)에서
// 동기로 일어나므로 도착 순서가 곧 실행 순서다. 일이 없는 키는 지운다.
type serialQueue struct {
	mu sync.Mutex
	q  map[string][]func()
}

// run 은 fn 을 key 의 줄 끝에 넣는다. 줄이 비어 있었으면 그 줄을 비울 고루틴을 띄운다.
// 기다리는 일이 serialQueueMax 개면 넣지 않고 거짓이다 — PTY 쓰기가 막힌 동안 읽기 루프가
// 메모리 줄만 키우지 않게 한다.
func (s *serialQueue) run(key string, fn func()) bool {
	s.mu.Lock()
	if s.q == nil {
		s.q = map[string][]func(){}
	}
	pending, busy := s.q[key]
	if len(pending) >= serialQueueMax {
		s.mu.Unlock()
		return false
	}
	s.q[key] = append(pending, fn)
	s.mu.Unlock()
	if !busy {
		go s.drain(key)
	}
	return true
}

// busy 는 key 의 줄에 도는 일이나 기다리는 일이 있는가다. 줄에 넣는 쪽이 읽기 루프
// 하나뿐이므로, 거짓을 본 뒤 제자리에서 돌려도 앞선 일을 앞지르지 않는다.
func (s *serialQueue) busy(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.q[key]
	return ok
}

func (s *serialQueue) drain(key string) {
	for {
		s.mu.Lock()
		fns := s.q[key]
		if len(fns) == 0 {
			delete(s.q, key)
			s.mu.Unlock()
			return
		}
		fn := fns[0]
		s.q[key] = fns[1:]
		s.mu.Unlock()
		fn()
	}
}

// toolOf 는 write·input 요청이 가리키는 도구다. 읽지 못하면 빈 값이다(처리기가 오류로 답한다).
func (pc *panedConn) toolOf(req *toolipc.PanedRequest) string {
	p, perr := decodeParams[toolipc.WriteParams](req)
	if perr != nil {
		return ""
	}
	return p.ID
}
