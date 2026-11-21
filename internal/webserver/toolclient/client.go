package toolclient

import (
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
	// toolReconnectBackoff 는 연결이 끊긴 뒤 첫 재접속 시도까지의 대기다. 실패마다
	// 두 배로 늘어 toolMaxBackoff 에서 멈춘다 (FR-13).
	toolReconnectBackoff = time.Second
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
	// onReport·onResync 는 보고 push 와 재접속 뒤 기록 재동기다
	// (AGENT_RECORD_DAEMON_SRS §3.2a·FR-ARD-13). `mu` 아래.
	onReport func(ev toolipc.ReportEvent)
	// onAttn 은 attn push 콜백이다 (AGENT_RECORD_DAEMON_SRS §3.3a). 읽기 루프에서 돈다.
	onAttn func(ev toolipc.AttnEvent)
	// onEdges 는 edges push 콜백이다 (PEER_DAEMON_SRS §3.5a). 읽기 루프에서 돈다.
	onEdges func(ev toolipc.EdgesEvent)
	// onEdgeResync 는 재접속 뒤의 간선 재동기 콜백이다.
	onEdgeResync func()
	// onChat·onChatResync 는 chat push 와 재접속 뒤 콜백이다 (PEER_CHAT_SRS §3.11).
	onChat       func(ev toolipc.ChatEvent)
	onChatResync func()
	onResync     func()

	// fgMu 는 onForeground 호출과 fgSeen·fgSeq 를 한 줄로 세운다. fgSeen 은 마지막으로
	// 알린 전경 이름과 그 push 의 순번이다 — 재접속 뒤 목록과 대조해 끊긴 동안 놓친
	// 변화만 메운다 (resyncAfterReconnect, FR-OPT-2-1).
	fgMu   sync.Mutex
	fgSeen map[string]fgSeen
	fgSeq  uint64

	// Per-tool WS subscribers: output channel → its exit-signal channel. The
	// exit channel is closed when the tool exits so the WS handler can send
	// toolhub.OpExit and tear down.
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
		return nil, fmt.Errorf("dial dongminald: %w", err)
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
