package toolhub

import (
	"dongminal/internal/shared/dmlog"
	"errors"
	"io"
	"os"
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
// 기동(StartTool)·읽기 루프(readPTY)·출력 릴레이·주의 알림 관측(observeOutput)·
// 활동 상태·쓰기·종료(kill)·크기 변경이 여기 산다. 이 파일이
// 대답하는 질문은 **"도구 하나에게 무슨 일이 일어나는가"** 다.
//
// 레지스트리 쪽 질문("도구가 몇 개고 누가 그것을 찾는가")은 manager.go 다.

// Tool invariants:
//   - cmu protects exited and orders it against stream feeding.
//   - The exited transition happens exactly once, inside kill() under
//     the protection of `once`.
//
// 출력을 받는 쪽은 릴레이 하나다 — 데몬이 그것을 IPC push 로 서버에 잇는다
// (DIRECT_MODE_REMOVAL_SRS FR-DMR-40). 이 프로세스 안의 클라이언트 목록은 없다.
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
	exited    bool
	done      chan struct{}
	once      sync.Once

	// Attention state (PANE_ATTENTION_NOTIFY_SRS). attnCarry is touched only
	// by the readPTY goroutine (no lock). The atomics are shared with the
	// idle sweeper / input / query goroutines. onAttention/onAttentionClear are
	// set once in StartTool before readPTY starts (race-free).
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
	turn      AgentTurn
	attnCarry []byte
	// allowBell 은 원자값이다 — 데몬의 attnconfig 가 이미 도는 도구에도 바꾼다
	// (AGENT_RECORD_DAEMON_SRS §3.3a).
	allowBell        atomic.Bool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)
	// onSize 는 PTY 크기가 **바뀌었을 때만** 불린다 (M9_SRS FR-M9-3). 이것을
	// IPC push 로 잇는 것이 데몬의 PanedServer 다.
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
	// 닫는 중에 들어온 `Resize` 가 이미 닫힌 터미널 핸들을 만지지 않게 한다.
	// 종료 처리 전체를 감싸지 않는 이유는 그것이 프로세스를
	// 50ms 기다리기 때문이다. 그동안 `cmu` 를 쥐면 읽기 루프의 적재가 멎는다.
	tmu        sync.Mutex
	termClosed bool

	activity   atomic.Pointer[ActivityState]
	onActivity func(id, state, tool, detail string)

	// records 는 데몬이 이 도구에 매달아 두는 에이전트 기록이다 (AGENT_RECORD_DAEMON_SRS
	// FR-ARD-10). 도구와 함께 사라진다.
	records toolRecords

	// exitCode 는 kill() 이 수확한 종료 코드다. ExitInfo 로 나간다.
	exitCode atomic.Int32

	// 앱이 켜 둔 터미널 모드 (TERMINAL_MODE_RESTORE_SRS FR-TMR-2/7 ·
	// BRACKETED_PASTE_SRS FR-BPT-1/4 를 넓힌 것). modeCarryBuf 는 attnCarry 와
	// 같이 readPTY 고루틴만 만지므로 잠금이 없다. 원자값 쪽은 입력 경로와
	// **재접속 경로**가 읽는다 — 후자가 이 상태를 든 이유다: 새 xterm 은 앱이
	// 켠 모드를 하나도 모르고, 재생만으로는 되살아나지 않는다.
	modes        atomic.Uint64
	modeCarryBuf []byte
	// scanScratch 는 이월과 청크를 이어 붙이는 재사용 버퍼다 — 주의·모드 관측이
	// 차례로 쓴다 (readPTY 고루틴 전용, FR-OPT-3-2).
	scanScratch []byte

	// frz 는 데몬 교체 전의 읽기 멈춤이다 (DAEMON_SESSION_KEEP_SRS FR-DSK-13).
	frz freezeState

	// reportedCwd 는 셸 훅이 OSC 777;Cwd 로 알린 작업 디렉터리다
	// (WINDOWS_TOOL_CWD_SRS FR-WTC-2). readPTY 고루틴이 쓰고 아무 고루틴이나
	// 읽으므로 원자값이다. 값이 실린 적이 없으면 nil 이다.
	reportedCwd atomic.Value
}

// toolProcInfo 는 이 패키지가 프로세스를 묻는 유일한 자리다 — IsBusy 와 busyOf 가
// 같은 이음새를 지난다. 검사가 호스트 대신 결정론적 답을 넣고 조회 수를 센다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-3). busy 는 직계 자식 프로세스가 있는가다;
// 조회 방법은 platform.ProcInfo 가 안다 (CROSS_PLATFORM_SRS FR-XPI-5).
var toolProcInfo = func() platform.ProcInfo { return platform.Current().Info }

