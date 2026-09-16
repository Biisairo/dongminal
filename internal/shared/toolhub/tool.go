package toolhub

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"syscall"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/outbuf"
	"dongminal/internal/shared/platform"
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
//
// onOutput 의 end 는 그 청크를 포함한 **누적 입력 바이트**다
// (TERMINAL_RESUME_SRS FR-TRS-15). 라이브 스트림과 스냅샷이 같은 좌표계에 서야
// 재접속이 겹침을 정확히 잘라낼 수 있다.
type toolRelay struct {
	onOutput func(toolID string, data []byte, end int64)
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
	agentSeen atomic.Bool
	// turn 은 에이전트 훅이 말한 턴의 상태다 (묶음 N). agentSeen 이 "에이전트가
	// 있는가" 라면 이쪽은 "지금 무엇이 벌어지는 중인가" 이며, 알람이 새 사건에만
	// 서게 만드는 것이 그 쓰임이다 (FR-ATN-1·7).
	turn             AgentTurn
	attnCarry        []byte
	allowBell        bool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)
	// onSize 는 PTY 크기가 **바뀌었을 때만** 불린다 (M9_SRS FR-M9-3). 데몬
	// 모드에서 이것을 IPC push 로 잇는 것이 PanedServer 이며, 직접 모드에서는
	// 걸리지 않는다 — 그쪽은 `broadcast` 가 같은 일을 이 프로세스 안에서 끝낸다.
	// StartTool 이 readPTY 앞에서 한 번 세운다(경쟁 없음) — onAttention 과 같다.
	onSize func(id string, cols, rows uint16)

	// relay carries the exit/output callbacks. Stored atomically so the
	// readPTY goroutine reads them without racing daemon-mode wiring
	// (DAEMON_SPLIT_SRS FR-12). onExit is the base ToolManager handler set
	// once in StartTool; daemon mode wraps it exactly once via
	// PanedServer.wireTool (guarded by `wired`).
	relay atomic.Pointer[toolRelay]
	wired atomic.Bool

	// tmu 는 **터미널 핸들의 fd 를 직접 만지는 자리**만 감싼다 (`Resize`·`Close`).
	//
	// `Read`·`Write` 는 `os.File` 의 참조 계수가 지켜 주지만 `Fd()` 는 그것을
	// 우회한다 — `pty.Setsize` 가 그 경로이고, 닫는 중에 들어오면 이미 없는 fd 에
	// ioctl 을 건다. 종료 처리 전체를 감싸지 않는 이유는 그것이 프로세스를
	// 50ms 기다리기 때문이다. 그동안 `cmu` 를 쥐면 접속·브로드캐스트가 멎는다.
	tmu        sync.Mutex
	termClosed bool

	activity   atomic.Pointer[ActivityState]
	onActivity func(id, state, tool, detail string)

	// exitCode 는 kill() 이 수확한 종료 코드다. ExitInfo 로 나간다.
	exitCode atomic.Int32

	// bracketed paste 모드 (BRACKETED_PASTE_SRS FR-BPT-1/4). bpCarryBuf 는
	// attnCarry 와 같이 readPTY 고루틴만 만지므로 잠금이 없다. 원자값 쪽은
	// 입력 경로가 읽는다.
	bracketedPaste atomic.Bool
	bpCarryBuf     []byte

	// reportedCwd 는 셸 훅이 OSC 777;Cwd 로 알린 작업 디렉터리다
	// (WINDOWS_TOOL_CWD_SRS FR-WTC-2). readPTY 고루틴이 쓰고 아무 고루틴이나
	// 읽으므로 원자값이다. 값이 실린 적이 없으면 nil 이다.
	reportedCwd atomic.Value
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

