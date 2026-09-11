package toolclient

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

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

	// Push event callbacks. OnOutput runs once per output chunk in the readLoop
	// goroutine (attention/activity detection — DAEMON_SPLIT_SRS §6.2); it is
	// independent of WS subscribers so detection works even with no browser and
	// never double-counts or races attnCarry across multiple subscribers.
	OnOutput func(toolID string, data []byte)
	OnExit   func(toolID string, code int)
	// OnForeground fires when a tool's foreground process name changes
	// (CONVENIENCE_SRS FR-TAN-9). The daemon only pushes on change, so this
	// never repeats a value. nil disables the callback; the same name also
	// rides in every List() response, so nothing is lost by leaving it unset.
	//
	// Install it with SetOnForeground, not by assignment — readLoop reads this
	// under pc.mu and the daemon can push `fg` before the caller has finished
	// wiring.
	OnForeground func(toolID, name string)
	earlyPushes  []earlyPush

	// Per-tool WS subscribers: output channel → its exit-signal channel. The
	// exit channel is closed when the tool exits so the WS handler can send
	// toolhub.OpExit and tear down (parity with direct-mode tool.kill).
	subMu   sync.RWMutex
	subbers map[string]map[chan OutChunk]chan struct{}
	dropped atomic.Int64

	// daemonInfo 는 마지막 hello 가 말한 판이다 (FR-VHL-2). 재연결마다 갱신되므로
	// `mu` 아래 둔다 — readLoop 와 같은 잠금이다.
	daemonInfo DaemonInfo
}

// DaemonInfo 는 마지막 `hello` 가 말한 **데몬의 판**이다
// (VERSION_HEALTH_SRS FR-VHL-2).
//
// 여기서 판정하지 않는다 — 이 겹이 아는 것은 "데몬이 뭐라고 했는가" 이고,
// 그것을 우리 판과 견주는 일은 헬스 종단의 몫이다 (FR-VHL-11). 정책을 여기 두면
// 이 패키지가 릴리스 규약을 알아야 한다.
type DaemonInfo struct {
	// Protocol 은 데몬이 말한 문법 판이다. 말하지 않았으면 현재 판으로 읽는다
	// (FR-VHL-5) — 옛 데몬을 거부하면 갱신 중인 인스턴스가 통째로 멈춘다.
	Protocol int
	// Build 는 데몬 바이너리의 판이다. **말하지 않았으면 빈 값**이며, 빈 것은
	// 불일치가 아니다 (FR-CBG-5 — 모른다 ≠ 다르다).
	Build string
}

type earlyPush struct {
	event string
	tool  string
	code  int
}

