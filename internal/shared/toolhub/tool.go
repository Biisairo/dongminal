package toolhub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/outbuf"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/uuid"

	"github.com/gorilla/websocket"
)

const (
	OpInput  byte = 0x00
	OpResize byte = 0x01
	OpOutput byte = 0x00
	OpError  byte = 0x01
	OpExit   byte = 0x02
	OpToolID byte = 0x03
)

const (
	writeWait  = 10 * time.Second
	PongWait   = 60 * time.Second
	PingPeriod = (PongWait * 9) / 10
	bufMax     = 1 << 20
)

var Upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ── SafeConn ─────────────────────────────────────────

type SafeConn struct {
	mu        sync.Mutex
	conn      *websocket.Conn
	closeOnce sync.Once
}

func NewSafeConn(c *websocket.Conn) *SafeConn { return &SafeConn{conn: c} }

func (s *SafeConn) WriteMsg(typ int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteMessage(typ, data)
}

func (s *SafeConn) WritePing() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(PingPeriod + writeWait))
	return s.conn.WriteMessage(websocket.PingMessage, nil)
}

// Send writes one framed message. **에러를 반환한다** — 죽은 소켓에 계속 쓰면
// 초당 수십 줄의 broken pipe 로그가 쌓이므로(실측 2026-08-25), 반복 송신하는
// 호출자는 첫 실패에서 그 구독을 접어야 한다.
func (s *SafeConn) Send(op byte, payload []byte) error {
	m := make([]byte, 1+len(payload))
	m[0] = op
	copy(m[1:], payload)
	err := s.WriteMsg(websocket.BinaryMessage, m)
	if err != nil {
		log.Printf("ws send op=0x%02x addr=%s: %v", op, s.RemoteAddr(), err)
	}
	return err
}

// Close is idempotent: sync.Once prevents double-Close panics when the
// deferred Close races with an error-path Close (e.g. readWS closing on
// read error while the WS handler's defer also fires).
func (s *SafeConn) Close() {
	s.closeOnce.Do(func() {
		s.conn.Close()
	})
}
func (s *SafeConn) RemoteAddr() string                  { return s.conn.RemoteAddr().String() }
func (s *SafeConn) SetReadLimit(l int64)                { s.conn.SetReadLimit(l) }
func (s *SafeConn) SetReadDeadline(t time.Time) error   { return s.conn.SetReadDeadline(t) }
func (s *SafeConn) SetPongHandler(h func(string) error) { s.conn.SetPongHandler(h) }
func (s *SafeConn) ReadMessage() (int, []byte, error)   { return s.conn.ReadMessage() }

// ── Tool ────────────────────────────────────────────

// Tool invariants:
//   - cmu protects cls and exited.
//   - broadcast/addClient/removeClient must NOT be called by a caller
//     already holding cmu (these methods acquire cmu themselves).
//   - Once exited=true, broadcast becomes a no-op and addClient rejects
//     new clients (sending OpExit immediately, outside cmu).
//   - The exited transition happens exactly once, inside kill() under
//     the protection of `once`.
//
// toolRelay holds the output/exit relay callbacks for a Tool. It is stored
// via atomic.Pointer so the readPTY goroutine can read the callbacks without
// racing against daemon-mode wiring (DAEMON_SPLIT_SRS FR-12).
type toolRelay struct {
	onOutput func(toolID string, data []byte)
	onExit   func(toolID string)
}

type Tool struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	// term 은 의사 터미널과 거기 붙은 셸 프로세스를 함께 소유한다. 종전의
	// ptmx(*os.File) + cmd(*exec.Cmd) 두 필드를 대신한다 — Windows ConPTY 는
	// 그 둘이 분리되지 않기 때문이다 (CROSS_PLATFORM_SRS FR-XPT-3).
	//
	// NewDetachedTool 이 만드는 합성 Tool 은 term 이 nil 이다. 모든 접근이
	// nil 을 견뎌야 한다.
	term     platform.Terminal
	stream   *outbuf.Stream
	cmu      sync.Mutex
	cls      []*SafeConn
	exited   bool
	done     chan struct{}
	once     sync.Once
	Restored bool

	// Attention state (PANE_ATTENTION_NOTIFY_SRS). attnCarry is touched only
	// by the readPTY goroutine (no lock). The atomics are shared with the
	// idle sweeper / input / query goroutines. onAttention/onAttentionClear/
	// allowBell are set once in StartTool before readPTY starts (race-free).
	LastOutputAt     atomic.Int64
	attnArmed        atomic.Bool
	attention        atomic.Bool
	attnCarry        []byte
	allowBell        bool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)

	// relay carries the exit/output callbacks. Stored atomically so the
	// readPTY goroutine reads them without racing daemon-mode wiring
	// (DAEMON_SPLIT_SRS FR-12). onExit is the base ToolManager handler set
	// once in StartTool; daemon mode wraps it exactly once via
	// PanedServer.wireTool (guarded by `wired`).
	relay atomic.Pointer[toolRelay]
	wired atomic.Bool

	activity   atomic.Pointer[ActivityState]
	onActivity func(id, state, tool, detail string)

	// bracketed paste 모드 (BRACKETED_PASTE_SRS FR-BPT-1/4). bpCarryBuf 는
	// attnCarry 와 같이 readPTY 고루틴만 만지므로 잠금이 없다. 원자값 쪽은
	// 입력 경로가 읽는다.
	bracketedPaste atomic.Bool
	bpCarryBuf     []byte
}

// toolBusyProbe is the busy-detection function used by Tool.IsBusy. It is a
// package variable so tests can substitute a deterministic probe instead of
// relying on the host's behavior. The default implementation matches the
// historical behavior: a tool is "busy" when it has any direct child process.
//
// 조회 방법은 platform.ProcInfo 가 안다 — 리눅스는 /proc, darwin 은 pgrep,
// Windows 는 toolhelp 스냅샷이다 (CROSS_PLATFORM_SRS FR-XPI-5).
var toolBusyProbe = func(pid int) bool {
	return platform.Current().Info.HasChildren(pid)
}

