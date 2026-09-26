package toolclient

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// toolCallTimeout bounds a single RPC. On expiry the connection is
	// dropped and the supervisor reconnects (DAEMON_SPLIT_SRS FR-14).
	toolCallTimeout = 5 * time.Second

	// toolCreateTimeout 은 create 하나의 상한이다 (FR-OPT-2-3). 샌드박스 창의 도구는
	// 데몬이 컨테이너를 만들고 띄운 뒤에야 답하므로 기본 시한으로는 모자란다.
	toolCreateTimeout = 60 * time.Second

	// toolDialTimeout 은 데몬 종단에 붙는 시도의 상한이다. 로컬 종단이므로
	// 응답은 즉시 오거나 오지 않는다.
	toolDialTimeout = 2 * time.Second
	// toolMaxBackoff caps the reconnect backoff (FR-13).
	toolMaxBackoff = 30 * time.Second
	// toolRespawnEvery: respawn dongminald after this many consecutive
	// failed dials (socket gone → daemon likely dead).
	toolRespawnEvery = 3

	// toolHeartbeatEvery 는 생존 확인 hello 의 주기다 (FR-OPT-2-1). 정상 상태에는
	// 서버→데몬 RPC 가 없어 답하지 않는 데몬을 RPC 시한이 잡지 못한다.
	toolHeartbeatEvery = 15 * time.Second
)

// heartbeat 는 생존 확인의 주기와 시한이다. 배선은 toolHeartbeatEvery·
// toolCallTimeout 을 쓰고, 테스트가 줄인다.
type heartbeat struct {
	every, within time.Duration
}

// ToolClient is a dongminal-side client that connects to dongminald
// over a Unix socket and implements the toolhub.ToolHub interface via JSON-RPC
// style request/response (DAEMON_SPLIT_SRS Phase 3).
type ToolClient struct {
	sockPath    string
	spawnDaemon func() error // respawns dongminald on repeated dial failure; nil disables respawn
	beat        heartbeat

	mu       sync.Mutex
	conn     net.Conn
	enc      *json.Encoder
	pending  map[int64]chan rpcReply
	nextID   int64
	connDone chan struct{} // closed when the current connection dies

	// writeMu 는 소켓 쓰기만 지킨다 (IPC-22). 쓰기가 막혀도 mu 를 쥐지 않으므로
	// readLoop 의 응답 배달·콜백 읽기가 서지 않는다.
	writeMu sync.Mutex

	stopped   atomic.Bool
	closeOnce sync.Once
	// reconnects 는 연결을 되살린 횟수다 (OBSERVABILITY_SRS FR-OBS-12).
	reconnects atomic.Int64
	closed     chan struct{}

	// Push event callbacks — **셋 다 `mu` 아래**이고 setter 로만 걸린다 (M8
	// `GO-5`). readLoop 는 dial 이 돌아온 순간 이미 돌고 있고 데몬은 접속 직후
	// 값을 밀 수 있으므로, 배선이 끝나기 전에 readLoop 가 이 필드를 읽는 창이
	// 실재한다 (`go test -race` 3회 중 1회 관측, 2026-08-28 — 그때 fg 만 고쳤고
	// 나머지 둘은 문서화된 채 남아 있었다).
	//
	// onOutput 은 output 청크마다 readLoop 고루틴에서 한 번 돈다(주의·활동
	// 탐지, DAEMON_SPLIT_SRS §6.2) — WS 구독자와 독립이라 브라우저가 없어도
	// 탐지가 돌고 attnCarry 를 구독자 수만큼 겹쳐 세지 않는다.
	// onForeground 는 전경 프로세스 이름이 바뀔 때 온다 (CONVENIENCE_SRS
	// FR-TAN-9). 데몬은 변화만 밀므로 같은 값이 되풀이되지 않는다. nil 이면
	// 끈다 — 같은 이름이 List() 응답에도 실리므로 잃는 것은 없다.
	onOutput     func(toolID string, data []byte, end int64)
	onExit       func(toolID string, info toolhub.ExitInfo)
	onForeground func(toolID, name string)
	earlyPushes  []earlyPush

	// fgMu 는 onForeground 호출과 fgSeen·fgSeq 를 한 줄로 세운다. fgSeen 은 마지막으로
	// 알린 전경 이름과 그 push 의 순번이다 — 재접속 뒤 목록과 대조해 끊긴 동안 놓친
	// 변화만 메운다 (resyncAfterReconnect, FR-OPT-2-1).
	fgMu   sync.Mutex
	fgSeen map[string]fgSeen
	fgSeq  uint64

	// Per-tool WS subscribers: output channel → its exit-signal channel. The
	// exit channel is closed when the tool exits so the WS handler can send
	// toolhub.OpExit and tear down (parity with direct-mode tool.kill).
	subMu   sync.RWMutex
	subbers map[string]map[chan OutChunk]chan struct{}
	dropped atomic.Int64

	// listCache·listAt 은 마지막 list 응답과 그 시각이다 (`GO-6`, ListOK 참조).
	listMu    sync.Mutex
	listCache []toolhub.ToolInfo
	listAt    time.Time
	listGen   uint64

	// daemonInfo 는 마지막 hello 가 말한 판이다 (FR-VHL-2). 재연결마다 갱신되므로
	// `mu` 아래 둔다 — readLoop 와 같은 잠금이다.
	daemonInfo DaemonInfo
	// daemonFeatures 는 마지막 hello 에서 데몬이 말한 기능이다 (D-OPT-1). `mu` 아래.
	daemonFeatures []string
}

