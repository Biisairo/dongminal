package toolclient

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/json"
	"fmt"
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

	// panedDialTimeout 은 데몬 종단에 붙는 시도의 상한이다. 로컬 종단이므로
	// 응답은 즉시 오거나 오지 않는다.
	panedDialTimeout = 2 * time.Second
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
	onOutput     func(toolID string, kind toolhub.ToolKind, data []byte, end int64)
	onExit       func(toolID string, info toolhub.ExitInfo)
	onForeground func(toolID, name string)
	earlyPushes  []earlyPush

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
}

// DaemonInfo 는 toolhub.DaemonInfo 다 — 뜻은 그쪽 주석에 있다.
type DaemonInfo = toolhub.DaemonInfo

// earlyPush 는 배선 전에 도착한 exit 다 — exit 만 버퍼한다 (SetOnExit 참조).
type earlyPush struct {
	tool string
	info toolhub.ExitInfo
}

// SetOnOutput 은 output 콜백을 잠금 안에서 건다. 배선 전에 도착한 output 은
// 버리지 않고 **놓친다** — 화면은 다음 snapshot 이 메우고, 주의 탐지는 다음
// 청크에서 이어진다 (exit 와 달리 유실이 상태를 남기지 않는다).
func (pc *ToolClient) SetOnOutput(cb func(toolID string, kind toolhub.ToolKind, data []byte, end int64)) {
	pc.mu.Lock()
	pc.onOutput = cb
	pc.mu.Unlock()
}

// SetOnExit 은 exit 콜백을 잠금 안에서 걸고, 배선 전에 도착해 버퍼된 exit 를
// **그 자리에서 재생**한다. exit 하나를 놓치면 죽은 도구의 활동·주의가 배지에
// 남으므로(FR-ATL-3) output 과 달리 버퍼가 있다.
//
// info 는 데몬이 `exit` push 에 실은 종료 코드와 stderr 꼬리다 (M8_UNIFIED_SRS D-C-15).
// 옛 데몬은 `code:0` 만 보낸다 — 그때 사유는 비어 온다.
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
	conn, err := platform.Current().IPC.Dial(pc.sockPath, panedDialTimeout)
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
	res, err := pc.call("hello", map[string]interface{}{"server_pid": 0})
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
	pc.mu.Unlock()
	return nil
}

// parseHello 는 hello 결과에서 판 둘을 꺼낸다.
//
// **말하지 않은 것은 지어내지 않는다** (FR-VHL-5). 판 키가 없는 옛 데몬은
// 프로토콜을 현재 판으로 읽고 빌드는 비운다 — 빈 빌드는 불일치가 아니다.
func parseHello(res map[string]interface{}) DaemonInfo {
	info := DaemonInfo{Protocol: toolipc.ProtocolVersion}
	if v, ok := res["version"].(float64); ok {
		info.Protocol = int(v)
	}
	if b, ok := res["build"].(string); ok {
		info.Build = b
	}
	return info
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
				break
			}
			fails++
			if pc.spawnDaemon != nil && fails%panedRespawnEvery == 0 {
				dmlog.Errorf(nil, "toolclient: respawning dongminald after %d failed dials", fails)
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
				dmlog.Infof(nil, "toolclient read: %v", err)
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
// and to the global OnOutput/OnExit callbacks. 이벤트마다 메서드 하나다
// (M8 GO-21) — 모르는 이벤트는 버린다.
// is lost, the call times out (FR-14), or the client closes.
func (pc *ToolClient) call(method string, params interface{}) (map[string]interface{}, error) {
	return pc.callWithin(method, params, panedCallTimeout)
}

// callWithin 은 시한을 따로 받는 call 이다 — 데몬 쪽에서 유예를 기다리는
// `terminate` 처럼 기본 시한보다 오래 걸리는 것이 정상인 호출의 자리.
func (pc *ToolClient) callWithin(method string, params interface{}, within time.Duration) (map[string]interface{}, error) {
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

	// 호출마다 타이머를 만들고 **돌아갈 때 멈춘다** (M8 `GO-35`). time.After 는
	// 시한이 다 될 때까지 회수되지 않아 고빈도 list 에서 5초짜리 타이머가 쌓였다.
	timeout := time.NewTimer(within)
	defer timeout.Stop()
	select {
	case raw, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("paned connection lost")
		}
		// 성공과 오류를 **한 번에** 읽는다 (M8 D-A-16). 종전에는 PanedResponse 로
		// 먼저 읽었는데 오류 응답도 `id` 를 가져 그 해석이 성공했고, 오류는 "결과
		// 없음" 으로 뭉개졌다 — Delete·Create 의 실패가 nil 로 돌아왔다.
		var resp struct {
			Result any                  `json:"result"`
			Error  *toolipc.PanedErrObj `json:"error"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, err
		}
		if resp.Error != nil {
			return nil, &toolipc.RPCError{Code: resp.Error.Code, Message: resp.Error.Message}
		}
		result, ok := resp.Result.(map[string]interface{})
		if !ok {
			return map[string]interface{}{}, nil
		}
		return result, nil
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

// Subscribe registers an output channel for a tool. It returns exitCh (closed
// when the tool exits) and an unsubscribe function. unsubscribe removes the
// channel; it does not close exitCh (the tool-exit path owns that close).
// OutChunk 는 구독자가 받는 출력 한 조각이다.
//
// 바이트만으로는 부족하다 — 구독은 스냅샷 **앞에** 서므로 둘이 겹치고, 겹친
// OutChunk 는 toolhub.OutChunk 다 — 조각의 뜻은 그쪽 주석에 있다.