// busyOf 는 IsBusy 를 여럿에 한 번에 답한다 — 조회는 ChildrenOf 한 번이다
// (FR-OPT-8-3). nil 과 pid 없는 도구는 busy 가 아니다(IsBusy 와 같다).
func busyOf(ps []*Tool) map[*Tool]bool {
	pids := make([]int, 0, len(ps))
	for _, p := range ps {
		if p != nil {
			pids = append(pids, p.CmdProcessPID())
		}
	}
	children := toolProcInfo().ChildrenOf(pids)
	out := make(map[*Tool]bool, len(ps))
	for _, p := range ps {
		if p != nil {
			if pid := p.CmdProcessPID(); pid > 0 {
				out[p] = children[pid]
			}
		}
	}
	return out
}

func (p *Tool) IsBusy() bool {
	pid := p.CmdProcessPID()
	if pid <= 0 {
		return false
	}
	return toolProcInfo().HasChildren(pid)
}

// ToolHooks carries the attention wiring StartTool applies before launching
// readPTY (race-free). A nil *ToolHooks disables attention for that tool.
type ToolHooks struct {
	OnAttention      func(id, reason string)
	OnAttentionClear func(id string)
	OnActivity       func(id, state, tool, detail string)
	AllowBell        bool
	// OnSize 는 PTY 크기가 바뀌었을 때 불린다 (M9_SRS FR-M9-3). 데몬이 그것을
	// size push 로 잇는다.
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
	p.applyHooks(hooks)
	return p
}

// applyHooks 는 주의·활동 배선을 옮겨 싣는다. OnSize 는 싣지 않는다 —
// PTY 가 있는 StartTool 만의 것이다. readPTY 가 돌기 전에 불러야 한다.
func (p *Tool) applyHooks(hooks *ToolHooks) {
	if hooks == nil {
		return
	}
	p.onAttention = hooks.OnAttention
	p.onAttentionClear = hooks.OnAttentionClear
	p.onActivity = hooks.OnActivity
	p.allowBell.Store(hooks.AllowBell)
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

// toolBinDir 은 이 인스턴스의 `bin` 이다. **모르면 빈 값**이다 — 상대경로를
// 만들지 않는다.
//
// 종전에는 `filepath.Join(os.Getenv(EnvHome), "bin")` 이었고, 그 변수가 비면
// 결과가 **`bin`** 이었다. 그 상대경로는 셸이 **도구의 cwd 기준으로** 풀므로
// 사용자의 저장소에 있는 같은 이름의 파일이 훅으로 실행될 수 있었고, PATH 에도
// 그 자리가 얹혔다. Windows 에서 PowerShell 이 그것을 모듈 이름으로 읽어 빨간
// 줄을 찍으면서 드러났다 (CI 실측 2026-09-16).
//
// 빈 값은 `platform.Shell` 이 훅 없이 띄우는 갈래로 간다 (`hookable`).
func toolBinDir() string {
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		return ""
	}
	return filepath.Join(home, dmenv.BinDir)
}

// toolPath 는 도구의 PATH 다. 자리를 모르면 **더하지 않는다** — 빈 조각을 얹으면
// 그 구분자 사이가 "현재 디렉터리" 로 읽힌다 (POSIX 규약).
func toolPath(binDir string) string {
	base := os.Getenv("PATH")
	if binDir == "" {
		return base
	}
	return base + string(os.PathListSeparator) + binDir
}

// bufMax 는 도구 출력 링(outbuf)의 상한이다 — 새로 붙는 클라이언트가 재생받는 창.
const bufMax = 1 << 20