// rpcReply 는 readLoop 가 호출자에게 건네는 응답 하나다. 봉투는 readLoop 가 이미
// 해석했고 result 는 호출자가 자기 타입으로 한 번 읽는다.
type rpcReply struct {
	result json.RawMessage
	err    error
}

// DaemonInfo 는 toolhub.DaemonInfo 다 — 뜻은 그쪽 주석에 있다.
type DaemonInfo = toolhub.DaemonInfo

type fgSeen struct {
	name string
	seq  uint64
}

// earlyPush 는 배선 전에 도착한 exit 다 — exit 만 버퍼한다 (SetOnExit 참조).
type earlyPush struct {
	tool string
	info toolhub.ExitInfo
}

// SetOnOutput 은 output 콜백을 잠금 안에서 건다. 배선 전에 도착한 output 은
// 버리지 않고 **놓친다** — 화면은 다음 snapshot 이 메우고, 주의 탐지는 다음
// 청크에서 이어진다 (exit 와 달리 유실이 상태를 남기지 않는다).
func (pc *ToolClient) SetOnOutput(cb func(toolID string, data []byte, end int64)) {
	pc.mu.Lock()
	pc.onOutput = cb
	pc.mu.Unlock()
}

// SetOnExit 은 exit 콜백을 잠금 안에서 걸고, 배선 전에 도착해 버퍼된 exit 를
// **그 자리에서 재생**한다. exit 하나를 놓치면 죽은 도구의 활동·주의가 배지에
// 남으므로(FR-ATL-3) output 과 달리 버퍼가 있다.
//
// info 는 데몬이 `exit` push 에 실은 종료 코드다. stderr 사유는 싣지 않는다
// (OPTIMIZE_REFACTOR_SRS D-OPT-6 — 폐기).
func (pc *ToolClient) SetOnExit(cb func(toolID string, info toolhub.ExitInfo)) {
	pc.mu.Lock()
	pc.onExit = cb
	pushes := pc.earlyPushes
	pc.earlyPushes = nil
	pc.mu.Unlock()
	if cb == nil {
		return
	}
	for _, p := range pushes {
		cb(p.tool, p.info)
	}
}

// SetOnForeground 는 fg 콜백을 잠금 안에서 건다 (CONVENIENCE_SRS FR-TAN-9).
func (pc *ToolClient) SetOnForeground(cb func(toolID, name string)) {
	pc.mu.Lock()
	pc.onForeground = cb
	pc.mu.Unlock()
}

// DialToolClient connects to the dongminald Unix socket, sends hello, and
// returns a ready-to-use ToolClient with auto-reconnect (no daemon respawn).
func DialToolClient(sockPath string) (*ToolClient, error) {
	return DialToolClientWithReconnect(sockPath, nil)
}

