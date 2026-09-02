package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

var ErrStale = errors.New("workspace: stale revision")

// ErrLabelIdentifier 는 ResolveStrict 가 좌표 라벨 형태의 입력을 거부했다는 표시다
// (FR-IDU-2). 호출자는 errors.Is 로 이것을 갈라 "잘못 불렀다"(400)를 "없다"(404)와
// 구분한다. 메시지 자체가 진단의 마지막 줄이다.
//
// 진단문의 끝 문장이므로 마침표가 있는 것이 옳다 (errLabelRejected 가 %w 로 이것을
// 문단 끝에 놓는다).
//
//lint:ignore ST1005 이것은 감싸일 오류 조각이 아니라 **사람이 읽을 마지막 줄**이다.
var ErrLabelIdentifier = errors.New(
	"uuid 는 `dmctl list-workspace` 의 uuid= 컬럼, 또는 생성 명령(new-tab/split-*)의 응답에 있다.")

// ErrSchemaTooOld는 workspace.json 이 v2 미만일 때 반환된다 (FR-EM-2a).
// 구 스키마를 빈 workspace 와 구별할 수 없으므로 조용히 넘기지 않고
// 명시적으로 실패한다 — 방치하면 브라우저가 빈 상태를 저장해 덮어쓴다.
var ErrSchemaTooOld = errors.New("workspace: schemaVersion 이 2 미만입니다 — `dongminal migrate` 를 먼저 실행하세요")

// SchemaVersion은 이 코드가 읽고 쓰는 workspace.json 스키마 버전이다.
const SchemaVersion = 2

type TabEntry struct {
	ToolID     string
	Label      string
	WindowName string
	TabName    string
	IsActive   bool

	// Entity identity (UUID_IDENTITY_SRS Phase 1, FR-UID-6/7). Empty when the
	// upstream workspace.json predates the schema; consumers must tolerate that.
	WindowUUID string
	PaneUUID   string
	TabUUID    string
	ShortCode  string
}

type Liveness interface {
	IsLive(toolID string) bool
}

type Persister interface {
	Read() ([]byte, error)
	Write(data []byte) error
}

type index struct {
	entries   []TabEntry
	labels    map[string]string
	labelToID map[string]string
	tabIDs    map[string]struct{}
	// uuidToID maps a tab's UUID (lower-case canonical form) to its toolId.
	// Stable across label reflows: closing other sessions/regions does not
	// shift the uuid->toolId binding (UUID_IDENTITY_SRS TC-UID-2).
	uuidToID map[string]string
}

// snap is the coherent (raw, rev) pair published atomically by Save.
type snap struct {
	raw []byte
	rev uint64
}

type Manager struct {
	live  Liveness
	store Persister

	mu   sync.Mutex
	snap atomic.Pointer[snap]
	idx  atomic.Pointer[index]

	// OnIndexUpdate, when non-nil, runs synchronously after the in-memory index
	// is replaced (initial load + every Save). Use it to reconcile satellite
	// stores (e.g., mdscroll) against the current set of tabs.
	OnIndexUpdate func()

	writeCh    chan []byte
	done       chan struct{}
	wg         sync.WaitGroup
	closedOnce sync.Once
}

func New(live Liveness, store Persister) (*Manager, error) {
	m := &Manager{
		live:    live,
		store:   store,
		writeCh: make(chan []byte, 1),
		done:    make(chan struct{}),
	}
	data, err := store.Read()
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("workspace read: %w", err)
		}
		data = nil
	}
	buf := append([]byte(nil), data...)
	m.snap.Store(&snap{raw: buf, rev: 0})
	ix, perr := buildIndex(buf)
	if perr != nil {
		// 버전 미달은 치명적이다 — 계속 진행하면 브라우저가 빈 상태를
		// 저장해 사용자 워크스페이스를 덮어쓴다 (FR-EM-2a).
		if errors.Is(perr, ErrSchemaTooOld) {
			return nil, perr
		}
		// 파싱 불가 파일은 기존 동작 유지 (NFR-EM-3).
		ix = emptyIndex()
	}
	m.idx.Store(ix)
	// Note: OnIndexUpdate is not yet wired at construction time; callers invoke
	// the initial reconcile manually after assigning the hook (see main.go).
	m.wg.Add(1)
	go m.writer()
	return m, nil
}