func (p *Tool) IsBusy() bool {
	pid := p.CmdProcessPID()
	if pid <= 0 {
		return false
	}
	return toolBusyProbe(pid)
}

// Cwd 는 도구 셸의 작업 디렉터리다. 조회할 수 없는 처지(Windows, 또는 PTY 없는
// 합성 Tool)에서는 서버의 cwd 로 답한다 — 종전과 같은 폴백이다. 도구의 실제
// cwd 는 셸 훅의 OSC 777 로도 들어오므로 이 경로는 보조다 (FR-XPI-6).
func (p *Tool) Cwd() string {
	if pid := p.CmdProcessPID(); pid > 0 {
		if cwd, ok := platform.Current().Info.CWD(pid); ok {
			return cwd
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

// ToolHooks carries the attention wiring StartTool applies before launching
// readPTY (race-free). A nil *ToolHooks disables attention for that tool.
type ToolHooks struct {
	OnAttention      func(id, reason string)
	OnAttentionClear func(id string)
	OnActivity       func(id, state, tool, detail string)
	AllowBell        bool
}

// NewDetachedTool은 PTY 없이 훅만 배선된 Tool 을 만든다. 셸을 띄우지 않으므로
// 프로세스도 파일 디스크립터도 만들지 않는다 — 데몬 모드에서 원격 도구를
// 대리하는 합성 Tool 과, 주의/활동 배선을 검증하는 테스트가 쓰는 경로다.
// hooks 가 nil 이면 훅 없는 빈 Tool 이 된다.
func NewDetachedTool(id string, hooks *ToolHooks) *Tool {
	p := &Tool{ID: id}
	if hooks != nil {
		p.onAttention = hooks.OnAttention
		p.onAttentionClear = hooks.OnAttentionClear
		p.onActivity = hooks.OnActivity
		p.allowBell = hooks.AllowBell
	}
	return p
}

// NewAttendingTool은 주의 상태가 이미 올라간 PTY 없는 도구를 만든다. armed 가
// true 면 유휴 감시까지 무장된 상태가 된다. 주의 알림 종단(clear / clear-all)의
// 동작을 다른 패키지에서 검증하려면 이 시작 상태가 필요하다 — 실제 경로로는
// PTY 출력 관찰을 거쳐야만 도달하기 때문이다.
func NewAttendingTool(id string, hooks *ToolHooks, armed bool) *Tool {
	p := NewDetachedTool(id, hooks)
	p.attention.Store(true)
	p.attnArmed.Store(armed)
	return p
}

// StartTool spawns a shell under a new PTY. Exported for tool manager + tests.
func StartTool(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *ToolHooks) (*Tool, error) {
	home, _ := os.UserHomeDir()
	binDir := filepath.Join(os.Getenv(dmenv.EnvHome), "bin")

	// 셸 선택과 훅 주입 방식은 OS 마다 다르다. 그 차이는 platform.ShellProvider
	// 뒤에 있고, 여기서는 어느 셸인지 묻지 않는다 (CROSS_PLATFORM_SRS FR-XSH-6).
	sh := platform.Current().Shell.Shell(binDir)
	shell, shellArgs := sh.Path, sh.Args

	// Ensure critical env vars are always present (os.Environ() may lack
	// these when the server runs as a daemon / LaunchAgent).
	env := []string{
		"TERM=xterm-256color", "COLORTERM=truecolor",
		// PATH 구분자는 OS 마다 다르다 — 문자를 박지 않는다.
		"PATH=" + os.Getenv("PATH") + string(os.PathListSeparator) + binDir,
		"HOME=" + home,
		// PANE_ATTENTION_NOTIFY_SRS: lets `dmctl notify` (incl. detached agent
		// hooks that have no controlling tty) identify this tool to the server.
		dmenv.EnvToolID + "=" + id,
	}
	if u, err := user.Current(); err == nil {
		env = append(env, "USER="+u.Username, "LOGNAME="+u.Username)
	}
	env = append(env, sh.Env...)
	env = append(os.Environ(), env...)
	startDir := home
	if cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			startDir = cwd
		}
	}
	if startDir == "" {
		startDir = "."
	}
	term, err := platform.Current().PTY.Start(platform.ProcSpec{
		Path: shell,
		Args: append([]string{shell}, shellArgs...),
		Env:  env,
		Dir:  startDir,
	}, cols, rows)
	if err != nil {
		return nil, err
	}
	p := &Tool{
		ID: id, Name: name,
		term:   term,
		stream: outbuf.NewStream(context.Background(), bufMax),
		done:   make(chan struct{}),
	}
	// Set the base exit callback before readPTY starts (race-free).
	p.relay.Store(&toolRelay{onExit: onExit})
	if hooks != nil {
		p.onAttention = hooks.OnAttention
		p.onAttentionClear = hooks.OnAttentionClear
		p.onActivity = hooks.OnActivity
		p.allowBell = hooks.AllowBell
	}
	go p.readPTY()
	log.Printf("[tool %s] started shell=%s pid=%d cwd=%s cols=%d rows=%d",
		id, shell, term.PID(), startDir, cols, rows)
	return p, nil
}

// readPTY drains the PTY master, feeds the bounded stream buffer (single
// drop path: outbuf.Stream compaction → Stats.TotalBytesDrop), and
// fan-outs OpOutput messages to live clients. On EOF/IO error it triggers
// a single kill() (which itself emits the final OpExit) and signals onExit.
func (p *Tool) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[tool %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
		}
	}()
	raw := make([]byte, 8192)
	for {
		n, err := p.term.Read(raw)
		if err != nil {
			if err == io.EOF || strings.Contains(err.Error(), "input/output error") {
				log.Printf("[tool %s] readPTY: shell exited normally", p.ID)
			} else {
				log.Printf("[tool %s] readPTY unexpected error: %v", p.ID, err)
			}
			p.kill()
			if r := p.relay.Load(); r != nil && r.onExit != nil {
				go r.onExit(p.ID)
			}
			return
		}
		// Single backpressure path: Stream.Feed never blocks; loss (if any)
		// is recorded in Stats.TotalBytesDrop.
		p.stream.Feed(append([]byte(nil), raw[:n]...))
		if r := p.relay.Load(); r != nil && r.onOutput != nil {
			r.onOutput(p.ID, append([]byte(nil), raw[:n]...))
		}
		p.observeOutput(raw[:n])
		p.observeBracketedPaste(raw[:n])
		msg := make([]byte, 1+n)
		msg[0] = OpOutput
		copy(msg[1:], raw[:n])
		p.broadcast(msg)
	}
}