// DialToolClientWithReconnect is DialToolClient plus a spawnDaemon callback the
// supervisor invokes to respawn dongminald when dials keep failing (FR-13).
func DialToolClientWithReconnect(sockPath string, spawnDaemon func() error) (*ToolClient, error) {
	return dialToolClient(sockPath, spawnDaemon, heartbeat{every: toolHeartbeatEvery, within: toolCallTimeout})
}

func dialToolClient(sockPath string, spawnDaemon func() error, beat heartbeat) (*ToolClient, error) {
	pc := &ToolClient{
		sockPath:    sockPath,
		spawnDaemon: spawnDaemon,
		beat:        beat,
		pending:     make(map[int64]chan rpcReply),
		closed:      make(chan struct{}),
		subbers:     map[string]map[chan OutChunk]chan struct{}{},
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
	conn, err := platform.Current().IPC.Dial(pc.sockPath, toolDialTimeout)
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

	// FR-VHL-2: **응답을 읽는다.** 종전에는 `_` 로 버렸고, 그래서 판이 무엇이든
	// 연결이 성립했다 — 낡은 데몬 위에 새 서버가 붙어도 아무도 몰랐다.
	// 서버가 아는 기능을 싣는다 (D-OPT-1). 옛 데몬은 hello 의 params 를 읽지 않는다.
	res, err := callT[helloReply](pc, toolipc.MethodHello, toolipc.HelloParams{Features: toolipc.ServerFeatures})
	if err != nil {
		conn.Close()
		return fmt.Errorf("hello: %w", err)
	}
	info := parseHello(res)
	// FR-VHL-3: **프로토콜이 다르면 거부한다.** 문법이 다른 상대와 말을 이어 가면
	// 실패가 엉뚱한 자리에서 난다 — 도구 생성이나 리사이즈에서 터지고, 그때
	// 원인은 여기에 있다.
	//
	// 빌드 불일치로는 끊지 않는다 (FR-VHL-4) — 끊는 비용이 사용자의 PTY 다.
	if info.Protocol != toolipc.ProtocolVersion {
		conn.Close()
		return fmt.Errorf("hello: protocol mismatch: daemon=%d server=%d",
			info.Protocol, toolipc.ProtocolVersion)
	}
	pc.mu.Lock()
	pc.daemonInfo = info
	pc.daemonFeatures = res.Features
	pc.mu.Unlock()
	return nil
}

// parseHello 는 hello 결과에서 판 둘을 꺼낸다.
//
// **말하지 않은 것은 지어내지 않는다** (FR-VHL-5). 판 키가 없는 옛 데몬은
// 프로토콜을 현재 판으로 읽고 빌드는 비운다 — 빈 빌드는 불일치가 아니다.
func parseHello(res helloReply) DaemonInfo {
	info := DaemonInfo{Protocol: toolipc.ProtocolVersion, Build: res.Build}
	if res.Version != nil {
		info.Protocol = *res.Version
	}
	return info
}

// helloReply 는 toolipc.HelloResult 를 받는 쪽의 모양이다 — version 이 **없는 것**과
// 0 인 것을 가르려고 포인터다.
type helloReply struct {
	Build    string   `json:"build"`
	Features []string `json:"features"`
	Version  *int     `json:"version"`
}

// HasFeature 는 지금 연결된 데몬이 name 기능을 말했는가다 (D-OPT-1). 말하지 않은
// 옛 데몬에는 그 기능을 쓰지 않고 종전 방식으로 강등한다.
func (pc *ToolClient) HasFeature(name string) bool {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	return toolipc.HasFeature(pc.daemonFeatures, name)
}

// DaemonInfo 는 마지막 hello 가 말한 데몬의 판이다 (FR-VHL-2).
func (pc *ToolClient) DaemonInfo() DaemonInfo {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	return pc.daemonInfo
}

// supervise watches for connection loss and reconnects with exponential
// backoff, respawning dongminald when dials keep failing (FR-13).
func (pc *ToolClient) supervise() {
	beat := time.NewTicker(pc.beat.every)
	defer beat.Stop()
	for {
		pc.mu.Lock()
		cd := pc.connDone
		pc.mu.Unlock()
	alive:
		for {
			select {
			case <-pc.closed:
				return
			case <-cd:
				break alive
			case <-beat.C:
				pc.ping()
			}
		}
		if pc.stopped.Load() {
			return
		}
		dmlog.Warnf(nil, "toolclient: connection lost, reconnecting...")
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
				pc.reconnects.Add(1)
				dmlog.Infof(nil, "toolclient: reconnected")
				pc.resyncAfterReconnect()
				break
			}
			fails++
			if pc.spawnDaemon != nil && fails%toolRespawnEvery == 0 {
				dmlog.Errorf(nil, "toolclient: respawning dongminald after %d failed dials", fails)
				_ = pc.spawnDaemon()
			}
			if backoff < toolMaxBackoff {
				backoff *= 2
				if backoff > toolMaxBackoff {
					backoff = toolMaxBackoff
				}
			}
		}
	}
}

