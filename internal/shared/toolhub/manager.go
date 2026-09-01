package toolhub

import (
	"log"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

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
