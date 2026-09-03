package toolhub

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/outbuf"
	"dongminal/internal/shared/platform"

	"github.com/gorilla/websocket"
)

// Tool — PTY 하나의 수명.
//
// 기동(StartTool)·읽기 루프(readPTY)·클라이언트 방송(broadcast)·주의 알림
// 관측(observeOutput)·활동 상태·쓰기·종료(kill)·크기 변경이 여기 산다. 이 파일이
// 대답하는 질문은 **"도구 하나에게 무슨 일이 일어나는가"** 다.
//
// 레지스트리 쪽 질문("도구가 몇 개고 누가 그것을 찾는가")은 manager.go 다.

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
	term   platform.Terminal
	stream *outbuf.Stream
	// sandboxed 는 이 도구가 대응 컨테이너 안에서 도는가다. 영속 제외의 근거이며
	// (FR-SBX-33), 그것 말고는 도구의 동작을 바꾸지 않는다.
	sandboxed bool
	cmu       sync.Mutex
	cls       []*SafeConn
	exited    bool
	done      chan struct{}
	once      sync.Once
	Restored  bool

	// Attention state (PANE_ATTENTION_NOTIFY_SRS). attnCarry is touched only
	// by the readPTY goroutine (no lock). The atomics are shared with the
	// idle sweeper / input / query goroutines. onAttention/onAttentionClear/
	// allowBell are set once in StartTool before readPTY starts (race-free).
	LastOutputAt atomic.Int64
	attnArmed    atomic.Bool
	attention    atomic.Bool
	// attnRearmLocked 은 "주목한 뒤로 사용자가 아직 아무것도 입력하지 않았다"
	// 는 사실이다 (ATTENTION_FIRING_SRS FR-ATF-5). 잠긴 동안 출력은 무장을
	// 세우지 못한다 — TUI 는 유휴 상태에서도 화면을 갱신하므로, 이것이 없으면
	// 한 번 해제한 알람이 화면 갱신만으로 되살아나 되풀이해 운다 (B2).
	attnRearmLocked atomic.Bool
	// agentSeen 은 "이 도구에서 에이전트가 돌고 있다" 는 사실이다 (FR-ATF-1).
	// 활동 보고가 세우고 `ended` 가 내린다. L2 idle 은 이것 없이는 울지 않는다 —
	// 전경 프로세스가 있다는 것은 "무언가 돌고 있다" 는 뜻이지 "나를 기다린다"
	// 는 뜻이 아니다 (B1).
	agentSeen        atomic.Bool
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
// 합성 Tool)에서는 **빈 값**이다 — ToolHub.Cwd 의 계약이 "empty if unknown"
// 이며(hub.go), 여기서 서버의 cwd 로 덮으면 그것이 `source:"tool"` 을 달고 나가
// `+ Add` 의 자동채움에 남의 경로로 앉는다 (FR-ETR-31, §2.4). 도구의 실제
// cwd 는 셸 훅의 OSC 777 로도 들어오므로 이 경로는 보조다 (FR-XPI-6).
//
// 폴백이 없어진 것은 아니다 — 그것을 딛는 자리가 cwdOrServer 로 직접 부른다.
func (p *Tool) Cwd() string {
	if pid := p.CmdProcessPID(); pid > 0 {
		if cwd, ok := platform.Current().Info.CWD(pid); ok {
			return cwd
		}
	}
	return ""
}