// writer drains writeCh serially. Latest-wins coalescing is enforced by Save
// via the size-1 buffer: concurrent Saves overwrite any queued-but-not-yet-
// picked blob, so disk writes collapse when the producer outruns the disk.
func (m *Manager) writer() {
	defer m.wg.Done()
	for {
		select {
		case blob := <-m.writeCh:
			if err := m.store.Write(blob); err != nil {
				log.Printf("workspace async write: %v", err)
			}
		case <-m.done:
			// drain pending (at most 1) and exit
			for {
				select {
				case blob := <-m.writeCh:
					if err := m.store.Write(blob); err != nil {
						log.Printf("workspace async write (flush): %v", err)
					}
				default:
					return
				}
			}
		}
	}
}

// enqueueWrite publishes blob with latest-wins semantics: never blocks the
// caller, drops any previously-queued-but-unpicked blob.
func (m *Manager) enqueueWrite(blob []byte) {
	for {
		select {
		case m.writeCh <- blob:
			return
		default:
			select {
			case <-m.writeCh:
			default:
			}
		}
	}
}

// Close stops the writer goroutine after flushing any pending blob. Safe to
// call multiple times; subsequent Saves still update in-memory state but their
// blobs will not reach disk.
func (m *Manager) Close() error {
	m.closedOnce.Do(func() {
		close(m.done)
		m.wg.Wait()
	})
	return nil
}

// Snapshot returns a coherent (raw, rev) pair from the same Save transaction.
// raw is shared (do not mutate). rev=0 indicates no Save has occurred.
func (m *Manager) Snapshot() ([]byte, uint64) {
	p := m.snap.Load()
	if p == nil {
		return nil, 0
	}
	return p.raw, p.rev
}

func (m *Manager) CurrentRev() uint64 {
	_, rev := m.Snapshot()
	return rev
}

func (m *Manager) Raw() []byte {
	raw, _ := m.Snapshot()
	return raw
}

func (m *Manager) Save(blob []byte, ifMatch string) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur := uint64(0)
	if p := m.snap.Load(); p != nil {
		cur = p.rev
	}
	if ifMatch != "" {
		want, err := strconv.ParseUint(ifMatch, 10, 64)
		if err != nil || want != cur {
			return 0, ErrStale
		}
	}
	ix, err := buildIndex(blob)
	if err != nil {
		return 0, fmt.Errorf("workspace parse: %w", err)
	}
	buf := append([]byte(nil), blob...)
	newRev := cur + 1
	m.snap.Store(&snap{raw: buf, rev: newRev})
	m.idx.Store(ix)
	m.enqueueWrite(buf)
	// OnIndexUpdate is called under m.mu. Callers MUST NOT re-enter the
	// Manager (e.g. call Save, Snapshot, Resolve, or any method that
	// acquires m.mu) or a deadlock will occur.
	if m.OnIndexUpdate != nil {
		m.OnIndexUpdate()
	}
	return newRev, nil
}

// Resolve translates an identifier into a live toolId. Per FR-UNI-10 the kind of
// identifier is decided by lookup result, never by its shape — toolId is a uuid
// since 묶음 U, so a numeric/36-char test would reject live tools (SRS §2.7).
//
// 순서: 살아있는 toolId → 엔터티 uuid 인덱스 → 좌표 라벨 인덱스 → 실패.
func (m *Manager) Resolve(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(errEmptyID)
	}
	ix := m.idx.Load()
	// 1·2) 살아있는 toolId → 엔터티 uuid. 두 해석기가 공유한다.
	if pid, done, err := m.resolveEntity(ix, id); done {
		return pid, err
	}
	// 3) 좌표 라벨인가.
	if ix != nil {
		norm := strings.ToUpper(id)
		if pid, ok := ix.labelToID[norm]; ok {
			if !m.live.IsLive(pid) {
				return "", fmt.Errorf(errDanglingLabel, norm, pid)
			}
			return pid, nil
		}
	}
	return "", unresolvedError(ix, id)
}