// broadcast delivers msg to all currently-registered clients. It is a no-op
// once the tool has transitioned to exited. Caller must NOT hold cmu.
func (p *Tool) broadcast(msg []byte) {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		return
	}
	snap := make([]*SafeConn, len(p.cls))
	copy(snap, p.cls)
	p.cmu.Unlock()
	for _, c := range snap {
		if err := c.WriteMsg(websocket.BinaryMessage, msg); err != nil {
			log.Printf("[tool %s] broadcast error addr=%s: %v", p.ID, c.RemoteAddr(), err)
			p.RemoveClient(c)
			c.Close()
		}
	}
}

// observeOutput records output activity and runs observe-only L1 detection on
// the raw chunk. Called from the readPTY goroutine only; attnCarry needs no
// lock. The live bytes are never mutated.
func (p *Tool) observeOutput(chunk []byte) { p.observeOutputAt(chunk, attnNow()) }

// observeOutputAt is observeOutput with an injectable timestamp (tests).
func (p *Tool) observeOutputAt(chunk []byte, now int64) {
	p.LastOutputAt.Store(now)
	p.attnArmed.Store(true)
	if p.onAttention == nil {
		return
	}
	scan := chunk
	if len(p.attnCarry) > 0 {
		scan = append(append([]byte(nil), p.attnCarry...), chunk...)
	}
	if bytes.IndexByte(scan, 0x1b) < 0 && bytes.IndexByte(scan, 0x07) < 0 {
		p.attnCarry = nil
		return
	}
	sig, carry := DetectAttentionSignal(scan, p.allowBell, AttnMaxCarry)
	p.attnCarry = carry
	if sig {
		p.setAttention("signaled")
	}
}

// setAttention transitions none→attention exactly once (edge), firing the
// notifier only on the transition (NFR-PAN-3). Returns true if it transitioned.
// Used by passive detection (L1 OSC, L2 idle) where re-alerting an already-
// flagged tool would be noise.
func (p *Tool) setAttention(reason string) bool {
	if p.attention.CompareAndSwap(false, true) {
		if p.onAttention != nil {
			p.onAttention(p.ID, reason)
		}
		return true
	}
	return false
}

// SignalAttention raises attention and ALWAYS notifies (not edge-gated). Used
// by explicit agent signals (`dmctl notify` → set endpoint): each discrete
// completion/waiting event must re-alert the user even if a prior unattended
// alarm is still active. The state itself stays idempotent (already-true).
func (p *Tool) SignalAttention(reason string) {
	p.attention.Store(true)
	if p.onAttention != nil {
		p.onAttention(p.ID, reason)
	}
}

// clearAttention transitions attention→none exactly once, firing the clear
// notifier only on the transition.
func (p *Tool) clearAttention() bool {
	if p.attention.CompareAndSwap(true, false) {
		if p.onAttentionClear != nil {
			p.onAttentionClear(p.ID)
		}
		return true
	}
	return false
}

// Attend marks the tool as attended-to: disarms idle and clears attention.
// Invoked only via the explicit focus/clear endpoints — NOT on raw WS input,
// because xterm replies to terminal queries (cursor-position/device-attribute
// reports an agent's TUI emits) arrive as OpInput too and would spuriously
// clear a just-raised alarm. Real "user attended" is signalled by focus.
func (p *Tool) Attend() {
	p.attnArmed.Store(false)
	p.clearAttention()
}

// attnBusyProbe reports whether a tool has a running foreground process. It is
// a package variable so tests can substitute a deterministic probe.
var attnBusyProbe = func(p *Tool) bool { return p.IsBusy() }

// SetAttnBusyProbe는 유휴 탐지와 활동 스냅샷 정리가 쓰는 전경 프로세스 검사를
// 교체하고, 이전 검사로 되돌리는 함수를 돌려준다. 다른 패키지의 테스트가 이것을
// 필요로 하는 이유는 NewDetachedTool 로 만든 도구에 프로세스가 없어 항상
// "busy 아님"으로 읽히고, 그러면 working 상태가 정리 대상이 되기 때문이다.
func SetAttnBusyProbe(f func(*Tool) bool) (restore func()) {
	prev := attnBusyProbe
	attnBusyProbe = f
	return func() { attnBusyProbe = prev }
}

// maybeIdle fires L2 (idle) attention when an armed tool has been quiet for at
// least threshold. It disarms after firing so it fires once per quiet edge;
// new output re-arms it. threshold<=0 disables L2. Idle only fires when a
// foreground process (e.g. an agent) is actually running — a bare shell sitting
// at its prompt is not "waiting on the user" and must not raise an alarm (this
// is what otherwise floods the UI with bogus alarms after a daemon restart).
// Additionally, idle is suppressed while the agent is actively working (activity
// state "working") — a thinking agent that pauses output is not waiting for input.
func (p *Tool) maybeIdle(now, threshold int64) {
	if threshold <= 0 || !p.attnArmed.Load() {
		return
	}
	if now-p.LastOutputAt.Load() < threshold {
		return
	}
	p.attnArmed.Store(false)
	if !attnBusyProbe(p) {
		return
	}
	// Suppress idle alarm while agent is actively working (thinking).
	if a := p.activity.Load(); a != nil && a.State == "working" {
		return
	}
	p.setAttention("idle")
}

// Attention reports whether the tool currently needs attention.
func (p *Tool) Attention() bool { return p.attention.Load() }