// ping 은 생존 확인이다 (FR-OPT-2-1). 시한 안에 답이 없으면 callWithin 이 연결을
// 끊고 supervisor 가 재접속한다. hello 는 모든 판의 데몬이 받는다. 인자는 접속 때와
// 같다 — 데몬은 hello 마다 서버의 기능을 다시 적는다.
//
// 진행 중인 호출이 있으면 건너뛴다 — 그 호출이 자기 시한으로 무응답을 잡는다. 옛
// 데몬은 create 를 읽기 루프 안에서 돌리므로 그동안 hello 에도 답하지 않는다.
func (pc *ToolClient) ping() {
	pc.mu.Lock()
	busy := len(pc.pending) > 0
	pc.mu.Unlock()
	if busy {
		return
	}
	_, _ = pc.callWithin(toolipc.MethodHello, toolipc.HelloParams{Features: toolipc.ServerFeatures}, pc.beat.within)
}

// resyncAfterReconnect 는 끊긴 동안 놓친 push 를 메운다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-1-2). 공백 중 끝난 도구의 exit 는 오지 않았고, 살아 있는 도구의 출력에는
// 구멍이 났다.
//
// 재접속 뒤의 목록과 대조해 사라진 도구(구독한 것과 직전 목록에 있던 것)는 exitCh 를
// 닫고 onExit 를 합성한다. 살아 있는 구독은 출력 채널을 닫아 끊는다 — 릴레이가 exit
// 없이 소켓을 닫고 브라우저가 since 로 재동기한다. 목록을 모르면(list 실패) 죽었다고
// 판정하지 않고 전부 재동기로 돌린다 — 재접속한 브라우저의 snapshot 이 판정한다.
func (pc *ToolClient) resyncAfterReconnect() {
	pc.listMu.Lock()
	known := map[string]struct{}{}
	for _, t := range pc.listCache {
		known[t.ID] = struct{}{}
	}
	pc.listMu.Unlock()
	pc.invalidateList()
	pc.fgMu.Lock()
	fgFrom := pc.fgSeq
	pc.fgMu.Unlock()
	tools, ok := pc.ListOK()
	alive := make(map[string]struct{}, len(tools))
	for _, t := range tools {
		alive[t.ID] = struct{}{}
	}

	pc.subMu.Lock()
	subs := pc.subbers
	pc.subbers = map[string]map[chan OutChunk]chan struct{}{}
	pc.subMu.Unlock()
	for id, m := range subs {
		_, live := alive[id]
		for ch, exitCh := range m {
			if ok && !live {
				close(exitCh)
			} else {
				close(ch)
			}
		}
		known[id] = struct{}{}
	}
	if !ok {
		return
	}
	pc.resyncForeground(tools, fgFrom)
	pc.mu.Lock()
	onExit := pc.onExit
	pc.mu.Unlock()
	if onExit == nil {
		return
	}
	for id := range known {
		if _, live := alive[id]; !live {
			onExit(id, toolhub.ExitInfo{})
		}
	}
}