// ResolveStrict translates an identifier into a live toolId **without accepting
// coordinate labels** (ORCHESTRATION_V2_SRS FR-IDU-1).
//
// Resolve 와 갈라지는 이유: 라벨(W1.P2.T1)은 창·분할 칸이 닫히면 다시 계산되므로,
// 에이전트가 라벨로 팀원을 부르면 사용자가 창 하나를 닫는 순간 **다른 도구에게**
// 메시지가 간다. 레이아웃 명령은 화면 위치가 곧 대상이라 라벨이 자연스럽지만,
// 접합면(read-screen·send-input·msg·status·wait)은 그렇지 않다.
//
// 순서: 살아있는 toolId → 엔터티 uuid 인덱스 → 실패. 라벨 형태의 입력은
// ErrLabelIdentifier 를 감싼 전용 진단으로 갈린다 (FR-IDU-2). 그 밖의 실패
// 문안은 Resolve 와 같다 (FR-IDU-3 행위 보존).
func (m *Manager) ResolveStrict(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(errEmptyID)
	}
	ix := m.idx.Load()
	// 1·2) 살아있는 toolId → 엔터티 uuid. Resolve 와 같은 사다리다.
	if pid, done, err := m.resolveEntity(ix, id); done {
		return pid, err
	}
	// 라벨 인덱스는 조회하지 않는다. 형태 판정이 조회 뒤에 오므로 라벨과 같은
	// 문자열의 uuid·toolId 가 있으면 그쪽이 이긴다 (FR-UNI-10 보존).
	if isLabelForm(id) {
		return "", fmt.Errorf(errLabelRejected, id, ErrLabelIdentifier)
	}
	return "", unresolvedError(ix, id)
}

// 해석 실패 문안이다. Resolve 와 ResolveStrict 가 같은 문안을 내야 하는데
// (FR-IDU-3 행위 보존), 복제로 지키면 한쪽만 고쳐도 컴파일이 통과하고 그때
// 조용히 갈라진다. 한 자리에 모아 그 가능성을 없앤다.
const (
	errEmptyID       = "빈 id"
	errDanglingTabID = "tab id %s 은 toolId=%s 가리키지만 도구가 존재하지 않음"
	errDanglingLabel = "라벨 %s 은 toolId=%s 가리키지만 도구가 존재하지 않음"
	errUnknownToolID = "toolId=%s 존재하지 않음"
	errUnresolvedID  = "id 해석 실패: %s (list_workspace 로 확인)"
	errLabelRejected = "좌표 라벨(%s)은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.\n" +
		"라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.\n%w"
)

// resolveEntity 는 두 해석기가 공유하는 사다리 1·2단계다 — 살아있는 toolId 인가,
// 아니면 엔터티(창·분할 칸·탭) uuid 인가. 형태는 보지 않고 조회 결과가 정한다
// (FR-UNI-10).
//
// done=true 면 (toolID, err) 가 최종 결과다. false 면 이 단계에서 답이 나오지
// 않았다는 뜻이며, 그 뒤는 해석기마다 갈린다.
func (m *Manager) resolveEntity(ix *index, id string) (string, bool, error) {
	if m.live.IsLive(id) {
		return id, true, nil
	}
	if ix != nil {
		if pid, ok := ix.uuidToID[strings.ToLower(id)]; ok {
			if !m.live.IsLive(pid) {
				return "", true, fmt.Errorf(errDanglingTabID, id, pid)
			}
			return pid, true, nil
		}
	}
	return "", false, nil
}

// unresolvedError 는 사다리를 다 내려온 뒤의 진단이다. 인덱스에 toolId 로 보이면
// "없어진 도구"이고, 그렇지 않으면 아예 알 수 없는 id 다 (FR-UNI-12).
func unresolvedError(ix *index, id string) error {
	if isKnownToolID(ix, id) {
		return fmt.Errorf(errUnknownToolID, id)
	}
	return fmt.Errorf(errUnresolvedID, id)
}

// labelForm 은 좌표 라벨의 형태다 (FR-IDU-2). 대소문자를 가리지 않는다.
var labelForm = regexp.MustCompile(`(?i)^W\d+\.P\d+\.T\d+$`)

// isLabelForm 은 ResolveStrict 의 진단 메시지를 고르는 데에만 쓴다. 해석에 쓰면
// FR-UNI-10(해석은 조회 결과가 정한다)이 깨진다.
func isLabelForm(s string) bool { return labelForm.MatchString(s) }

// isKnownToolID reports whether id appears as a tab's toolId in the current
// tree. FR-UNI-12: 형태가 아니라 인덱스로 판정하며, 진단 메시지에만 쓴다.
func isKnownToolID(ix *index, id string) bool {
	if ix == nil {
		return false
	}
	for _, pid := range ix.uuidToID {
		if pid == id {
			return true
		}
	}
	return false
}

