package toolhub

import (
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmlog"

	"dongminal/internal/shared/platform"
)

// ToolManager — 도구 레지스트리.
//
// 이 파일이 대답하는 질문은 **"도구가 몇 개이고, 누가 그것을 찾고 만들고
// 지우는가"** 다. 도구 하나의 내부(PTY·방송·종료)는 tool.go 가 갖는다.
//
// 주의 알림 스위퍼와 활동 스냅숏이 여기 있는 이유는 그것들이 **전체를 훑는**
// 동작이기 때문이다 — 도구 하나로는 답이 나오지 않는다.

// startToolFunc 는 StartTool 의 모양이다. ToolManager 가 필드로 드는 이유는
// 테스트가 기동을 가짜로 바꿔 잠금 규약(Create 가 잠금 밖에서 띄운다)을 판정하기
// 위해서다 — 패키지 전역을 바꿔 끼우면 t.Parallel 을 막는다 (M8 `GO-42`).
type startToolFunc func(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *ToolHooks, place *platform.ProcSpec, extraEnv []string) (*Tool, error)

type ToolManager struct {
	mu    sync.RWMutex
	tools map[string]*Tool
	// pending 은 예약됐으나 아직 등록되지 않은 도구 수다 — Create 가 잠금 밖에서
	// 띄우는 동안 상한(ToolCap)이 그 자리를 세게 한다 (M8 `GO-29`).
	pending   int
	startTool startToolFunc

	dataDir     string
	invalidator func(toolID string)

	// ownedProvider 는 "어떤 도구가 상위 도메인의 소유인가" 를 답한다 (FR-HLM-3).
	// toolhub 는 Run 을 알지 못하며 알아서도 안 되므로(의존 방향), 판별은 위에서
	// 꽂는다 — invalidator 와 같은 형태다. nil 이면 아무도 소유하지 않는 것이고,
	// 그때 동작은 이 필드가 없던 때와 **완전히 같다**.
	ownedProvider func() map[string]struct{}

	// placer 는 "이 Window 의 도구를 어디에 띄우는가" 를 답한다
	// (SANDBOX_WINDOW_SRS FR-SBX-10). nil 이면 모든 도구가 호스트에서 돈다.
	//
	// ownedProvider·invalidator 와 같은 방향이다 — toolhub 는 컨테이너도
	// 프로파일도 알지 않으며, 완성된 명세만 받는다.
	placer func(Placement) (*platform.ProcSpec, error)

	// bgChanged 는 **아무도 부탁하지 않은 백그라운드 목록의 변화**를 위층에
	// 알린다 — 곧 도구 프로세스의 죽음이다 (UX_BATCH6_SRS FR-BGP-1·2).
	// invalidator·placer 와 같은 방향이다: toolhub 는 SSE 도 브라우저도 알지
	// 않으며 사실만 낸다.
	//
	// 사용자가 부탁한 변화(보냄·되돌림)는 이 훅이 아니라 HTTP 종단이 알린다 —
	// 그쪽에는 두 모드가 공유하는 한 자리가 있고, 이 훅은 데몬 모드에서 구독자
	// 없는 프로세스에서 돈다.
	bgChanged func()

	// mutated 는 **기동 후 한 번이라도 상태가 바뀌었는가** 다. 한 번 서면 내려오지
	// 않으며, 그것이 이 값의 뜻이다 (FR-CAF-13).
	//
	// 종전 이름은 `dirty` 였다. 그 이름은 "미저장 변경이 있다" 로 읽히고, 그렇게
	// 읽으면 SaveAll 이 이것을 내리지 않는 것이 버그로 보인다 — 실제로 그 오해가
	// 테스트에 `// BUG:` 주석으로 박혀 있었다. 동작은 처음부터 옳았다: SaveAll 의
	// 가드가 막으려는 것은 **아무 일도 없던 실행이 기존 사용자 파일을 빈 상태로
	// 덮는 것**이며(persist.go), 그 판정에 필요한 것이 정확히 "기동 후 변경 여부"다.
	mutated atomic.Bool

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

	// saveFile 은 SaveAll 을 한 줄로 세운다 (FR-CAF-12). saveMu 와 지키는 것이
	// 다르다 — 저쪽은 "저장을 더 시작할 것인가"(noSave·WaitGroup)를, 이쪽은
	// "디스크에 닿는 순서"를 지킨다. 하나로 합치면 StopSaving 이 진행 중인
	// 저장을 기다리는 동안 문을 닫지 못한다.
	saveFile sync.Mutex

	// Attention (PANE_ATTENTION_NOTIFY_SRS): idleThreshold/allowBell configure
	// detection; attnNotify/attnClear bridge transitions to SSE (set via
	// SetAttentionNotifier from the composition root).
	idleThreshold  int64 // nanos, 0 disables L2
	allowBell      bool
	attnNotify     func(id, reason string)
	attnClear      func(id string)
	activityNotify func(id, state, tool, detail string)
	outputObserver func(id string, data []byte, end int64)
	exitObserver   func(id string, info ExitInfo)

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

	// 크기 통보 (M9_SRS FR-M9-3). `fgNotify` 와 같은 모양이고 같은 이유로
	// 잠금 아래 있다 — 데몬의 PanedServer 가 연결마다 다시 걸기 때문이다.
	szMu     sync.Mutex
	szNotify func(id string, cols, rows uint16)
}

