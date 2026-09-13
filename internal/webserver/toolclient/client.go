package toolclient

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"errors"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
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
func (pc *ToolClient) handlePush(event string, raw json.RawMessage) {
	switch event {
	case "output":
		pc.pushOutput(raw)
	case "fg":
		pc.pushForeground(raw)
	case "exit":
		pc.pushExit(raw)
	}
}

// pushOutput 은 `output` push 다 — 해석층(onOutput)에 한 번, 구독한 브라우저마다 한 번.
func (pc *ToolClient) pushOutput(raw json.RawMessage) {
	var ev struct {
		Tool string `json:"tool"`
		Data string `json:"data"`
		// End 는 이 청크의 끝 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-15).
		// 이 필드를 보내지 않는 옛 데몬에서는 0 으로 읽히고, 그때 받는 쪽은
		// 겹침 제거를 건너뛴다 — 지금 동작과 같아질 뿐 나빠지지 않는다.
		End int64 `json:"end"`
		// Kind 는 도구의 종류다 (M8_UNIFIED_SRS D-C-10). 여기서 목록으로 되물으면
		// 그 RPC 의 응답을 읽을 고루틴이 바로 이 readLoop 라 시한까지 막힌다.
		Kind string `json:"kind"`
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
	pc.mu.Lock()
	onOutput := pc.onOutput
	pc.mu.Unlock()
	if onOutput != nil {
		onOutput(ev.Tool, toolhub.ToolKind(ev.Kind), data, ev.End)
	}
	// Dispatch to per-tool output channels. Non-blocking: a single slow
	// WS subscriber must never stall readLoop (which serves every tool).
	// Drops are counted/logged rather than silently lost (FR-18).
	//
	// 순회는 **락 안에서** 한다. 종전에는 락 안에서 map 을 꺼내고 밖에서
	// 돌았는데, 꺼낸 것은 사본이 아니라 map 그 자체다 — 그 사이 브라우저
	// 하나가 붙거나 떨어지면(Subscribe·unsubscribe) Go 런타임이 프로세스를
	// 죽인다: `concurrent map iteration and map write`. recover 로 잡히는
	// 종류가 아니고, 서버가 통째로 사라진다.
	//
	// 락을 잡은 채 보내도 막히지 않는다 — 아래 send 는 default 가 있어
	// 언제나 즉시 떨어진다. 로그만 락 밖으로 미룬다(I/O 라 길다).
	var dropped int64
	pc.subMu.RLock()
	for ch := range pc.subbers[ev.Tool] {
		select {
		case ch <- OutChunk{Data: data, End: ev.End}:
		default:
			dropped = pc.dropped.Add(1)
		}
	}
	pc.subMu.RUnlock()
	if dropped == 1 || (dropped > 0 && dropped%256 == 0) {
		dmlog.Warnf(nil, "toolclient: WS output backpressure tool=%s dropped=%d (slow browser?)", ev.Tool, dropped)
	}
}

// pushForeground 는 `fg` push 다 — 전경 이름이 바뀌었다.
func (pc *ToolClient) pushForeground(raw json.RawMessage) {
	var ev struct {
		Tool string `json:"tool"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	pc.invalidateList()
	pc.mu.Lock()
	cb := pc.onForeground
	pc.mu.Unlock()
	if cb != nil {
		cb(ev.Tool, ev.Name)
	}
}

// pushExit 은 `exit` push 다 — 구독자를 닫고 전역 종료 콜백을 부른다.
func (pc *ToolClient) pushExit(raw json.RawMessage) {
	var ev struct {
		Tool   string   `json:"tool"`
		Code   int      `json:"code"`
		Stderr []string `json:"stderr"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	pc.invalidateList()
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
	// Global exit callback (activity cleanup). Buffer if not yet wired —
	// SetOnExit 가 재생한다.
	pc.mu.Lock()
	onExit := pc.onExit
	if onExit == nil {
		pc.earlyPushes = append(pc.earlyPushes, earlyPush{tool: ev.Tool, info: toolhub.ExitInfo{Code: ev.Code, Stderr: ev.Stderr}})
	}
	pc.mu.Unlock()
	if onExit != nil {
		onExit(ev.Tool, toolhub.ExitInfo{Code: ev.Code, Stderr: ev.Stderr})
	}
}

// call sends a request and blocks until the response arrives, the connection
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
type OutChunk = toolhub.OutChunk

func (pc *ToolClient) Subscribe(toolID string, ch chan OutChunk) (exitCh <-chan struct{}, unsubscribe func()) {
	ex := make(chan struct{})
	pc.subMu.Lock()
	if pc.subbers[toolID] == nil {
		pc.subbers[toolID] = map[chan OutChunk]chan struct{}{}
	}
	pc.subbers[toolID][ch] = ex
	pc.subMu.Unlock()
	return ex, func() {
		pc.subMu.Lock()
		delete(pc.subbers[toolID], ch)
		pc.subMu.Unlock()
	}
}

// Daemon 은 자기 자신이다 — 이 클라이언트가 곧 프로세스 경계를 건너는 표면이다.
func (pc *ToolClient) Daemon() toolhub.DaemonHub { return pc }

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

func (pc *ToolClient) List() []toolhub.ToolInfo {
	out, _ := pc.ListOK()
	return out
}

// ListOK 는 목록과 함께 **그 목록이 관측된 사실인지**를 답한다
// (TOOL_LIST_UNKNOWN_SRS FR-TLU-2).
//
// `List` 의 nil 로는 "도구가 0개"와 "데몬에게 묻지 못했다"가 갈리지 않는다 —
// 데몬의 ToolManager 는 도구가 없으면 nil 슬라이스를 주고 그것이 JSON 에서
// `"tools": null` 로 나오기 때문이다 (SRS §2.3). 그 둘을 같게 다루면 재접속의
// 짧은 창에 클라이언트가 **살아 있는 도구 전부를 죽은 것으로 판정**한다.
//
// 그래서 판정을 RPC 를 실제로 하는 이 자리 하나에 둔다. 응답이 왔으면 목록이
// 비어 있어도 아는 것이고, 오지 않았으면 모르는 것이다.
func (pc *ToolClient) ListOK() ([]toolhub.ToolInfo, bool) {
	// 짧은 TTL 캐시 (M8 `GO-6`). Get·IsLive·Has 가 전부 이 목록을 딛는데, 요청
	// 하나가 멤버·도구마다 그것을 물어 `GET /api/runs` 한 번이 list RPC 를
	// 수십 번 직렬로 왕복했다. 재접속 창에서는 그 하나하나가 5초 시한에
	// 매달렸다. 캐시는 push(`exit`·`fg`)와 이 클라이언트를 지나는 변경(create·
	// kill·terminate·restore·setbackground)이 **보내기 전과 돌아온 뒤 두 번**
	// 무효화한다 — 데몬은 한 연결의 요청을 직렬로 처리하므로, 변경이 진행되는
	// 동안의 조회는 캐시가 아니라 RPC 로 가야 변경 뒤에 답을 받는다. 종전(캐시
	// 없음)의 관측 순서가 그것이었고, e2e skill-contract 가 그 순서를 단정한다.
	if tools, ok := pc.cachedList(); ok {
		return tools, true
	}
	// RPC 를 시작한 **세대**를 적어 둔다. 응답이 오기 전에 무효화가 끼면(예: 이
	// list 가 데몬에서 답해진 뒤 kill 이 지나갔다) 그 응답은 이미 낡은 것이라
	// 저장하지 않는다 — 저장하면 무효화를 덮어써 지운 도구가 TTL 동안 되살아난다
	// (e2e skill-contract 에서 실측).
	gen := pc.listGeneration()
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil, false
	}
	raw, ok := resp["tools"]
	if !ok {
		// 목록이 있어야 할 자리가 응답에 없다. 데몬의 `list` 는 언제나 그 키를
		// 넣으므로(`ipc/paned.go`), 없다는 것은 이 응답이 목록이 아니라는 뜻이다.
		return nil, false
	}
	if raw == nil {
		// 키는 있고 값이 null 이다 — 도구가 0개인 것이며, 아는 것이다.
		pc.storeList(nil, gen)
		return nil, true
	}
	// 와이어는 toolhub.ToolInfo 의 JSON 그대로다 (`GO-13`) — 한 번 다시 부호화해
	// 그 타입으로 읽는다. 형 단언으로 키를 하나씩 뜯던 자리다.
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	var out []toolhub.ToolInfo
	if err := json.Unmarshal(blob, &out); err != nil {
		return nil, false
	}
	pc.storeList(out, gen)
	return out, true
}

// listCacheTTL 은 목록 캐시의 수명이다. 낡은 값이 살 수 있는 최대 창이며, 그
// 안의 변경은 push 와 변경 호출이 무효화로 덮는다.
const listCacheTTL = 200 * time.Millisecond

func (pc *ToolClient) cachedList() ([]toolhub.ToolInfo, bool) {
	pc.listMu.Lock()
	defer pc.listMu.Unlock()
	if pc.listAt.IsZero() || time.Since(pc.listAt) > listCacheTTL {
		return nil, false
	}
	return pc.listCache, true
}

func (pc *ToolClient) listGeneration() uint64 {
	pc.listMu.Lock()
	defer pc.listMu.Unlock()
	return pc.listGen
}

// storeList 는 gen 이 지금 세대일 때만 저장한다 — 그 사이 무효화가 있었으면 이
// 응답은 낡은 것이다.
func (pc *ToolClient) storeList(tools []toolhub.ToolInfo, gen uint64) {
	pc.listMu.Lock()
	if pc.listGen == gen {
		pc.listCache, pc.listAt = tools, time.Now()
	}
	pc.listMu.Unlock()
}

// invalidateList 는 캐시를 버리고 세대를 올린다 — 목록을 바꿨거나 바뀌었다는
// push 를 받은 자리. 진행 중인 list 응답은 이 세대 앞의 것이라 저장되지 않는다.
func (pc *ToolClient) invalidateList() {
	pc.listMu.Lock()
	pc.listAt = time.Time{}
	pc.listGen++
	pc.listMu.Unlock()
}

// 데몬 모드에서는 PTY 를 데몬이 소유하므로 샌드박스 배치도 그쪽에서 일어난다.
// 여기서는 어느 Window 의 도구인지만 실어 보낸다 (FR-SBX-11).
func (pc *ToolClient) Create(cwd string, cols, rows uint16, place toolhub.Placement) (*toolhub.Tool, error) {
	pc.invalidateList()
	resp, err := pc.call("create", map[string]interface{}{
		"cwd": cwd, "cols": cols, "rows": rows,
		"window": place.WindowUUID, "profile": place.Profile,
		// UX_BATCH6_SRS FR-BGP-3: 셸 대신 띄울 명령. 데몬 모드에서도 프로세스를
		// 세우는 것은 데몬이므로 값만 실어 보낸다 — 프로파일과 같은 방향이다.
		"command": place.Command,
		// UX_BATCH6_SRS FR-SBM-3: 작업 방식도 데몬이 배치할 때 쓴다.
		"work": place.Work,
		// M8_UNIFIED_SRS §9.3 ④: 에이전트 도구의 종류·argv·어댑터 id. 프로세스를
		// 세우는 것은 데몬이므로 값만 실어 보낸다 — 프로파일·명령과 같은 방향이다.
		"kind": string(place.Kind), "argv": place.Argv, "agent": place.Agent,
		// M8_UNIFIED_SRS D-C-11: 재개는 같은 도구 신원이다. 옛 데몬은 모르는 필드를 버리고 새
		// id 를 주며, 호출자(apiAgentResume)가 그 어긋남을 본다.
		"reuseId": place.ReuseID,
	})
	if err != nil {
		// M8 D-A-16: 상한 초과는 코드로 건너온다 — 핸들러의 `errors.Is` 가 두 모드에서 같다.
		var rpc *toolipc.RPCError
		if errors.As(err, &rpc) && rpc.Code == toolipc.CodeToolCap {
			return nil, fmt.Errorf("%w: %s", toolhub.ErrToolCap, rpc.Message)
		}
		return nil, err
	}
	pc.invalidateList()
	id, _ := resp["id"].(string)
	name, _ := resp["name"].(string)
	kind, _ := resp["kind"].(string)
	agent, _ := resp["agent"].(string)
	return &toolhub.Tool{ID: id, Name: name, Kind: toolhub.ToolKind(kind), Agent: agent}, nil
}

// Get 은 **신원만 든 합성 Tool** 이다 (`GO-47`, ToolHub.Get 의 계약) — ID·Name·
// Kind·Agent 는 목록에서 오고, 전송·프로세스가 필요한 메서드는 무동작·영값이다.
func (pc *ToolClient) Get(id string) *toolhub.Tool {
	// ToolClient doesn't have local state; we check liveness via List
	for _, t := range pc.List() {
		if t.ID == id {
			return &toolhub.Tool{ID: id, Name: t.Name, Kind: t.Kind, Agent: t.Agent}
		}
	}
	return nil
}

// Delete 는 데몬에게 그 도구를 지우라 한다. **RPC 의 실패를 그대로 돌려준다**
// (`GO-8`) — 종전에는 반환이 없어 데몬이 무엇을 답하든 성공으로 읽혔다.
func (pc *ToolClient) Delete(id string) error {
	pc.invalidateList()
	_, err := pc.call("kill", map[string]interface{}{"id": id})
	pc.invalidateList()
	return err
}

// Terminate 는 데몬에게 유예를 실어 보낸다 (FBE-05/12). 데몬은 그 유예를 자기
// 쪽에서 기다린 뒤 지우므로, 이 호출의 시한은 기본 시한에 유예를 더한 값이다.
func (pc *ToolClient) Terminate(id string, grace time.Duration) error {
	pc.invalidateList()
	_, err := pc.callWithin("terminate", map[string]interface{}{
		"id": id, "graceMs": grace.Milliseconds(),
	}, panedCallTimeout+grace)
	pc.invalidateList()
	return err
}

func (pc *ToolClient) Restore(id, name, cwd string, cols, rows uint16) error {
	pc.invalidateList()
	_, err := pc.call("restore", map[string]interface{}{
		"id": id, "name": name, "cwd": cwd, "cols": cols, "rows": rows,
	})
	pc.invalidateList()
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

// SendPaste 는 감싸기와 제출을 데몬에 맡긴다 — 판단이 클라이언트로 새면 안 된다
// (BRACKETED_PASTE_SRS FR-BPW-4).
func (pc *ToolClient) SendPaste(id string, text []byte, submit bool) error {
	_, err := pc.call("paste", map[string]interface{}{
		"id":     id,
		"data":   base64.StdEncoding.EncodeToString(text),
		"submit": submit,
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
	pc.invalidateList()
	resp, err := pc.call("setbackground", map[string]interface{}{"id": id, "background": bg})
	pc.invalidateList()
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
	return pc.SnapshotToolSince(id, -1)
}

// SnapshotToolSince 는 재개 지점을 실어 스냅샷을 부른다 (TERMINAL_RESUME_SRS
// FR-TRS-3). since<0 은 전량 재생이다.
//
// `resumed` 를 보내지 않는 옛 데몬에서는 false 로 읽히므로 전량 재생으로
// 취급된다 — 강등이지 오류가 아니다.
func (pc *ToolClient) SnapshotToolSince(id string, since int64) (toolhub.ToolSnapshot, error) {
	resp, err := pc.call("snapshot", map[string]interface{}{"id": id, "since": since})
	if err != nil {
		return toolhub.ToolSnapshot{}, err
	}
	dataStr, _ := resp["data"].(string)
	data, _ := base64.StdEncoding.DecodeString(dataStr)
	totalIn, _ := resp["totalBytesIn"].(float64)
	totalDrop, _ := resp["totalBytesDrop"].(float64)
	retained, _ := resp["retained"].(float64)
	end, _ := resp["end"].(float64)
	resumed, _ := resp["resumed"].(bool)
	return toolhub.ToolSnapshot{
		Data:           data,
		TotalBytesIn:   int64(totalIn),
		TotalBytesDrop: int64(totalDrop),
		Retained:       int(retained),
		End:            int64(end),
		Resumed:        resumed,
	}, nil
}

// Ensure ToolClient implements toolhub.ToolHub.
var _ toolhub.ToolHub = (*ToolClient)(nil)

// Reconnects 는 이 손잡이가 연결을 **되살린 횟수**다
// (OBSERVABILITY_SRS FR-OBS-12).
//
// 진단이 읽는 집계 수치다. 0 이 아니면 데몬이 죽었다 살아났다는 뜻이고, 그
// 사실은 "도구가 가끔 멎는다" 류의 신고에서 가장 먼저 필요한 값이다.
func (pc *ToolClient) Reconnects() int64 { return pc.reconnects.Load() }