// CoordinateOf translates an identifier into the canonical positional
// coordinate "W{n}.P{n}.T{n}" that the browser command pipeline parses. Only
// UUID inputs are rewritten — coordinate, toolId, label, and empty inputs are
// returned unchanged (NFR-UID-0 행위 보존). Used by /api/commands and
// workspace_command so dmctl and MCP accept UUID anywhere a location is
// expected.
func (m *Manager) CoordinateOf(id string) (string, error) {
	if id == "" {
		return id, nil
	}
	ix := m.idx.Load()
	var toolID string
	if ix != nil {
		if pid, ok := ix.uuidToID[strings.ToLower(id)]; ok {
			toolID = pid
		}
	}
	if toolID == "" {
		// FR-UNI-11 2번: 살아있는 toolId 는 pass-through 다. toolId 가 uuid 가 된
		// 뒤로는 이 분기가 없으면 아래 stale 판정에 걸려 location=<toolId> 가
		// 전부 거절된다 (SRS §2.7).
		if m.live.IsLive(id) {
			return id, nil
		}
		if isUUIDForm(id) {
			// 36자 UUID 형식인데 인덱스에도 없고 살아있는 도구도 아니면 stale
			// uuid — 명시적 에러. FR-UNI-12: 형태 검사는 여기(진단)에만 남는다.
			return "", fmt.Errorf("id 해석 실패: %s (list_workspace 로 확인)", id)
		}
		// 좌표/라벨/구 정수 toolId/그 외 식별자는 pass-through (NFR-UID-0 행위 보존).
		return id, nil
	}
	if !m.live.IsLive(toolID) {
		return "", fmt.Errorf("tab id %s 은 toolId=%s 가리키지만 도구가 존재하지 않음", id, toolID)
	}
	if label, ok := ix.labels[toolID]; ok {
		return label, nil
	}
	return "", fmt.Errorf("tab id %s 은 toolId=%s 가리키지만 label 매핑 없음", id, toolID)
}

// IsKnownTabID reports whether id matches a tab.id present in the current
// workspace index (case-insensitive). Used by API entry points to enforce the
// "location must be a list-workspace uuid" policy (FR-DMC-9/10).
func (m *Manager) IsKnownTabID(id string) bool {
	if id == "" {
		return false
	}
	ix := m.idx.Load()
	if ix == nil {
		return false
	}
	_, ok := ix.uuidToID[strings.ToLower(id)]
	return ok
}

// isUUIDForm checks the canonical 8-4-4-4-12 hex shape without validating that
// every character is hex — Resolve will fail on lookup anyway, and a strict
// hex check here would block legitimate non-UUID inputs that happen to share
// the length (rare in practice but the looser check stays composable).
func isUUIDForm(s string) bool {
	if len(s) != 36 {
		return false
	}
	return s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

func (m *Manager) Labels() map[string]string {
	ix := m.idx.Load()
	if ix == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(ix.labels))
	for k, v := range ix.labels {
		out[k] = v
	}
	return out
}

// TabIDs returns the set of tab ids currently present in the workspace.
// Returned map is a copy; safe to mutate.
func (m *Manager) TabIDs() map[string]struct{} {
	ix := m.idx.Load()
	if ix == nil {
		return map[string]struct{}{}
	}
	out := make(map[string]struct{}, len(ix.tabIDs))
	for k := range ix.tabIDs {
		out[k] = struct{}{}
	}
	return out
}

func (m *Manager) Entries() []TabEntry {
	ix := m.idx.Load()
	if ix == nil {
		return nil
	}
	out := make([]TabEntry, len(ix.entries))
	copy(out, ix.entries)
	return out
}

func (m *Manager) InvalidateTool(toolID string) {
	// Labels are positional (derived from workspace.json). Tool death doesn't
	// shift labels; liveness is queried via Liveness at Resolve time. Kept as
	// an explicit hook so callers (onExit) can signal the manager without
	// caring about current semantics.
	_ = toolID
}

// ── workspace.json parsing ──────────────────────────

type WsLayout struct {
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	Tabs      []WsTab     `json:"tabs,omitempty"`
	ActiveTab string      `json:"activeTab,omitempty"`
	Direction string      `json:"direction,omitempty"`
	Children  []*WsLayout `json:"children,omitempty"`
}

type WsTab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ToolID string `json:"toolId"`
	// RunID는 이 탭의 도구를 소유한 Run (FR-EM-17 접합면). 비어 있으면
	// 어느 Run 에도 속하지 않는다 — 사람이 직접 만든 도구의 정상 상태다.
	RunID string `json:"runId,omitempty"`
}