// ToolHooks carries the attention wiring StartTool applies before launching
// readPTY (race-free). A nil *ToolHooks disables attention for that tool.
type ToolHooks struct {
	OnAttention      func(id, reason string)
	OnAttentionClear func(id string)
	OnActivity       func(id, state, tool, detail string)
	AllowBell        bool
	// OnOutput 은 출력 청크마다 readPTY 고루틴에서 한 번 돈다 — 직접 모드의
	// 해석층이 바이트를 받는 자리다 (M8_UNIFIED_SRS D-C-2). end 는 청크를 포함한
	// 누적 오프셋. 기동 **전에** 릴레이에 실리므로 첫 바이트도 놓치지 않는다;
	// 데몬 모드는 `WireRelayOnce` 가 릴레이를 통째로 바꾸므로 그쪽에는 닿지 않는다
	// — 데몬 프로세스에는 해석층이 없다.
	OnOutput func(id string, data []byte, end int64)
	// OnSize 는 PTY 크기가 바뀌었을 때 불린다 (M9_SRS FR-M9-3). 데몬 모드에서만
	// 걸린다 — 직접 모드의 통보는 `Tool.broadcast` 가 이 프로세스 안에서 끝낸다.
	OnSize func(id string, cols, rows uint16)
}

// ExitInfo 는 이 도구의 종료 사정이다. 끝나기 전에 부르면 Code 는 0 이다.
func (p *Tool) ExitInfo() ExitInfo {
	return ExitInfo{Code: int(p.exitCode.Load())}
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
		// VIEWER_URL_OPEN_SRS FR-VUO-13: 브라우저를 직접 찾는 라이브러리가
		// 존중하는 변수다. 셸 함수(open/xdg-open)로는 덮이지 않는 경로를 덮는다.
		toolBrowserEnv(binDir),
	}
	if u, err := user.Current(); err == nil {
		env = append(env, "USER="+u.Username, "LOGNAME="+u.Username)
	}
	env = append(env, sh.Env...)
	// TOOL_HISTORY_ISOLATION_SRS FR-THI-1·21: 이 도구만의 히스토리 파일. 심을 수
	// 없으면 비어 있고, 그때 셸은 종전대로 사용자 히스토리를 공유한다.
	env = append(env, toolHistEnv(id, shell)...)
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
	relay := &toolRelay{onExit: onExit}
	if hooks != nil && hooks.OnOutput != nil {
		relay.onOutput = hooks.OnOutput
	}
	p.relay.Store(relay)
	if hooks != nil {
		p.onAttention = hooks.OnAttention
		p.onAttentionClear = hooks.OnAttentionClear
		p.onActivity = hooks.OnActivity
		p.allowBell = hooks.AllowBell
		p.onSize = hooks.OnSize
	}
	// **뜬 자리를 기억한다** (WINDOWS_TOOL_CWD_SRS FR-WTC-6).
	//
	// 직접 조회가 되는 처지에서는 필요 없지만(그쪽이 이긴다), Windows 에서는
	// 첫 프롬프트가 돌기 전까지 이 도구의 자리를 **아무도 모른다** — 그 사이에
	// 이 도구를 기준으로 새 도구를 만들면(`cwdTool=…`) 승계가 홈으로 떨어진다
	// (러너 실측: 요청한 자리 대신 `C:\Users\runneradmin` 이 나왔다). 서버는
	// 어디서 띄웠는지 알고 있으므로 그것을 말한다.
	p.noteCwdReport(startDir)
	go p.readPTY()
	dmlog.Infof(nil, "[tool %s] started shell=%s pid=%d cwd=%s cols=%d rows=%d",
		id, spec.Path, term.PID(), startDir, cols, rows)
	return p, nil
}