// SetOnForeground 는 fg 콜백을 **잠금 안에서** 건다. 맨 대입을 쓰지 마라 —
// readLoop 는 DialToolClient 시점에 이미 돌고 있고, `fg` 푸시는 WS 구독과
// 무관하게 도착한다. 데몬은 연결 직후 값을 밀 수 있으므로 배선이 끝나기 전에
// readLoop 가 이 필드를 읽는 창이 실재한다 — 읽기만 잠그면 레이스는 남는다
// (`go test -race` 3회 중 1회 관측, 2026-08-28).
//
// 같은 계열이 둘 더 있다 — `OnOutput`·`OnExit` 도 맨 대입으로 걸리고 있어
// 같은 창을 안는다. 이 묶음(CONVENIENCE_SRS FR-TAN-9)의 범위 밖이라 손대지
// 않았다. 그 둘을 고칠 사람은 이 setter 를 본으로 삼으면 된다.
func (pc *ToolClient) SetOnForeground(cb func(toolID, name string)) {
	pc.mu.Lock()
	pc.OnForeground = cb
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
// and to the global OnOutput/OnExit callbacks.
func (pc *ToolClient) handlePush(event string, raw json.RawMessage) {
	switch event {
	case "output":
		var ev struct {
			Tool string `json:"tool"`
			Data string `json:"data"`
			// End 는 이 청크의 끝 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-15).
			// 이 필드를 보내지 않는 옛 데몬에서는 0 으로 읽히고, 그때 받는 쪽은
			// 겹침 제거를 건너뛴다 — 지금 동작과 같아질 뿐 나빠지지 않는다.
			End int64 `json:"end"`
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
			pc.OnOutput(ev.Tool, data)
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
	case "fg":
		var ev struct {
			Tool string `json:"tool"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
		pc.mu.Lock()
		cb := pc.OnForeground
		pc.mu.Unlock()
		if cb != nil {
			cb(ev.Tool, ev.Name)
		}
	case "exit":
		var ev struct {
			Tool string `json:"tool"`
			Code int    `json:"code"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
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
		// Global exit callback (activity cleanup). Buffer if not yet wired.
		pc.mu.Lock()
		if pc.OnExit != nil {
			pc.mu.Unlock()
			pc.OnExit(ev.Tool, ev.Code)
		} else {
			pc.earlyPushes = append(pc.earlyPushes, earlyPush{event: "exit", tool: ev.Tool, code: ev.Code})
			pc.mu.Unlock()
		}
	}
}

// FlushEarlyPushes replays any buffered exit events that arrived before
// the OnExit callback was set.
func (pc *ToolClient) FlushEarlyPushes() {
	pc.mu.Lock()
	pushes := pc.earlyPushes
	pc.earlyPushes = nil
	pc.mu.Unlock()
	for _, p := range pushes {
		if p.event == "exit" && pc.OnExit != nil {
			pc.OnExit(p.tool, p.code)
		}
	}
}

// call sends a request and blocks until the response arrives, the connection
// is lost, the call times out (FR-14), or the client closes.
func (pc *ToolClient) call(method string, params interface{}) (map[string]interface{}, error) {
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

	select {
	case raw, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("paned connection lost")
		}
		var resp toolipc.PanedResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			// Try error response
			var errResp toolipc.PanedError
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
// 앞부분을 잘라내려면 그 조각이 스트림의 어디인지 알아야 한다
// (TERMINAL_RESUME_SRS FR-TRS-15·16). End 는 이 조각의 **끝** 절대 오프셋이며,
// 조각이 덮는 구간은 `[End-len(Data), End)` 다. 0 은 "모른다" 이고, 그때는
// 잘라내지 않는다.
type OutChunk struct {
	Data []byte
	End  int64
}

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

// IsDaemon reports whether this ToolClient is in daemon mode (always true).
// Used by handleWS to detect daemon mode at runtime.
func (pc *ToolClient) IsDaemon() bool { return true }

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

func (pc *ToolClient) List() []map[string]interface{} {
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
func (pc *ToolClient) ListOK() ([]map[string]interface{}, bool) {
	resp, err := pc.call("list", struct{}{})
	if err != nil {
		return nil, false
	}
	raw, ok := resp["tools"]
	if !ok {
		// 목록이 있어야 할 자리가 응답에 없다. 데몬의 `list` 는 언제나 그 키를
		// 넣으므로(`ipc/paned.go`), 없다는 것은 이 응답이 목록이 아니라는 뜻이다 —
		// `call` 이 오류 응답을 빈 맵으로 돌려주는 경로가 여기로 온다.
		return nil, false
	}
	if raw == nil {
		// 키는 있고 값이 null 이다 — 도구가 0개인 것이며, 아는 것이다.
		return nil, true
	}
	arr, ok := raw.([]interface{})
	if !ok {
		return nil, false
	}
	out := make([]map[string]interface{}, 0, len(arr))
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if ok {
			out = append(out, m)
		}
	}
	return out, true
}

// 데몬 모드에서는 PTY 를 데몬이 소유하므로 샌드박스 배치도 그쪽에서 일어난다.
// 여기서는 어느 Window 의 도구인지만 실어 보낸다 (FR-SBX-11).
func (pc *ToolClient) Create(cwd string, cols, rows uint16, place toolhub.Placement) (*toolhub.Tool, error) {
	resp, err := pc.call("create", map[string]interface{}{
		"cwd": cwd, "cols": cols, "rows": rows,
		"window": place.WindowUUID, "profile": place.Profile,
		// UX_BATCH6_SRS FR-BGP-3: 셸 대신 띄울 명령. 데몬 모드에서도 프로세스를
		// 세우는 것은 데몬이므로 값만 실어 보낸다 — 프로파일과 같은 방향이다.
		"command": place.Command,
		// UX_BATCH6_SRS FR-SBM-3: 작업 방식도 데몬이 배치할 때 쓴다.
		"work": place.Work,
	})
	if err != nil {
		return nil, err
	}
	id, _ := resp["id"].(string)
	name, _ := resp["name"].(string)
	return &toolhub.Tool{ID: id, Name: name}, nil
}

func (pc *ToolClient) Get(id string) *toolhub.Tool {
	// ToolClient doesn't have local state; we check liveness via List
	tools := pc.List()
	for _, m := range tools {
		if m["id"].(string) == id {
			name, _ := m["name"].(string)
			return &toolhub.Tool{ID: id, Name: name}
		}
	}
	return nil
}

// Delete 는 데몬에게 그 도구를 지우라 한다. **RPC 의 실패를 그대로 돌려준다**
// (`GO-8`) — 종전에는 반환이 없어 데몬이 무엇을 답하든 성공으로 읽혔다.
func (pc *ToolClient) Delete(id string) error {
	_, err := pc.call("kill", map[string]interface{}{"id": id})
	return err
}

func (pc *ToolClient) Restore(id, name, cwd string, cols, rows uint16) error {
	_, err := pc.call("restore", map[string]interface{}{
		"id": id, "name": name, "cwd": cwd, "cols": cols, "rows": rows,
	})
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
	resp, err := pc.call("setbackground", map[string]interface{}{"id": id, "background": bg})
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