type ActivityState struct {
	State     string `json:"state"`
	Tool      string `json:"tool,omitempty"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

type ActivitySnap struct {
	ToolID    string `json:"toolId"`
	State     string `json:"state"`
	Tool      string `json:"tool,omitempty"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

func (p *Tool) SetActivity(state, tool, detail string) {
	if state == "ended" {
		p.activity.Store(nil) // 종료 → 카드 제거(스냅샷에서 빠짐)
	} else {
		p.activity.Store(&ActivityState{State: state, Tool: tool, Detail: detail, UpdatedAt: attnNow()})
	}
	if p.onActivity != nil {
		p.onActivity(p.ID, state, tool, detail)
	}
}

func (p *Tool) Activity() *ActivityState { return p.activity.Load() }

// AddClient registers c. Returns false when the tool has already exited; in
// that case OpExit is sent to c immediately (outside cmu) and c is left
// untouched in the caller's possession. Caller must NOT hold cmu.
func (p *Tool) AddClient(c *SafeConn) bool {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		_ = c.Send(OpExit, nil)
		log.Printf("[tool %s] addClient after exit addr=%s — sent OpExit", p.ID, c.RemoteAddr())
		return false
	}
	p.cls = append(p.cls, c)
	n := len(p.cls)
	p.cmu.Unlock()
	log.Printf("[tool %s] client connected addr=%s total=%d", p.ID, c.RemoteAddr(), n)
	return true
}

func (p *Tool) RemoveClient(c *SafeConn) {
	p.cmu.Lock()
	for i, v := range p.cls {
		if v == c {
			p.cls = append(p.cls[:i], p.cls[i+1:]...)
			break
		}
	}
	n := len(p.cls)
	p.cmu.Unlock()
	log.Printf("[tool %s] client disconnected addr=%s remaining=%d", p.ID, c.RemoteAddr(), n)
}

func (p *Tool) resize(c, r uint16) error {
	if p.term == nil {
		return fmt.Errorf("tool %s: 터미널이 없다", p.ID)
	}
	err := p.term.Resize(c, r)
	if err != nil {
		log.Printf("[tool %s] resize error cols=%d rows=%d: %v", p.ID, c, r, err)
	}
	return err
}

// Wait returns a channel closed when the tool terminates (test helper).
func (p *Tool) Wait() <-chan struct{} { return p.done }

// WireRelayOnce는 이 도구의 출력·종료 릴레이를 평생 한 번만 설치한다.
// build 는 이전 릴레이의 종료 콜백(없으면 nil)을 받아 교체 콜백 한 쌍을
// 돌려준다. 이미 배선된 도구면 build 를 호출하지 않고 false 를 돌려준다 —
// 중복 배선은 종료 핸들러를 중첩시키고 push 를 재발생시킨다 (FR-12).
//
// 데몬의 socket 서버(internal/daemon/ipc)가 유일한 호출자다. relay 의 내부
// 표현(atomic.Pointer[toolRelay])을 패키지 밖으로 내보내지 않기 위해 불변식을
// 여기에 둔다.
func (p *Tool) WireRelayOnce(build func(prevExit func(string)) (onOutput func(string, []byte), onExit func(string))) bool {
	if !p.wired.CompareAndSwap(false, true) {
		return false
	}
	var baseExit func(string)
	if prev := p.relay.Load(); prev != nil {
		baseExit = prev.onExit
	}
	onOutput, onExit := build(baseExit)
	p.relay.Store(&toolRelay{onOutput: onOutput, onExit: onExit})
	return true
}

// Size 는 터미널의 현재 크기다. 터미널이 없거나 읽지 못하면 ok=false 다.
func (p *Tool) Size() (cols, rows uint16, ok bool) {
	if p.term == nil {
		return 0, 0, false
	}
	c, r, err := p.term.Size()
	return c, r, err == nil
}

// Stream exposes the output stream for tools.
func (p *Tool) Stream() *outbuf.Stream { return p.stream }

// CmdProcessPID returns the PID (0 if unavailable).
func (p *Tool) CmdProcessPID() int {
	if p.term == nil {
		return 0
	}
	return p.term.PID()
}

// Write sends data to the PTY master. Safe to call from any goroutine.
func (p *Tool) Write(data []byte) error {
	if p.term == nil {
		return fmt.Errorf("tool %s: 터미널이 없다", p.ID)
	}
	_, err := p.term.Write(data)
	return err
}

// kill transitions the tool to exited exactly once: it marks exited under
// cmu, fans out a final OpExit to the clients that were registered at that
// moment (outside cmu), then tears down the PTY/process and stream.
//
// kill is race-free by design:
//   - sync.Once guarantees the body executes at most once, even when the
//     readPTY goroutine calls kill() on EOF while an external caller (API
//     handler, watchdog) concurrently calls kill().
//   - The once.Do body is self-contained: it snapshots the client list
//     under cmu, broadcasts outside cmu (avoiding deadlock with addClient),
//     then tears down resources (ptmx, cmd, stream). No call from inside
//     the once body re-enters kill() or readPTY.
//   - Closing p.done inside once.Do safely unblocks any Wait() readers;
//     the close is also idempotent under the Once guard.
//   - The onExit callback is NOT invoked here — it was moved to readPTY
//     (which is the sole caller after EOF) to avoid re-entrancy issues.
func (p *Tool) kill() {
	p.once.Do(func() {
		// Phase 1: atomic mark + snapshot under cmu.
		p.cmu.Lock()
		p.exited = true
		snap := make([]*SafeConn, len(p.cls))
		copy(snap, p.cls)
		p.cmu.Unlock()

		// Phase 2: final OpExit broadcast outside cmu. Errors are ignored —
		// the tool is dying anyway and clients will close on their side.
		exitMsg := []byte{OpExit}
		for _, c := range snap {
			_ = c.WriteMsg(websocket.BinaryMessage, exitMsg)
		}

		// Phase 3: tear down PTY/process/stream.
		pid := p.CmdProcessPID()
		log.Printf("[tool %s] killing pid=%d", p.ID, pid)
		// NewDetachedTool 로 만든 Tool 은 done 이 nil 이다 (PTY 도 프로세스도 없는
		// 합성 Tool — 데몬 모드의 원격 도구 대리와 테스트가 쓴다). 무조건 닫으면
		// close(nil chan) 으로 패닉한다. 아래 ptmx·cmd·stream 이 이미 같은 방어를
		// 하고 있었고 이 줄만 빠져 있었다.
		if p.done != nil {
			close(p.done)
		}
		if p.term != nil {
			p.term.Close()
			// 순서와 유예는 종전과 같다 — 정중히 요청, 50ms, 강제 종료, 수확.
			p.term.Terminate()
			time.Sleep(50 * time.Millisecond)
			p.term.Kill()
			if err := p.term.Wait(); err != nil {
				log.Printf("[tool %s] wait: %v", p.ID, err)
			}
		}
		if p.stream != nil {
			p.stream.Close()
		}
		// tool 종료 → 활동 카드 제거(셸 exit/Ctrl+C 등, SessionEnd hook 없이도).
		if p.activity.Load() != nil {
			p.SetActivity("ended", "", "")
		}
		// FR-ATL-1·2 (NFR-PAN-8): 주의도 같은 자리에서 내린다. 활동만 정리하고
		// 주의를 남겨 두었던 것이, 닫은 탭의 알람이 배지에 남던 원인이다.
		// disarm 까지 하는 이유는 Attend 와 같다 — 죽은 도구가 idle 로 다시
		// 깨어나면 안 된다.
		p.attnArmed.Store(false)
		p.clearAttention()
	})
}