// cwdOrServer 는 종전 Cwd 의 동작이다. 도구의 cwd 를 **비워 둘 수 없는** 자리가
// 쓴다 — 영속이 빈 값을 저장하면 재기동 때 홈으로 되살아나고, CWD 를 제공하지
// 않는 Windows 에서는 그것이 모든 도구에 걸린다.
func cwdOrServer(p *Tool) string {
	if cwd := p.Cwd(); cwd != "" {
		return cwd
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

// toolHome 은 도구 셸이 **자기 홈으로 여길 곳**이다. dmenv.EnvToolHome 이 있으면
// 그것이 우선하고, 없으면 종전대로 사용자 홈이다.
//
// 이 갈래가 있는 이유는 셸이 로그인 셸이기 때문이다 — rc 를 읽고 히스토리를
// 쓴다. 검사가 띄운 셸까지 사용자 홈을 쓰면 검사가 주입한 명령이 사용자의
// 히스토리에 섞인다. 격리는 검사 쪽에서 이 변수를 심어 얻는다.
//
// **도구가 열리는 자리(startDir)는 이것이 아니다.** 둘을 한 값으로 묶으면 홈을
// 격리하는 순간 도구가 열리는 위치까지 따라 옮겨진다 — 상태바의 cwd 와 탭 이름이
// 달라지고, 사용자가 보는 첫 화면이 바뀐다. 격리하려는 것은 셸이 쓰는 자리이지
// 사용자가 서 있는 자리가 아니다.
func toolHome() string {
	if v := os.Getenv(dmenv.EnvToolHome); v != "" {
		return v
	}
	return userHome()
}

// userHome 은 도구가 아무 지시 없이 열릴 자리다. 언제나 사용자의 홈이다.
func userHome() string {
	home, _ := os.UserHomeDir()
	return home
}

// StartTool spawns a shell under a new PTY. Exported for tool manager + tests.
//
// place 는 **호스트 셸 대신 띄울 것**이다. 샌드박스 창의 도구가 대응 컨테이너
// 안에서 도는 것이 이 갈래다 (SANDBOX_WINDOW_SRS FR-SBX-12). nil 이면 종전대로
// 호스트 셸이며, 그때의 동작은 이 인자가 없던 때와 완전히 같다 (NFR-SBX-2).
//
// 완성된 명세를 받는 것이 요점이다. 그래야 toolhub 가 컨테이너도 프로파일도
// 알지 않는다 — invalidator·ownedProvider 와 같은 방향이다.
func StartTool(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *ToolHooks, place *platform.ProcSpec) (*Tool, error) {
	home := toolHome()
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
	startDir := userHome()
	if cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			startDir = cwd
		}
	}
	if startDir == "" {
		startDir = "."
	}
	spec := platform.ProcSpec{
		Path: shell,
		Args: append([]string{shell}, shellArgs...),
		Env:  env,
		Dir:  startDir,
	}
	// 환경과 시작 위치는 대체하지 않는다. 샌드박스 경로에서 그 둘은 컨테이너
	// 안이 아니라 **docker 명령 자신이 쓸 값**이며, 호스트 도구와 같은 계산이
	// 옳다 (FR-SBX-12).
	if place != nil {
		spec.Path, spec.Args = place.Path, place.Args
	}
	term, err := platform.Current().PTY.Start(spec, cols, rows)
	if err != nil {
		return nil, err
	}
	p := &Tool{
		ID: id, Name: name,
		sandboxed: place != nil,
		term:      term,
		stream:    outbuf.NewStream(context.Background(), bufMax),
		done:      make(chan struct{}),
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
		id, spec.Path, term.PID(), startDir, cols, rows)
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
	// FR-ATF-5: 재무장이 잠긴 동안에는 출력이 무장을 세우지 못한다. 시각은
	// 그래도 적는다 — 준비완료 사다리(FR-STA-4)가 그 값을 읽는다.
	if !p.attnRearmLocked.Load() {
		p.attnArmed.Store(true)
	}
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

// Attend marks the tool as attended-to: disarms idle, locks re-arming, and
// clears attention.
// Invoked only via the explicit focus/clear endpoints — NOT on raw WS input,
// because xterm replies to terminal queries (cursor-position/device-attribute
// reports an agent's TUI emits) arrive as OpInput too and would spuriously
// clear a just-raised alarm. Real "user attended" is signalled by focus.
//
// FR-ATF-5: 잠금은 무장을 내리는 바로 이 자리에서 선다. 사용자가 **보기만
// 했다**는 뜻이므로, 다음 화면 갱신이 곧바로 같은 알람을 되살리면 안 된다.
func (p *Tool) Attend() {
	p.attnArmed.Store(false)
	p.attnRearmLocked.Store(true)
	p.clearAttention()
}

// AttendTyped 는 사용자가 그 도구에 **키를 눌렀을** 때의 주목이다 (FR-ATF-6).
// 보기만 한 것과 다른 점은 하나다 — 일을 시켰으므로 그 결과를 다시 기다리게
// 되고, 따라서 재무장을 열어 둔다.
func (p *Tool) AttendTyped() {
	p.attnArmed.Store(false)
	p.attnRearmLocked.Store(false)
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
// new output re-arms it. threshold<=0 disables L2.
//
// 발화까지 세 관문이 있고, 셋은 서로 다른 것을 묻는다 (ATTENTION_FIRING_SRS
// FR-ATF-1·3·10):
//
//	① 에이전트가 도는 도구인가   — 활동을 보고한 적이 있는가 (agentSeen)
//	② 전경 프로세스가 있는가     — 셸 프롬프트로 돌아간 도구는 울지 않는다
//	③ 지금 일하는 중은 아닌가    — 단, 굳은 `working` 은 억제하지 못한다
//
// ① 이 없던 동안 `vim`·`less`·`top`·`ssh`·빌드 대기가 전부 울었다. ② 만으로는
// "무언가 돌고 있다"까지밖에 말하지 못한다.
func (p *Tool) maybeIdle(now, threshold int64) {
	if threshold <= 0 || !p.attnArmed.Load() {
		return
	}
	if now-p.LastOutputAt.Load() < threshold {
		return
	}
	p.attnArmed.Store(false)
	if !p.agentSeen.Load() || !attnBusyProbe(p) {
		return
	}
	if ActivityStillWorking(p.activity.Load(), now) {
		return
	}
	p.setAttention("idle")
}

// ActivityStillWorking reports whether an activity snapshot suppresses idle:
// the agent says it is working AND that word is recent enough to believe
// (FR-ATF-10). 훅이 끊긴 채 `working` 으로 굳은 활동은 억제하지 못한다 — 그것이
// 알람을 영구히 막던 자리다 (B3).
//
// 공개인 이유는 데몬 모드가 **같은 판정**을 써야 하기 때문이다 (FR-ATF-12).
// 두 벌로 적으면 한쪽만 고쳐지는 날이 온다.
func ActivityStillWorking(a *ActivityState, now int64) bool {
	return a != nil && a.State == "working" && now-a.UpdatedAt < AttnWorkingStale
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
	// FR-ATF-2: 보고했다는 사실이 에이전트 표시를 세우고, `ended` 가 내린다.
	// 상태의 종류는 묻지 않는다 — 에이전트만이 활동을 보고하기 때문이다.
	p.agentSeen.Store(state != "ended")
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
		// 깨어나면 안 된다. FR-ATF-7: 상태를 버리는 자리가 재무장 잠금도 함께
		// 버린다.
		p.attnArmed.Store(false)
		p.attnRearmLocked.Store(false)
		p.clearAttention()
	})
}

// Resize is the exported wrapper around the unexported resize for
// ToolManager delegation. It calls pty.Setsize on the PTY master.
func (p *Tool) Resize(cols, rows uint16) error {
	return p.resize(cols, rows)
}
