package toolhub

import (
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/uuid"
)

// ToolManager — 도구 레지스트리.
//
// 이 파일이 대답하는 질문은 **"도구가 몇 개이고, 누가 그것을 찾고 만들고
// 지우는가"** 다. 도구 하나의 내부(PTY·방송·종료)는 tool.go 가 갖는다.
//
// 주의 알림 스위퍼와 활동 스냅숏이 여기 있는 이유는 그것들이 **전체를 훑는**
// 동작이기 때문이다 — 도구 하나로는 답이 나오지 않는다.

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
		allowBell:     AttentionAllowBell(),
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

// SetBackgroundChanged 는 백그라운드 목록 변화의 수신자를 꽂는다 (FR-BGP-2).
func (m *ToolManager) SetBackgroundChanged(f func()) {
	m.mu.Lock()
	m.bgChanged = f
	m.mu.Unlock()
}

// notifyBackground 는 수신자를 잠금 밖에서 부른다 — 수신자가 SSE 브로드캐스트를
// 하며, 그 안에서 다시 이 매니저를 물을 수 있다 (`BackgroundList`). 잠금을 쥔 채
// 부르면 그 자리에서 잠긴다.
func (m *ToolManager) notifyBackground() {
	m.mu.RLock()
	f := m.bgChanged
	m.mu.RUnlock()
	if f != nil {
		f()
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
type Placement struct {
	// WindowUUID 는 대응 컨테이너의 키다.
	WindowUUID string
	// Profile 이 비어 있으면 일반 창이며, 도구는 호스트에서 돈다.
	Profile string

	// Work 는 이 창이 고른 **작업 방식**이다 — "mount" · "copy" · "none"
	// (UX_BATCH6_SRS FR-SBM-3). 비거나 모르는 값이면 프로파일의 것을 쓴다.
	//
	// 프로파일이 아니라 여기 있는 이유는 그것이 **이번 창의 선택**이기
	// 때문이다. 같은 프로파일로 어떤 창은 마운트하고 어떤 창은 복사한다.
	Work string

	// Command 는 **로그인 셸 대신 띄울 명령**이다 (UX_BATCH6_SRS FR-BGP-3).
	//
	// 비면 종전대로 대화형 셸이며, 그때의 동작은 이 필드가 없던 때와 완전히
	// 같다. 명령이 있으면 그 프로세스가 곧 이 도구의 수명이다 — 끝나면 도구가
	// 죽고, 죽으면 백그라운드 목록에서 사라진다 (FR-BGP-4). "명령이 끝났다" 를
	// 따로 감지하는 자리는 없다.
	//
	// 샌드박스 프로파일과 함께 쓰지 않는다. 컨테이너 안에서 무엇을 띄울지는
	// 그쪽 명세가 정하며, 둘이 동시에 참이면 어느 쪽이 이기는지 말할 수 없다.
	Command string

	// 아래 둘은 **ToolManager 가 채운다.** 호출자는 건드리지 않는다 — 도구
	// 식별자는 여기서 만들어지고, 작업 디렉터리는 Create 의 인자이므로 바깥에서
	// 다시 실어 보낼 이유가 없다.
	HostDir string
	ToolID  string
}

// Create spawns a new tool.
// ToolCap 은 동시에 살아 있는 도구 수의 상한이다 (04-secops P1-4).
//
// 도구 하나는 PTY 와 로그인 셸 프로세스다. 상한이 없으면 요청 수천 개가 프로세스
// 테이블과 메모리를 소진한다. 진입점이 셋이라(`POST /api/tools`·`GET /ws`(tool
// 생략)·`POST /api/tools/headless`) 어느 하나만 막아서는 뜻이 없고, 그래서
// **만드는 자리 한 곳**에서 센다.
//
// 256 은 사람이 여는 수보다 한참 크고 자원을 소진하는 수보다 한참 작다. 에이전트가
// 도구를 여는 배치를 감안해도 그 사이가 넓다.
const ToolCap = 256

// ErrToolCap 은 상한 초과다. 핸들러는 이것을 429 로 옮긴다 — 500 이면 클라이언트가
// 서버 결함으로 읽고 재시도하며, 재시도가 곧 이 상황을 만든 것이다.
var ErrToolCap = errors.New("도구 수가 상한에 이르렀다")

func (m *ToolManager) Create(cwd string, cols, rows uint16, place Placement) (*Tool, error) {
	// FR-UNI-7: toolId 는 uuid 다. 카운터는 영속되지 않아 모든 도구가 닫힌 상태로
	// 재기동하면 "1" 부터 재사용됐다 (SRS §2.7 (3)).
	// FR-UNI-8: 표시명은 id 와 분리한다 — 구분은 좌표와 cwd 가 담당한다.
	//
	// 배치보다 **먼저** 만든다. 컨테이너 안 도구도 자기 식별자를 환경으로 받아야
	// dmctl 이 자신을 서버에 알릴 수 있다 (FR-SBX-16).
	id := uuid.NewString()
	// 작업 디렉터리는 **그대로** 넘긴다. 실재 여부의 판정과 사유 보고는 배치기가
	// 한다 (FR-SBX-41) — 여기서 조용히 걸러 내면 사용자가 고른 폴더가 왜 안
	// 붙었는지 알 수 없다.
	place.HostDir, place.ToolID = cwd, id

	// 배치는 레지스트리 잠금 **밖에서** 정한다. 컨테이너를 만들고 시작하는 데
	// 수 초가 걸릴 수 있고, 그동안 도구 목록 조회까지 막을 이유가 없다.
	spec, err := m.placement(place)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	// **잠금 안에서, 그리고 기동 전에** 센다 (04-secops P1-4).
	//
	// 잠금 밖에서 세면 동시 요청 여럿이 같은 값을 보고 함께 통과한다 — 상한이
	// 있는데 넘는 상태가 정확히 그렇게 생긴다. `StartTool` 뒤에 세면 이미 뜬
	// PTY 와 셸이 등록되지 못한 채 남는다.
	if len(m.tools) >= ToolCap {
		log.Printf("[tool] 상한 초과로 생성을 거절한다 (cap=%d)", ToolCap)
		return nil, ErrToolCap
	}
	p, err := StartTool(id, defaultToolName, cwd, cols, rows, func(toolID string) {
		m.Delete(toolID)
		if m.invalidator != nil {
			m.invalidator(toolID)
		}
	}, m.attnHooks(), spec)
	if err != nil {
		log.Printf("[tool %s] create error: %v", id, err)
		return nil, err
	}
	// FR-BGP-3 / FR-SBX-27: `sandboxed` 는 "컨테이너 안에서 돈다" 이지 "명세를
	// 받았다" 가 아니다. `StartTool` 은 명세 유무만 보므로, 명령으로 띄운 도구가
	// 샌드박스로 오인되어 백그라운드로 갈 수 없게 된다 — 그 도구는 백그라운드에
	// 살라고 만든 것이다.
	p.sandboxed = place.Profile != ""
	m.tools[id] = p
	log.Printf("[tool %s] registered total=%d", id, len(m.tools))
	m.mutated.Store(true)
	m.saveAsync()
	return p, nil
}

// SetPlacer 는 배치 결정자를 꽂는다. 배선에서 한 번 불린다.
func (m *ToolManager) SetPlacer(f func(Placement) (*platform.ProcSpec, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.placer = f
}

// placement 는 이 Window 의 도구를 띄울 명세다. nil 이면 호스트 셸이다.
//
// Window 가 지정되지 않았으면 결정자를 묻지도 않는다 — 샌드박스가 아닌 창의
// 경로가 이 기능 도입 전과 완전히 같아야 한다 (NFR-SBX-2).
func (m *ToolManager) placement(place Placement) (*platform.ProcSpec, error) {
	if place.Profile == "" {
		// FR-BGP-3: 셸 대신 명령. 셸을 띄우고 그 안에 타이핑하는 대신 명령
		// 자체를 도구의 프로세스로 세운다 — 그래야 그 명령의 끝이 도구의 끝이다.
		if place.Command == "" {
			return nil, nil
		}
		argv := platform.Current().Shell.RunCommand(place.Command)
		if len(argv) == 0 {
			return nil, fmt.Errorf("이 호스트의 셸에서 명령을 실행할 방법을 알지 못합니다")
		}
		return &platform.ProcSpec{Path: argv[0], Args: argv}, nil
	}
	m.mu.RLock()
	f := m.placer
	m.mu.RUnlock()
	// 프로파일이 있는데 배치기가 없으면 **실패한다.** 여기서 호스트 셸로
	// 내려가면 사용자는 격리된 줄 알고 호스트에서 일하게 된다 (FR-SBX-21).
	if f == nil {
		return nil, fmt.Errorf("샌드박스 창(%s)이지만 컨테이너 배치가 구성되지 않았습니다", place.Profile)
	}
	return f(place)
}

func (m *ToolManager) Restore(id, name, cwd string, cols, rows uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := StartTool(id, name, cwd, cols, rows, func(toolID string) {
		m.Delete(toolID)
		if m.invalidator != nil {
			m.invalidator(toolID)
		}
	}, m.attnHooks(), nil)
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

// Delete 는 도구를 지운다. **없으면 `ErrToolNotFound` 다** (`GO-8`).
//
// 종전에는 반환이 없어서 데몬 IPC 가 언제나 성공으로 답했다. 이미 없는 것을
// 지우는 일이 정상인 호출자도 있으므로 여기서는 사실만 주고 판단은 넘긴다.
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
		log.Printf("[tool %s] deleted remaining=%d", id, remaining)
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

// IsDaemon reports false: ToolManager is direct mode, not daemon-backed.
func (m *ToolManager) IsDaemon() bool { return false }