// Resize is the exported wrapper around the unexported resize for
// ToolManager delegation. It calls pty.Setsize on the PTY master.
func (p *Tool) Resize(cols, rows uint16) error {
	return p.resize(cols, rows)
}

// ── ToolManager ─────────────────────────────────────

type ToolManager struct {
	mu    sync.RWMutex
	tools map[string]*Tool

	dataDir     string
	invalidator func(toolID string)

	// ownedProvider 는 "어떤 도구가 상위 도메인의 소유인가" 를 답한다 (FR-HLM-3).
	// toolhub 는 Run 을 알지 못하며 알아서도 안 되므로(의존 방향), 판별은 위에서
	// 꽂는다 — invalidator 와 같은 형태다. nil 이면 아무도 소유하지 않는 것이고,
	// 그때 동작은 이 필드가 없던 때와 **완전히 같다**.
	ownedProvider func() map[string]struct{}
	dirty         atomic.Bool

	// saves 는 진행 중인 SaveAll 을 센다. 저장은 요청 경로를 막지 않도록
	// 고루틴으로 떨어뜨리는데(아래 `go m.SaveAll()`), 그러면 **아무도 그것이
	// 끝났는지 알 수 없다.** 종료 경로와 테스트가 기다릴 수 있어야 한다 —
	// 기다리지 못해서 실제로 겪은 것이 t.TempDir 정리와의 경합이다
	// (WINDOWS_TEST_PARITY_SRS §5 의 간헐 실패).
	saves sync.WaitGroup

	// saveMu 는 noSave 와 saves.Add 를 **한 덩어리로** 지킨다. 둘이 갈리면
	// `Wait` 가 진행 중일 때 뒤늦은 `Add` 가 들어와 WaitGroup 이 패닉한다
	// (sync: WaitGroup is reused before previous Wait has returned).
	saveMu sync.Mutex
	noSave bool

	// Attention (PANE_ATTENTION_NOTIFY_SRS): idleThreshold/allowBell configure
	// detection; attnNotify/attnClear bridge transitions to SSE (set via
	// SetAttentionNotifier from the composition root).
	idleThreshold  int64 // nanos, 0 disables L2
	allowBell      bool
	attnNotify     func(id, reason string)
	attnClear      func(id string)
	activityNotify func(id, state, tool, detail string)

	// background는 탭에서 떼어내 백그라운드로 보낸 도구의 전환 시각(unix
	// nanos)을 담는다. 런타임 전용 — tools.json 에 기재하지 않으므로 데몬
	// 재시작을 넘기지 못한다 (FR-BG-9). 이 규칙이 고아 누적을 원리적으로
	// 차단하며, 그래서 TTL·개수 한도·회수 스케줄러가 필요 없다.
	background map[string]int64

	// 전경 프로세스 이름 캐시 (CONVENIENCE_SRS FR-TAN-8/9). fgMu 가 캐시와
	// 알림 콜백을, fgFlight 가 조회의 single-flight 를 지킨다. 조회 자체는
	// 두 락 밖에서 돈다 — 구현은 foreground.go 에 있다.
	fgMu     sync.Mutex
	fgFlight sync.Mutex
	fgCache  map[string]fgEntry
	fgNotify func(id, name string)
}

// BackgroundEntry는 백그라운드 도구 한 건의 조회 결과다 (FR-BG-6).
type BackgroundEntry struct {
	ToolID string `json:"toolId"`
	Name   string `json:"name"`
	Cwd    string `json:"cwd"`
	Since  int64  `json:"since"`
}

// NewToolManager builds an empty manager. dataDir is where tools.json lives;
// invalidator is called whenever a tool dies so the workspace layer can prune
// its references (may be nil in tests).
func NewToolManager(dataDir string, invalidator func(string)) *ToolManager {
	return &ToolManager{
		tools:         make(map[string]*Tool),
		dataDir:       dataDir,
		invalidator:   invalidator,
		idleThreshold: int64(AttentionIdleThreshold()),
		allowBell:     attentionAllowBell(),
	}
}

// SetAttentionNotifier wires tool attention transitions to broadcasts. Called
// from the composition root after the CommandHub exists (mirrors
// SetInvalidator). Must be called before tools are created so Create/Restore
// hand the hooks to StartTool.
func (m *ToolManager) SetAttentionNotifier(notify func(id, reason string), clear func(id string)) {
	m.mu.Lock()
	m.attnNotify = notify
	m.attnClear = clear
	m.mu.Unlock()
}