type wsWindow struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Layout      *WsLayout `json:"layout"`
	FocusedPane string    `json:"focusedPane"`
	// OwnerRunID는 이 Window 를 전용으로 만든 Run (Projection
	// dedicated-window). 비어 있으면 사용자 소유 Window 다 (FR-EM-17).
	OwnerRunID string `json:"ownerRunId,omitempty"`
}

type wsState struct {
	SchemaVersion int        `json:"schemaVersion"`
	Windows       []wsWindow `json:"windows"`
	ActiveWindow  string     `json:"activeWindow"`
}

func emptyIndex() *index {
	return &index{
		labels:    map[string]string{},
		labelToID: map[string]string{},
		tabIDs:    map[string]struct{}{},
		uuidToID:  map[string]string{},
	}
}

// decodeState 는 저장된 blob 을 상태로 되돌린다. 파싱과 **스키마 버전 판정**의
// 유일한 자리다 (FR-EM-2a).
//
// 한 자리인 것이 요점이다. 판정이 두 곳에 흩어져 있으면 한쪽만 갱신해도 컴파일이
// 통과하고, 그때 구 blob 이 갱신되지 않은 쪽에서 "아무것도 참조하지 않음" 으로
// 읽혀 세션 전체가 폐기된다.
//
// 빈 blob 은 (nil, nil) 이다 — 오류가 아니라 "상태가 아직 없다" 이며, 호출자의
// 빈 결과 경로로 간다.
func decodeState(blob []byte) (*wsState, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	var s wsState
	if err := json.Unmarshal(blob, &s); err != nil {
		return nil, err
	}
	if s.SchemaVersion < SchemaVersion {
		return nil, ErrSchemaTooOld
	}
	return &s, nil
}

func buildIndex(blob []byte) (*index, error) {
	ix := emptyIndex()
	s, err := decodeState(blob)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return ix, nil
	}
	for si, sess := range s.Windows {
		var regions []*WsLayout
		CollectPanes(sess.Layout, &regions)
		for pi, rg := range regions {
			for ti, tab := range rg.Tabs {
				isActive := sess.ID == s.ActiveWindow && sess.FocusedPane == rg.ID && rg.ActiveTab == tab.ID
				label := fmt.Sprintf("W%d.P%d.T%d", si+1, pi+1, ti+1)
				ix.entries = append(ix.entries, TabEntry{
					ToolID:     tab.ToolID,
					Label:      label,
					WindowName: sess.Name,
					TabName:    tab.Name,
					IsActive:   isActive,
					WindowUUID: sess.ID,
					PaneUUID:   rg.ID,
					TabUUID:    tab.ID,
					ShortCode:  shortCodeOf(tab.ID),
				})
				ix.labels[tab.ToolID] = label
				ix.labelToID[label] = tab.ToolID
				if tab.ID != "" {
					ix.tabIDs[tab.ID] = struct{}{}
					ix.uuidToID[strings.ToLower(tab.ID)] = tab.ToolID
				}
			}
		}
	}
	return ix, nil
}

// shortCodeOf returns the leading 8 hex chars of a canonical UUID, used as a
// log-readability alias (NFR-UID-4). Falls back to the raw string when the
// input is shorter than 8 chars or empty.
func shortCodeOf(uuid string) string {
	if len(uuid) >= 8 {
		return uuid[:8]
	}
	return uuid
}

// CollectPanes walks a layout tree and appends every "tool" node to out.
func CollectPanes(n *WsLayout, out *[]*WsLayout) {
	if n == nil {
		return
	}
	if n.Type == "pane" {
		*out = append(*out, n)
		return
	}
	if n.Type == "split" {
		for _, c := range n.Children {
			CollectPanes(c, out)
		}
	}
}

// ReferencedToolIDs returns the set of tool ids that some tab in blob points
// at. Used at boot to distinguish live tools from orphans in tools.json
// (FR-EM-14) — a tool nobody references is unreachable from any UI and must
// not be respawned.
//
// Tabs without a tool (editor/markdown) contribute nothing. An empty blob
// yields an empty set. A pre-v2 blob is an error, never an empty set: silently
// treating it as "nothing referenced" would classify every tool as an orphan
// and discard the user's whole session.
func ReferencedToolIDs(blob []byte) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	s, err := decodeState(blob)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return out, nil
	}
	for _, win := range s.Windows {
		var tools []*WsLayout
		CollectPanes(win.Layout, &tools)
		for _, pn := range tools {
			for _, tab := range pn.Tabs {
				if tab.ToolID != "" {
					out[tab.ToolID] = struct{}{}
				}
			}
		}
	}
	return out, nil
}