// resyncForeground 는 끊긴 동안 바뀐 전경 이름을 알린다. 데몬은 그 사이의 변화를
// 받을 연결이 없어 버렸고, 다음 변화 전에는 다시 밀지 않는다 (FR-OPT-2-1). 목록을
// 묻기 시작한 뒤(fgFrom 이후) push 로 온 도구는 그 값이 더 새것이므로 건너뛴다.
func (pc *ToolClient) resyncForeground(tools []toolhub.ToolInfo, fgFrom uint64) {
	pc.mu.Lock()
	cb := pc.onForeground
	pc.mu.Unlock()
	pc.fgMu.Lock()
	defer pc.fgMu.Unlock()
	seen := make(map[string]fgSeen, len(tools))
	for _, t := range tools {
		e := pc.fgSeen[t.ID]
		if e.seq <= fgFrom && e.name != t.FgName {
			e.name = t.FgName
			if cb != nil {
				cb(t.ID, t.FgName)
			}
		}
		seen[t.ID] = e
	}
	pc.fgSeen = seen
}

// wireMsg 는 데몬이 보내는 줄 하나의 모든 모양이다 — 응답(id·result·error)과
// push(event 와 그 필드). 한 번의 Decode 로 끝낸다 (IPC-13). 종전에는 RawMessage 로
// 받고, 구분하려고 한 번, 처리하려고 또 한 번 해석한 뒤 base64 를 따로 풀었다.
// []byte 필드는 encoding/json 이 표준 base64 로 푼다.
type wireMsg struct {
	ID     *int64               `json:"id"`
	Result json.RawMessage      `json:"result"`
	Error  *toolipc.PanedErrObj `json:"error"`

	Event string `json:"event"`
	Tool  string `json:"tool"`
	Data  []byte `json:"data"`
	End   int64  `json:"end"`
	Code  int    `json:"code"`
	Cols  uint16 `json:"cols"`
	Rows  uint16 `json:"rows"`
	Name  string `json:"name"`
}

// readLoop decodes responses and push events for a single connection. On
// connection death it signals connLost so the supervisor can reconnect.
func (pc *ToolClient) readLoop(conn net.Conn, cd chan struct{}) {
	dec := json.NewDecoder(conn)
	for {
		// 줄마다 새 값이다 — Result 는 RawMessage 라 재사용하면 앞 응답의 바이트를
		// 덮는다.
		var m wireMsg
		err := dec.Decode(&m)
		if err != nil && !isValueError(err) {
			if !pc.stopped.Load() {
				dmlog.Infof(nil, "toolclient read: %v", err)
			}
			break
		}
		if m.Event != "" {
			if err == nil {
				pc.handlePush(&m)
			}
			// 해석 못 한 push 는 버린다 — 종전에도 그 push 만 버려졌다.
			continue
		}
		if m.ID != nil {
			pc.handleResponse(*m.ID, &m, err)
		}
	}
	pc.connLost(cd)
}