// StartTool spawns a shell under a new PTY. Exported for tool manager + tests.
//
// place 는 **호스트 셸 대신 띄울 것**이다. 샌드박스 창의 도구가 대응 컨테이너
// 안에서 도는 것이 이 갈래다 (SANDBOX_WINDOW_SRS FR-SBX-12). nil 이면 종전대로
// 호스트 셸이며, 그때의 동작은 이 인자가 없던 때와 완전히 같다 (NFR-SBX-2).
//
// 완성된 명세를 받는 것이 요점이다. 그래야 toolhub 가 컨테이너도 프로파일도
// 알지 않는다 — invalidator·ownedProvider 와 같은 방향이다.
func StartTool(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *ToolHooks, place *platform.ProcSpec, extraEnv []string) (*Tool, error) {
	binDir := toolBinDir()

	// 셸 선택과 훅 주입 방식은 OS 마다 다르다. 그 차이는 platform.ShellProvider
	// 뒤에 있고, 여기서는 어느 셸인지 묻지 않는다 (CROSS_PLATFORM_SRS FR-XSH-6).
	sh := platform.Current().Shell.Shell(binDir)
	shell, shellArgs := sh.Path, sh.Args
	env := toolEnv(id, shell, binDir, sh.Env, extraEnv)
	startDir := toolStartDir(cwd)
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
	p := newToolOnTerm(id, name, term, place != nil, onExit, hooks)
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

// newToolOnTerm 은 터미널 하나에 도구를 세운다. 읽기 루프는 돌리지 않는다 — 호출자가
// 자리를 마저 적은 뒤 `go p.readPTY()` 한다. 새로 띄운 셸(StartTool)과 넘겨받은 셸
// (AdoptHandover, DAEMON_SESSION_KEEP_SRS FR-DSK-21)이 같은 배선을 지난다.
func newToolOnTerm(id, name string, term platform.Terminal, sandboxed bool, onExit func(string), hooks *ToolHooks) *Tool {
	p := &Tool{
		ID: id, Name: name,
		sandboxed: sandboxed,
		term:      term,
		stream:    outbuf.NewStream(bufMax),
		done:      make(chan struct{}),
	}
	// Set the base exit callback before readPTY starts (race-free). 출력 릴레이는
	// 데몬의 WireRelayOnce 가 단다.
	p.relay.Store(&toolRelay{onExit: onExit})
	p.applyHooks(hooks)
	if hooks != nil {
		p.onSize = hooks.OnSize
	}
	return p
}

// readPTY drains the PTY master, feeds the bounded stream buffer (single
// drop path: outbuf.Stream compaction → Stats.TotalBytesDrop), and hands each
// chunk to the output relay. On EOF/IO error — **and on panic** — it triggers
// a single kill() and signals the relay's onExit.
//
// 패닉 경로가 EOF 경로와 같은 이유 (M8 `GO-7`): 종전에는 recover 가 로그만
// 남기고 돌아갔다. 그러면 PTY fd 와 프로세스가 남고, 종료 통보가 나가지 않아
// 클라이언트가 재연결을 되풀이하며(무한 재연결의 조건), tools.json 에는 계속 기재된다 —
// 반죽음이다. 읽기 고루틴이 죽은 도구는 죽은 도구다.
func (p *Tool) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			dmlog.Errorf(nil, "[tool %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
			p.exitAfterRead()
		}
	}()
	defer p.markReadDone()
	raw := make([]byte, 8192)
	for {
		n, err := p.term.Read(raw)
		if errors.Is(err, platform.ErrFrozen) {
			p.parkWhileFrozen()
			continue
		}
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
		p.handleChunk(raw[:n])
	}
}

// handleChunk 는 읽은 청크 하나를 스트림·릴레이·관측으로 나른다.
// chunk 는 읽기 버퍼 그 자체이므로 보관하지 않는다.
func (p *Tool) handleChunk(chunk []byte) {
	// Single backpressure path: Stream.Feed never blocks; loss (if any)
	// is recorded in Stats.TotalBytesDrop. 락 순서는 언제나 cmu → stream.mu 다.
	r := p.relay.Load()
	relay := r != nil && r.onOutput != nil
	end, data := p.feedAndDeliver(chunk, relay)
	if relay {
		r.onOutput(p.ID, data, end)
	}
	c := classifyEsc(chunk, p.allowBell.Load())
	p.observeOutputClassified(chunk, attnNow(), c)
	p.observeModesClassified(chunk, c.modes)
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

// feedAndDeliver 는 청크를 스트림에 넣고, 릴레이가 있으면 릴레이에 줄 사본을 만든다.
//
// Feed 에는 읽기 버퍼를 **그대로** 넘긴다 — Stream 은 자기 버퍼에 복사하고 인자를
// 보관하지 않는다 (outbuf.Feed 의 계약, M8 `GO-37`). 청크당 사본은 하나다
// (FR-OPT-3-2, SHR-3): 릴레이는 data 를 보관할 수 있으므로(데몬의 push 큐) 이 사본은
// 다시 쓰지 않는다. 릴레이가 없으면 만들지 않는다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-41).
func (p *Tool) feedAndDeliver(chunk []byte, relay bool) (end int64, data []byte) {
	p.cmu.Lock()
	defer p.cmu.Unlock()
	_, end = p.stream.Feed(chunk)
	if !relay {
		return end, nil
	}
	return end, append([]byte(nil), chunk...)
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