// readPTY drains the PTY master, feeds the bounded stream buffer (single
// drop path: outbuf.Stream compaction → Stats.TotalBytesDrop), and
// fan-outs OpOutput messages to live clients. On EOF/IO error — **and on
// panic** — it triggers a single kill() (which itself emits the final OpExit)
// and signals onExit.
//
// 패닉 경로가 EOF 경로와 같은 이유 (M8 `GO-7`): 종전에는 recover 가 로그만
// 남기고 돌아갔다. 그러면 PTY fd 와 프로세스가 남고, 클라이언트는 OpExit 을 받지
// 못해 재연결을 되풀이하며(무한 재연결의 조건), tools.json 에는 계속 기재된다 —
// 반죽음이다. 읽기 고루틴이 죽은 도구는 죽은 도구다.
func (p *Tool) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			dmlog.Errorf(nil, "[tool %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
			p.exitAfterRead()
		}
	}()
	raw := make([]byte, 8192)
	for {
		n, err := p.term.Read(raw)
		if err != nil {
			// **errno 로 가른다** (04-secops SEC-17). 문구로 가르면 Go 나 OS 가
			// 그 말을 바꾸는 날 조용히 다른 갈래로 가고, 그때 정상 종료가
			// "예기치 못한 오류" 로 로그를 채운다.
			//
			// 셸이 끝나면 마스터 쪽 read 는 `EIO` 다 — 리눅스·macOS 모두 그렇고,
			// 그것이 이 자리에서 "정상 종료" 를 뜻한다.
			if errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) {
				dmlog.Infof(nil, "[tool %s] readPTY: shell exited normally", p.ID)
			} else {
				dmlog.Errorf(nil, "[tool %s] readPTY unexpected error: %v", p.ID, err)
			}
			p.exitAfterRead()
			return
		}
		// Single backpressure path: Stream.Feed never blocks; loss (if any)
		// is recorded in Stats.TotalBytesDrop.
		//
		// FR-TRS-17: Feed 와 **클라이언트 목록 확보**가 한 번의 cmu 구간 안에
		// 있어야 한다. 갈라 두면 그 사이에 붙은 클라이언트가 이 청크를 재생으로도
		// broadcast 로도 받아 한 번 더 보게 된다. 락 순서는 언제나 cmu → stream.mu 다.
		end, conns, live := p.feedAndClients(raw[:n])
		if r := p.relay.Load(); r != nil && r.onOutput != nil {
			r.onOutput(p.ID, append([]byte(nil), raw[:n]...), end)
		}
		p.observeOutput(raw[:n])
		p.observeBracketedPaste(raw[:n])
		if !live {
			continue
		}
		msg := make([]byte, 1+n)
		msg[0] = OpOutput
		copy(msg[1:], raw[:n])
		p.deliver(msg, conns)
	}
}

// exitAfterRead 는 읽기 고루틴이 끝난 뒤의 정리다 — kill() 그리고 onExit, 이
// 순서로. EOF 와 패닉이 같은 자리를 지난다. kill 은 sync.Once 라 다른 경로가
// 먼저 죽였어도 두 번 돌지 않는다.
func (p *Tool) exitAfterRead() {
	p.kill()
	if r := p.relay.Load(); r != nil && r.onExit != nil {
		go r.onExit(p.ID)
	}
}

// feedAndClients 는 청크를 스트림에 넣고, **같은 cmu 구간에서** 그 청크를 받을
// 클라이언트 목록을 확보한다 (FR-TRS-17). 그래야 AddClient 가 돌려준 오프셋이
// "이 클라이언트가 broadcast 로 받기 시작하는 자리" 와 정확히 일치한다.
//
// Feed 에는 읽기 버퍼를 **그대로** 넘긴다 — Stream 은 자기 버퍼에 복사하고 인자를
// 보관하지 않는다 (outbuf.Feed 의 계약). 청크당 명시적 복사는 릴레이 쪽 하나다
// (M8 `GO-37`).
func (p *Tool) feedAndClients(chunk []byte) (end int64, conns []*SafeConn, live bool) {
	p.cmu.Lock()
	defer p.cmu.Unlock()
	_, end = p.stream.Feed(chunk)
	if p.exited {
		return end, nil, false
	}
	conns = make([]*SafeConn, len(p.cls))
	copy(conns, p.cls)
	return end, conns, true
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
func (p *Tool) WireRelayOnce(build func(prevExit func(string)) (onOutput func(string, []byte, int64), onExit func(string))) bool {
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