// BackgroundEntry는 백그라운드 도구 한 건의 조회 결과다 (FR-BG-6).
type BackgroundEntry struct {
	ToolID string `json:"toolId"`
	Name   string `json:"name"`
	Cwd    string `json:"cwd"`
	Since  int64  `json:"since"`
	// Kind 는 도구의 종류다 (M8_UNIFIED_SRS FR-ABG-1) — 되살릴 때 어느 뷰의 탭으로
	// 돌아가는가. 비어 있으면 터미널.
}

// NewToolManager builds an empty manager. dataDir is where tools.json lives;
// invalidator is called whenever a tool dies so the workspace layer can prune
// its references (may be nil in tests).
func NewToolManager(dataDir string, invalidator func(string)) *ToolManager {
	return &ToolManager{
		tools:         make(map[string]*Tool),
		startTool:     StartTool,
		dataDir:       dataDir,
		invalidator:   invalidator,
		idleThreshold: int64(AttentionIdleThreshold()),
		allowBell:     AttentionAllowBell(),
	}
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

// Placement 는 도구를 어느 Window 의 어떤 자리에 띄우는가다 (FR-SBX-10/11).
//
// 프로파일을 **함께 받는** 것이 요점이다. Window UUID 만 받고 프로파일을
// workspace 에서 조회하면, 브라우저가 창을 저장하기 전에 탭을 만드는 순간
// 샌드박스 창이 일반 창으로 읽혀 호스트에서 뜬다 — 조용한 강등이다 (§2.3).

func (m *ToolManager) Get(id string) *Tool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tools[id]
}

func (m *ToolManager) List() []ToolInfo {
	// 전경 이름은 m.mu 를 잡기 전에 구한다 (FR-TAN-7/8). 자체 캐시가 있어
	// 목록 요청이 잦아도 조회 주기는 fgRefreshInterval 로 묶여 있다.
	fg := m.ForegroundNames()
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []ToolInfo
	for _, p := range m.tools {
		cols, rows := 0, 0
		if c, r, ok := p.Size(); ok {
			cols, rows = int(c), int(r)
		}
		out = append(out, ToolInfo{
			ID: p.ID, Name: p.Name, PID: p.CmdProcessPID(),
			Cols: cols, Rows: rows, FgName: fg[p.ID],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ListOK 는 직접 모드에서 언제나 안다 (FR-TLU-3) — 목록이 이 프로세스에 있다.
func (m *ToolManager) ListOK() ([]ToolInfo, bool) { return m.List(), true }

// Connected 는 직접 모드에서 언제나 참이다 — 레지스트리가 이 프로세스에 있다.
func (m *ToolManager) Connected() bool { return true }

// Daemon 은 직접 모드에서 nil 이다 — 프로세스 경계가 없다.
func (m *ToolManager) Daemon() DaemonHub { return nil }

// Delete 는 도구를 지운다. **없으면 `ErrToolNotFound` 다** (`GO-8`).
//
// 종전에는 반환이 없어서 데몬 IPC 가 언제나 성공으로 답했다. 이미 없는 것을
// 지우는 일이 정상인 호출자도 있으므로 여기서는 사실만 주고 판단은 넘긴다.
// Terminate 는 정중한 종료 뒤의 Delete 다 (FR-BGK-7, ToolHub 참조).
func (m *ToolManager) Terminate(id string, grace time.Duration) error {
	p := m.Get(id)
	if p == nil {
		return ErrToolNotFound
	}
	p.terminateWait(grace)
	return m.Delete(id)
}

func (m *ToolManager) Delete(id string) error {
	m.mu.Lock()
	p := m.tools[id]
	delete(m.tools, id)
	// UX_BATCH6_SRS FR-BGP-1: 백그라운드 목록은 **살아 있는 프로세스의 목록**이다.
	// 지우는 것은 종전과 같고, 달라진 것은 그 사실을 알린다는 점이다.
	_, wasBg := m.background[id]
	delete(m.background, id)
	remaining := len(m.tools)
	m.mu.Unlock()
	if p != nil {
		p.kill()
		dmlog.Infof(nil, "[tool %s] deleted remaining=%d", id, remaining)
	}
	m.mutated.Store(true)
	m.saveAsync()
	if wasBg {
		m.notifyBackground()
	}
	// 없던 것을 지운 것도 **사실대로** 말한다. 정리(목록·배경·저장)는 그대로
	// 도는데, 그것은 남은 찌꺼기를 치우는 일이라 대상이 없어도 해가 없다.
	if p == nil {
		return ErrToolNotFound
	}
	return nil
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