// SetActivityNotifier wires tool activity transitions to broadcasts (mirrors
// SetAttentionNotifier). Must be called before tools are created.
func (m *ToolManager) SetActivityNotifier(notify func(id, state, tool, detail string)) {
	m.mu.Lock()
	m.activityNotify = notify
	m.mu.Unlock()
}

// attnHooks builds the per-tool hooks from the manager's notifier config.
func (m *ToolManager) attnHooks() *ToolHooks {
	if m.attnNotify == nil && m.attnClear == nil && m.activityNotify == nil {
		return nil
	}
	return &ToolHooks{OnAttention: m.attnNotify, OnAttentionClear: m.attnClear, OnActivity: m.activityNotify, AllowBell: m.allowBell}
}

// ActivitySnapshot returns the current activity of every tool that has reported
// one, sorted by id (FR-AAP-4; lets a late-joining client restore cards).
func (m *ToolManager) ActivitySnapshot() []ActivitySnap {
	type item struct {
		id string
		a  *ActivityState
		p  *Tool
	}
	m.mu.RLock()
	items := make([]item, 0, len(m.tools))
	for id, p := range m.tools {
		if a := p.Activity(); a != nil {
			items = append(items, item{id, a, p})
		}
	}
	m.mu.RUnlock()
	// busy check (pgrep) runs outside the lock. A `working` card whose agent
	// process is gone is pruned so an abnormal exit (no Stop/SessionEnd hook)
	// doesn't leave a stale "working" (FR-AAP-20).
	out := []ActivitySnap{}
	for _, it := range items {
		if it.a.State == "working" && !attnBusyProbe(it.p) {
			continue
		}
		out = append(out, ActivitySnap{ToolID: it.id, State: it.a.State, Tool: it.a.Tool, Detail: it.a.Detail, UpdatedAt: it.a.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ToolID < out[j].ToolID })
	return out
}

// sweepIdle runs one L2 idle pass at the given time. Exposed for deterministic
// tests; the goroutine in StartAttentionSweeper calls it on each tick.
func (m *ToolManager) sweepIdle(now int64) {
	m.mu.RLock()
	tools := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		tools = append(tools, p)
	}
	threshold := m.idleThreshold
	m.mu.RUnlock()
	for _, p := range tools {
		p.maybeIdle(now, threshold)
	}
}

// StartAttentionSweeper launches the L2 idle sweeper goroutine. stop closes on
// server shutdown. No-op when L2 is disabled (idleThreshold<=0).
func (m *ToolManager) StartAttentionSweeper(stop <-chan struct{}) {
	if m.idleThreshold <= 0 {
		return
	}
	go func() {
		t := time.NewTicker(attnTickMS * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				m.sweepIdle(attnNow())
			case <-stop:
				return
			}
		}
	}()
}

// AttentionIDs returns the ids of tools currently needing attention (FR-PAN-8).
func (m *ToolManager) AttentionIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var ids []string
	for id, p := range m.tools {
		if p.Attention() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// ClearAllAttention attends to every tool currently needing attention and
// returns how many were cleared (FR-PAN-17, bulk dismiss).
func (m *ToolManager) ClearAllAttention() int {
	m.mu.RLock()
	tools := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		tools = append(tools, p)
	}
	m.mu.RUnlock()
	n := 0
	for _, p := range tools {
		if p.Attention() {
			p.Attend()
			n++
		}
	}
	return n
}

// SetOwnedTools registers the probe that answers "which tools belong to a live
// owner in a layer above this one" (FR-HLM-3).
//
// invalidator 와 같은 형태로 위에서 꽂는다 — toolhub 가 Run 을 import 하면 의존
// 방향이 뒤집힌다. 집합을 통째로 돌려주는 이유는 SaveAll 이 도구마다 묻지 않고
// 한 번만 묻게 하기 위해서다: 제공자가 파일을 읽을 수 있다.
func (m *ToolManager) SetOwnedTools(f func() map[string]struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ownedProvider = f
}

// ownedTools reads the probe under lock and calls it outside — 제공자가 파일
// I/O 를 할 수 있으므로 잠금을 건너 부르지 않는다 (Cwd() 와 같은 규약).
func (m *ToolManager) ownedTools() map[string]struct{} {
	m.mu.RLock()
	f := m.ownedProvider
	m.mu.RUnlock()
	if f == nil {
		return nil
	}
	return f()
}

// SetInvalidator lets main register the workspace invalidation hook after
// wsMgr has been constructed (avoids a chicken-and-egg ordering issue).
func (m *ToolManager) SetInvalidator(f func(string)) {
	m.mu.Lock()
	m.invalidator = f
	m.mu.Unlock()
}

// defaultToolName은 새 도구의 표시명이다. FR-UNI-8 로 id 에서 분리됐다 — 이전에는
// "Shell #{카운터}" 였고, 표시명이 id 파생이라 id 형식 변경에 끌려다녔다. 도구 간
// 구분은 좌표 라벨(W{n}.P{n}.T{n})과 cwd 가 담당한다.
const defaultToolName = "Shell"

// DataDir returns the tool persistence directory (used by tests).
func (m *ToolManager) DataDir() string { return m.dataDir }

func (m *ToolManager) dataPath(name string) string {
	dir := m.dataDir
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, name)
}

// Create spawns a new tool.
func (m *ToolManager) Create(cwd string, cols, rows uint16) (*Tool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// FR-UNI-7: toolId 는 uuid 다. 카운터는 영속되지 않아 모든 도구가 닫힌 상태로
	// 재기동하면 "1" 부터 재사용됐다 (SRS §2.7 (3)).
	// FR-UNI-8: 표시명은 id 와 분리한다 — 구분은 좌표와 cwd 가 담당한다.
	id := uuid.NewString()
	p, err := StartTool(id, defaultToolName, cwd, cols, rows, func(toolID string) {
		m.Delete(toolID)
		if m.invalidator != nil {
			m.invalidator(toolID)
		}
	}, m.attnHooks())
	if err != nil {
		log.Printf("[tool %s] create error: %v", id, err)
		return nil, err
	}
	m.tools[id] = p
	log.Printf("[tool %s] registered total=%d", id, len(m.tools))
	m.dirty.Store(true)
	m.saveAsync()
	return p, nil
}