// isValueError 는 줄 하나의 **값**이 틀렸을 뿐 스트림은 온전한 오류인가다. 그때
// Decoder 는 그 줄을 이미 다 읽었으므로 다음 줄로 넘어갈 수 있다. 문법 오류·I/O
// 오류는 스트림이 깨진 것이다.
func isValueError(err error) bool {
	var typ *json.UnmarshalTypeError
	var b64 base64.CorruptInputError
	return errors.As(err, &typ) || errors.As(err, &b64)
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
	pc.pending = make(map[int64]chan rpcReply)
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

// handleResponse delivers a response to the waiting caller. decodeErr 는 봉투를
// 해석하지 못한 사정이다 — 호출자는 시한까지 매달리지 않고 그것을 받는다.
func (pc *ToolClient) handleResponse(id int64, m *wireMsg, decodeErr error) {
	pc.mu.Lock()
	ch := pc.pending[id]
	delete(pc.pending, id)
	pc.mu.Unlock()
	if ch == nil {
		return
	}
	r := rpcReply{result: m.Result, err: decodeErr}
	if r.err == nil && m.Error != nil {
		r.err = &toolipc.RPCError{Code: m.Error.Code, Message: m.Error.Message}
	}
	ch <- r
}

// outRequest 는 보내는 요청이다. params 를 따로 Marshal 해 RawMessage 로 싣지
// 않는다 — Encode 가 한 번에 부호화하고, 실패하면 아무것도 쓰지 않는다.
type outRequest struct {
	ID     int64  `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

// notifyRequest 는 응답 없는 알림이다 (FR-OPT-2-2). id 가 없다 — 데몬은 답하지 않고
// 이쪽은 기다릴 자리(pending)를 만들지 않는다.
type notifyRequest struct {
	Method string `json:"method"`
	Params any    `json:"params"`
}

// notify 는 알림 한 줄을 쓴다. 실패는 버린다 — 쓰기 실패는 readLoop 가 연결의 끝으로
// 보고 재접속이 잇는다. 알림을 쓰는 자리(WS 중계)는 종전에도 결과를 버렸다.
func (pc *ToolClient) notify(method string, params any) {
	pc.mu.Lock()
	enc := pc.enc
	pc.mu.Unlock()
	if enc == nil {
		return
	}
	pc.writeMu.Lock()
	_ = enc.Encode(notifyRequest{Method: method, Params: params})
	pc.writeMu.Unlock()
}

// call sends a request and blocks until the response arrives, the connection
// is lost, the call times out (FR-14), or the client closes.
func (pc *ToolClient) call(method string, params any) (json.RawMessage, error) {
	return pc.callWithin(method, params, toolCallTimeout)
}

// callT 는 call 의 결과를 R 로 한 번 읽는다 (FR-OPT-2-6). 결과가 없거나 null 이면
// R 의 제로값이다 — 필드를 모르는 옛 데몬과 같은 뜻이다.
func callT[R any](pc *ToolClient, method string, params any) (R, error) {
	return callWithinT[R](pc, method, params, toolCallTimeout)
}

func callWithinT[R any](pc *ToolClient, method string, params any, within time.Duration) (R, error) {
	var r R
	raw, err := pc.callWithin(method, params, within)
	if err != nil || len(raw) == 0 {
		return r, err
	}
	err = json.Unmarshal(raw, &r)
	return r, err
}

// callWithin 은 시한을 따로 받는 call 이다 — 데몬 쪽에서 유예를 기다리는
// `terminate` 처럼 기본 시한보다 오래 걸리는 것이 정상인 호출의 자리.
func (pc *ToolClient) callWithin(method string, params any, within time.Duration) (json.RawMessage, error) {
	pc.mu.Lock()
	if pc.enc == nil {
		pc.mu.Unlock()
		return nil, fmt.Errorf("toolclient not connected")
	}
	id := pc.nextID
	pc.nextID++
	ch := make(chan rpcReply, 1)
	pc.pending[id] = ch
	cd := pc.connDone
	enc := pc.enc
	pc.mu.Unlock()

	pc.writeMu.Lock()
	err := enc.Encode(outRequest{ID: id, Method: method, Params: params})
	pc.writeMu.Unlock()
	if err != nil {
		// 부호화 실패(IPC-22)든 쓰기 실패든 호출자에게 돌려준다. 종전에는 Marshal
		// 오류를 버려 params 가 null 로 나갔다.
		pc.mu.Lock()
		delete(pc.pending, id)
		pc.mu.Unlock()
		return nil, err
	}

	// 호출마다 타이머를 만들고 **돌아갈 때 멈춘다** (M8 `GO-35`). time.After 는
	// 시한이 다 될 때까지 회수되지 않아 고빈도 list 에서 5초짜리 타이머가 쌓였다.
	timeout := time.NewTimer(within)
	defer timeout.Stop()
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("paned connection lost")
		}
		// 성공과 오류는 readLoop 가 **한 번에** 갈랐다 (M8 D-A-16). 오류 응답도
		// `id` 를 가지므로, 성공으로 먼저 읽으면 오류가 "결과 없음" 으로 뭉개진다.
		return r.result, r.err
	case <-cd:
		return nil, fmt.Errorf("paned connection lost")
	case <-timeout.C:
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
