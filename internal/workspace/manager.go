package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

var ErrStale = errors.New("workspace: stale revision")

type PaneLabel struct {
	PaneID      string
	Label       string
	SessionName string
	TabName     string
	IsActive    bool

	// Entity identity (UUID_IDENTITY_SRS Phase 1, FR-UID-6/7). Empty when the
	// upstream workspace.json predates the schema; consumers must tolerate that.
	SessionUUID string
	RegionUUID  string
	TabUUID     string
	ShortCode   string
}

type Liveness interface {
	IsLive(paneID string) bool
}

type Persister interface {
	Read() ([]byte, error)
	Write(data []byte) error
}

type index struct {
	entries   []PaneLabel
	labels    map[string]string
	labelToID map[string]string
	tabIDs    map[string]struct{}
	// uuidToID maps a tab's UUID (lower-case canonical form) to its paneId.
	// Stable across label reflows: closing other sessions/regions does not
	// shift the uuid->paneId binding (UUID_IDENTITY_SRS TC-UID-2).
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
	if m.OnIndexUpdate != nil {
		m.OnIndexUpdate()
	}
	return newRev, nil
}

func (m *Manager) Resolve(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", fmt.Errorf("빈 id")
	}
	if _, err := strconv.Atoi(id); err == nil {
		if m.live.IsLive(id) {
			return id, nil
		}
		return "", fmt.Errorf("paneId=%s 존재하지 않음", id)
	}
	ix := m.idx.Load()
	if isUUIDForm(id) {
		if ix != nil {
			if pid, ok := ix.uuidToID[strings.ToLower(id)]; ok {
				if !m.live.IsLive(pid) {
					return "", fmt.Errorf("uuid %s 은 paneId=%s 가리키지만 pane 이 존재하지 않음", id, pid)
				}
				return pid, nil
			}
		}
		return "", fmt.Errorf("id 해석 실패: %s (list_panes 로 확인)", id)
	}
	norm := strings.ToUpper(id)
	if ix != nil {
		if pid, ok := ix.labelToID[norm]; ok {
			if !m.live.IsLive(pid) {
				return "", fmt.Errorf("라벨 %s 은 paneId=%s 가리키지만 pane 이 존재하지 않음", norm, pid)
			}
			return pid, nil
		}
	}
	return "", fmt.Errorf("id 해석 실패: %s (list_panes 로 확인)", id)
}

// CoordinateOf translates an identifier into the canonical positional
// coordinate "S{n}.P{n}.T{n}" that the browser command pipeline parses. Only
// UUID inputs are rewritten — coordinate, paneId, label, and empty inputs are
// returned unchanged (NFR-UID-0 행위 보존). Used by /api/commands and
// workspace_command so dmctl and MCP accept UUID anywhere a location is
// expected.
func (m *Manager) CoordinateOf(id string) (string, error) {
	if id == "" || !isUUIDForm(id) {
		return id, nil
	}
	paneID, err := m.Resolve(id)
	if err != nil {
		return "", err
	}
	ix := m.idx.Load()
	if ix != nil {
		if label, ok := ix.labels[paneID]; ok {
			return label, nil
		}
	}
	return "", fmt.Errorf("uuid %s 은 paneId=%s 가리키지만 label 매핑 없음", id, paneID)
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

func (m *Manager) Entries() []PaneLabel {
	ix := m.idx.Load()
	if ix == nil {
		return nil
	}
	out := make([]PaneLabel, len(ix.entries))
	copy(out, ix.entries)
	return out
}

func (m *Manager) InvalidatePane(paneID string) {
	// Labels are positional (derived from workspace.json). Pane death doesn't
	// shift labels; liveness is queried via Liveness at Resolve time. Kept as
	// an explicit hook so callers (onExit) can signal the manager without
	// caring about current semantics.
	_ = paneID
}

// ── workspace.json parsing ──────────────────────────

type wsLayout struct {
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	Tabs      []wsTab     `json:"tabs,omitempty"`
	ActiveTab string      `json:"activeTab,omitempty"`
	Direction string      `json:"direction,omitempty"`
	Children  []*wsLayout `json:"children,omitempty"`
}

type wsTab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	PaneID string `json:"paneId"`
}

type wsSession struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Layout        *wsLayout `json:"layout"`
	FocusedRegion string    `json:"focusedRegion"`
}

type wsState struct {
	Sessions      []wsSession `json:"sessions"`
	ActiveSession string      `json:"activeSession"`
}

func emptyIndex() *index {
	return &index{
		labels:    map[string]string{},
		labelToID: map[string]string{},
		tabIDs:    map[string]struct{}{},
		uuidToID:  map[string]string{},
	}
}

func buildIndex(blob []byte) (*index, error) {
	ix := emptyIndex()
	if len(blob) == 0 {
		return ix, nil
	}
	var s wsState
	if err := json.Unmarshal(blob, &s); err != nil {
		return nil, err
	}
	for si, sess := range s.Sessions {
		var regions []*wsLayout
		collectRegions(sess.Layout, &regions)
		for pi, rg := range regions {
			for ti, tab := range rg.Tabs {
				isActive := sess.ID == s.ActiveSession && sess.FocusedRegion == rg.ID && rg.ActiveTab == tab.ID
				label := fmt.Sprintf("S%d.P%d.T%d", si+1, pi+1, ti+1)
				ix.entries = append(ix.entries, PaneLabel{
					PaneID:      tab.PaneID,
					Label:       label,
					SessionName: sess.Name,
					TabName:     tab.Name,
					IsActive:    isActive,
					SessionUUID: sess.ID,
					RegionUUID:  rg.ID,
					TabUUID:     tab.ID,
					ShortCode:   shortCodeOf(tab.ID),
				})
				ix.labels[tab.PaneID] = label
				ix.labelToID[label] = tab.PaneID
				if tab.ID != "" {
					ix.tabIDs[tab.ID] = struct{}{}
					ix.uuidToID[strings.ToLower(tab.ID)] = tab.PaneID
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

func collectRegions(n *wsLayout, out *[]*wsLayout) {
	if n == nil {
		return
	}
	if n.Type == "region" {
		*out = append(*out, n)
		return
	}
	if n.Type == "split" {
		for _, c := range n.Children {
			collectRegions(c, out)
		}
	}
}