func (m *ToolManager) Restore(id, name, cwd string, cols, rows uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := StartTool(id, name, cwd, cols, rows, func(toolID string) {
		m.Delete(toolID)
		if m.invalidator != nil {
			m.invalidator(toolID)
		}
	}, m.attnHooks())
	if err != nil {
		return err
	}
	p.Restored = true
	m.tools[id] = p
	log.Printf("[tool %s] restored total=%d", id, len(m.tools))
	return nil
}

// Adopt은 이미 만들어진 Tool 을 자기 ID 로 레지스트리에 등록한다. PTY 를 띄우지
// 않으므로 Create/Restore 와 달리 프로세스를 만들지 않는다 — 데몬 모드의 합성
// Tool 과 핸들러 테스트 픽스처가 쓰는 경로다.
func (m *ToolManager) Adopt(p *Tool) {
	if p == nil || p.ID == "" {
		return
	}
	m.mu.Lock()
	m.tools[p.ID] = p
	m.mu.Unlock()
}

func (m *ToolManager) Get(id string) *Tool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tools[id]
}

func (m *ToolManager) List() []map[string]interface{} {
	// 전경 이름은 m.mu 를 잡기 전에 구한다 (FR-TAN-7/8). 자체 캐시가 있어
	// 목록 요청이 잦아도 조회 주기는 fgRefreshInterval 로 묶여 있다.
	fg := m.ForegroundNames()
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []map[string]interface{}
	for _, p := range m.tools {
		pid := p.CmdProcessPID()
		cols, rows := 0, 0
		if c, r, ok := p.Size(); ok {
			cols, rows = int(c), int(r)
		}
		out = append(out, map[string]interface{}{
			"id": p.ID, "name": p.Name, "pid": pid,
			"sizeCols": cols, "sizeRows": rows,
			"fgName": fg[p.ID],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
	return out
}

func (m *ToolManager) Delete(id string) {
	m.mu.Lock()
	p := m.tools[id]
	delete(m.tools, id)
	delete(m.background, id)
	remaining := len(m.tools)
	m.mu.Unlock()
	if p != nil {
		p.kill()
		log.Printf("[tool %s] deleted remaining=%d", id, remaining)
	}
	m.dirty.Store(true)
	m.saveAsync()
}

// saveAsync 는 저장을 요청 경로 밖으로 떨어뜨리되 **셀 수 있게** 한다.
//
// 문 여부 확인과 Add 를 한 락 안에서 한다. 갈라 두면 StopSaving 이 Wait 에
// 들어간 뒤에 Add 가 도착해 WaitGroup 이 패닉할 수 있다.
func (m *ToolManager) saveAsync() {
	m.saveMu.Lock()
	if m.noSave {
		m.saveMu.Unlock()
		return
	}
	m.saves.Add(1)
	m.saveMu.Unlock()

	go func() {
		defer m.saves.Done()
		m.SaveAll()
	}()
}

// StopSaving 은 **더 이상 저장을 시작하지 않게 하고**, 진행 중인 것을 기다린다.
//
// 종료 경로가 이것을 부른다. 부르지 않으면 프로세스가 인플라이트 저장 도중에
// 끝나 `tools.json` 이 잘린 채 남을 수 있다 — 마지막 `SaveAll()` 한 번으로는
// 이미 떠 있는 고루틴을 막지도 기다리지도 못한다.
//
// 기다리기만 해서는 안 되는 이유가 이름에 있다. 도구가 죽으면 readPTY 가
// onExit → Delete 를 부르고 그것이 다시 저장을 떨어뜨린다. 기다림이 끝난 뒤에
// 그 일이 일어나면 이미 치운 자리로 쓰기가 간다.
//
// SaveAll 자신은 막지 않는다 — 문을 닫은 뒤 마지막 상태를 한 번 쓰는 것이
// 종료 절차이기 때문이다.
func (m *ToolManager) StopSaving() {
	m.saveMu.Lock()
	m.noSave = true
	m.saveMu.Unlock()
	m.saves.Wait()
}

// IsLive implements the liveness interface consumed by workspace.Manager.
func (m *ToolManager) IsLive(id string) bool { return m.Get(id) != nil }

// IsDaemon reports false: ToolManager is direct mode, not daemon-backed.
func (m *ToolManager) IsDaemon() bool { return false }

// ── persistence ──────────────────────────────────────

type ToolState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

// SaveAll writes tools.json. Skips when no state mutation has occurred since
// startup so a clean run never clobbers an existing user file with empty state.
//
// Cwd() can take tens to hundreds of ms on macOS (lsof). To keep it from
// blocking concurrent Create/Delete calls, we snapshot tool pointers under
// m.mu and then call Cwd() OUTSIDE the lock.
func (m *ToolManager) SaveAll() {
	if !m.dirty.Load() {
		return
	}
	m.mu.Lock()
	snap := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		snap = append(snap, p)
	}
	m.mu.Unlock()
	// 소유 집합은 루프 밖에서 한 번만 묻는다 — 제공자가 파일을 읽을 수 있으므로
	// 도구마다 부르면 SaveAll 한 번이 파일을 n번 읽는다.
	owned := m.ownedTools()
	states := make([]ToolState, 0, len(snap))
	for _, p := range snap {
		// FR-EM-12/FR-BG-9: 백그라운드 도구는 기재하지 않는다. 기재하면
		// 재시작 시 빈 셸로 되살아나 고아가 된다 — 백그라운드로 보낸 이유가
		// "돌고 있던 작업"이므로 빈 셸에는 의미가 없다.
		//
		// FR-HLM-3 이 그 규칙에 **예외 하나**를 낸다. 규칙이 사라지는 것이
		// 아니다 — 위 근거의 핵심은 그 도구에 **소유자가 없다**는 것이고, 그래서
		// 되살아나도 아무도 거둘 수 없다. 헤드리스 멤버의 도구는 Run 이 소유하며
		// (owned 가 그것을 답한다), 소유자가 있으면 되살아난 뒤에도 run status 의
		// 고아 목록과 run close 가 그것을 거둘 수 있다.
		if m.IsBackground(p.ID) {
			if _, own := owned[p.ID]; !own {
				continue
			}
		}
		states = append(states, ToolState{ID: p.ID, Name: p.Name, Cwd: p.Cwd()})
	}
	sort.Slice(states, func(i, j int) bool { return states[i].ID < states[j].ID })
	data, _ := json.Marshal(states)
	if err := os.WriteFile(m.dataPath("tools.json"), data, 0644); err != nil {
		log.Printf("saveTools: %v", err)
	}
}

// LoadAll reads tools.json and respawns the shells that referenced still
// points at. Unreferenced entries are discarded (FR-EM-14).
func (m *ToolManager) LoadAll(referenced map[string]struct{}) {
	data, err := os.ReadFile(m.dataPath("tools.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadTools: %v", err)
		}
		return
	}
	var states []ToolState
	if err := json.Unmarshal(data, &states); err != nil {
		log.Printf("loadTools unmarshal: %v", err)
		return
	}
	restored, skipped := 0, 0
	for _, s := range states {
		// FR-EM-14: 어떤 탭도 참조하지 않는 도구는 어느 UI 에서도 도달할 수
		// 없다. 되살리면 부팅마다 셸이 누적되기만 한다.
		if _, ok := referenced[s.ID]; !ok {
			skipped++
			continue
		}
		if err := m.Restore(s.ID, s.Name, s.Cwd, 120, 40); err != nil {
			log.Printf("[tool %s] restore error: %v", s.ID, err)
			continue
		}
		restored++
	}
	if skipped > 0 {
		log.Printf("tools: 미참조 %d개 폐기", skipped)
	}
	// Mark dirty so the next SaveAll (e.g. on shutdown) persists CWD changes
	// that happen after restore, even if no tools were created/deleted.
	m.dirty.Store(true)
	log.Printf("tools restored count=%d", restored)
}

// Snapshot locks + copies tool pointers; used by adapters.
func (m *ToolManager) Snapshot() []*Tool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		out = append(out, p)
	}
	return out
}

// ── ToolManager: expanded ToolHub methods (DAEMON_SPLIT_SRS Phase 1) ──

// Write sends data to the PTY master of the named tool.
func (m *ToolManager) Write(id string, data []byte) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return nil // silently drop write to nonexistent tool
	}
	return p.Write(data)
}

// Resize changes the PTY dimensions of the named tool.
func (m *ToolManager) Resize(id string, cols, rows uint16) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return nil
	}
	return p.Resize(cols, rows)
}

// Cwd returns the current working directory of the named tool.
func (m *ToolManager) Cwd(id string) string {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ""
	}
	return p.Cwd()
}

// Busy reports whether the named tool has a running foreground process.
func (m *ToolManager) Busy(id string) bool {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return false
	}
	return p.IsBusy()
}

// ToolSnapshot captures the outbuf state of a tool for reattach scrollback
// restoration (DAEMON_SPLIT_SRS §6.6).
type ToolSnapshot struct {
	Data           []byte
	TotalBytesIn   int64
	TotalBytesDrop int64
	Retained       int
}

// SnapshotTool returns the outbuf snapshot of the named tool.
func (m *ToolManager) SnapshotTool(id string) (ToolSnapshot, error) {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ToolSnapshot{}, nil
	}
	s := p.Stream()
	if s == nil {
		return ToolSnapshot{}, nil
	}
	data, stats := s.Snapshot()
	return ToolSnapshot{
		Data:           data,
		TotalBytesIn:   stats.TotalBytesIn,
		TotalBytesDrop: stats.TotalBytesDrop,
		Retained:       stats.Retained,
	}, nil
}

// MaxTerminalDim is the upper bound (inclusive) accepted for cols and rows.
// Values above this clamp back to the default to reject pathological inputs.
const MaxTerminalDim uint64 = 4096

// ParseSize extracts cols/rows from request query.
// Out-of-range (0 or > MaxTerminalDim) or unparseable values fall back to defaults (120, 40).
func ParseSize(r *http.Request) (uint16, uint16) {
	c, ro := uint16(120), uint16(40)
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		c = uint16(v)
	}
	if v, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		ro = uint16(v)
	}
	return c, ro
}

// SetBackground marks tool id as background (bg=true) or restores it to a tab
// (bg=false). Returns false when the tool does not exist.
//
// Background is not a lifecycle of its own: the tool keeps running exactly as
// before. The flag records the *intent* that it outlives its tab, which is the
// one thing the server could not express — and without it "no tab references
// this tool" cannot be told apart from a leak (FR-BG).
func (m *ToolManager) SetBackground(id string, bg bool) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.tools[id]; !ok {
		return false
	}
	if m.background == nil {
		m.background = map[string]int64{}
	}
	if bg {
		if _, already := m.background[id]; !already {
			m.background[id] = time.Now().UnixNano()
		}
	} else {
		delete(m.background, id)
	}
	m.dirty.Store(true)
	return true
}

// IsBackground reports whether tool id was explicitly sent to the background.
func (m *ToolManager) IsBackground(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.background[id]
	return ok
}

// BackgroundList returns every background tool, oldest transition first.
func (m *ToolManager) BackgroundList() []BackgroundEntry {
	m.mu.RLock()
	type pair struct {
		t     *Tool
		since int64
	}
	pairs := make([]pair, 0, len(m.background))
	for id, since := range m.background {
		if t, ok := m.tools[id]; ok {
			pairs = append(pairs, pair{t, since})
		}
	}
	m.mu.RUnlock()

	// Cwd() shells out (lsof on macOS) — never hold the lock across it.
	out := make([]BackgroundEntry, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, BackgroundEntry{ToolID: p.t.ID, Name: p.t.Name, Cwd: p.t.Cwd(), Since: p.since})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since < out[j].Since })
	return out
}
