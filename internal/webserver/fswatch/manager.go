package fswatch

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"

	"github.com/fsnotify/fsnotify"

	"dongminal/internal/shared/dmlog"
)

const (
	// MaxRestarts 는 감시자를 다시 세우는 상한이다 (VS Code `AbstractWatcherClient.MAX_RESTARTS`).
	MaxRestarts = 5
	// KqueueEntriesMax 는 kqueue 백엔드에서 감시할 디렉터리의 항목 상한이다 (FR-ELR-55).
	// kqueue 는 디렉터리 안의 파일마다 fd 를 하나씩 연다.
	KqueueEntriesMax = 4096
)

var (
	// ErrNotAttached 는 SSE 구독이 없는 신원의 등록이다 (FR-ELR-51·52).
	ErrNotAttached = errors.New("fswatch: client not attached")
	// ErrBackendOverflow 는 백엔드가 이벤트를 놓쳤다는 알림이다. 감시자는 멀쩡하다.
	ErrBackendOverflow = fsnotify.ErrEventOverflow
)

// Dir 은 등록할 디렉터리 하나다. Path 는 클라이언트의 철자, Real 은 실제 경로다.
type Dir struct {
	Path string
	Real string
}

// Backend 는 OS 감시 계층이다. 기본 구현은 fsnotify 다.
type Backend interface {
	Add(path string) error
	Remove(path string) error
	Events() <-chan RawEvent
	Errors() <-chan error
	Close() error
}

// ManagerOptions 는 `NewManager` 의 입력이다.
type ManagerOptions struct {
	NewBackend    func() (Backend, error)
	Clock         Clock
	CaseSensitive bool
	NFC           bool
	Watchable     func(real string) bool
	Exists        func(real string) bool
	Emit          func(changes []Change, overflow bool)
}

// DefaultOptions 는 이 OS 의 기본값이다.
func DefaultOptions(emit func([]Change, bool)) ManagerOptions {
	return ManagerOptions{
		NewBackend:    newFSNotifyBackend,
		Clock:         realClock{},
		CaseSensitive: fsCaseSensitive,
		NFC:           fsNFC,
		Watchable:     watchable,
		Exists: func(p string) bool {
			_, err := os.Lstat(p)
			return err == nil
		},
		Emit: emit,
	}
}

type client struct {
	epoch uint64
	dirs  map[string]string // 철자 → 실제 경로
}

// Manager 는 클라이언트마다의 감시 집합을 합쳐 디렉터리를 한 번씩 감시한다 (FR-ELR-51~55·60).
type Manager struct {
	opt  ManagerOptions
	pipe *Pipeline

	mu       sync.Mutex
	clients  map[string]*client
	seq      uint64
	ref      map[string]int            // 실제 경로 → 참조 수
	spell    map[string]map[string]int // 실제 경로 → 철자 → 참조 수
	backend  Backend
	restarts int
	dead     bool
	closed   bool
}

func NewManager(opt ManagerOptions) *Manager {
	m := &Manager{
		opt:     opt,
		clients: map[string]*client{},
		ref:     map[string]int{},
		spell:   map[string]map[string]int{},
	}
	m.pipe = NewPipeline(PipelineOptions{
		Clock:         opt.Clock,
		Exists:        opt.Exists,
		CaseSensitive: opt.CaseSensitive,
		NFC:           opt.NFC,
		Out:           m.out,
	})
	return m
}

// Attach 는 SSE 구독이 열렸음을 알린다. 돌려준 epoch 로 `Detach` 한다.
func (m *Manager) Attach(cid string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	c := m.clients[cid]
	if c == nil {
		c = &client{dirs: map[string]string{}}
		m.clients[cid] = c
	}
	c.epoch = m.seq
	return m.seq
}

// Detach 는 구독이 끊겼음을 알린다. 그 사이 다시 붙은 구독의 등록은 지우지 않는다.
func (m *Manager) Detach(cid string, epoch uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.clients[cid]
	if c == nil || c.epoch != epoch {
		return
	}
	for sp, real := range c.dirs {
		m.releaseLocked(sp, real)
	}
	delete(m.clients, cid)
}

// Set 은 cid 의 감시 집합을 통째로 바꾸고, 실제로 감시하게 된 철자를 돌려준다.
func (m *Manager) Set(cid string, dirs []Dir) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.clients[cid]
	if cid == "" || c == nil {
		return nil, ErrNotAttached
	}
	if m.backend == nil && !m.dead && !m.closed {
		m.startLocked()
	}
	next := map[string]string{}
	for _, d := range dirs {
		if _, dup := next[d.Path]; dup {
			continue
		}
		if old, ok := c.dirs[d.Path]; ok && old == d.Real {
			next[d.Path] = d.Real
			continue
		}
		if m.acquireLocked(d.Path, d.Real) {
			next[d.Path] = d.Real
		}
	}
	for sp, real := range c.dirs {
		if next[sp] != real {
			m.releaseLocked(sp, real)
		}
	}
	c.dirs = next
	out := make([]string, 0, len(next))
	for sp := range next {
		out = append(out, sp)
	}
	sort.Strings(out)
	return out, nil
}

// Close 는 감시를 모두 걷는다.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	if m.backend != nil {
		_ = m.backend.Close()
		m.backend = nil
	}
}

func (m *Manager) acquireLocked(sp, real string) bool {
	if m.backend == nil || !m.opt.Watchable(real) {
		return false
	}
	if m.ref[real] == 0 {
		if err := m.backend.Add(real); err != nil {
			return false
		}
	}
	m.ref[real]++
	if m.spell[real] == nil {
		m.spell[real] = map[string]int{}
	}
	m.spell[real][sp]++
	return true
}

func (m *Manager) releaseLocked(sp, real string) {
	if m.ref[real] == 0 {
		return
	}
	if s := m.spell[real]; s != nil {
		if s[sp]--; s[sp] <= 0 {
			delete(s, sp)
		}
	}
	if m.ref[real]--; m.ref[real] > 0 {
		return
	}
	delete(m.ref, real)
	delete(m.spell, real)
	if m.backend != nil {
		_ = m.backend.Remove(real)
	}
}

func (m *Manager) startLocked() {
	b, err := m.opt.NewBackend()
	if err != nil {
		dmlog.Infof(nil, "[fswatch] 감시자를 세우지 못했다 — 폴링이 맡는다: %v", err)
		m.dead = true
		return
	}
	m.backend = b
	go m.run(b)
}

func (m *Manager) run(b Backend) {
	events, errs := b.Events(), b.Errors()
	for {
		select {
		case e, ok := <-events:
			if !ok {
				m.fail(b, nil)
				return
			}
			m.handleRaw(e)
		case err, ok := <-errs:
			if !ok {
				m.fail(b, nil)
				return
			}
			if errors.Is(err, ErrBackendOverflow) {
				m.opt.Emit(nil, true)
				continue
			}
			m.fail(b, err)
			return
		}
	}
}

// fail 은 감시자가 멎었을 때 다시 세운다 (FR-ELR-60). 자원 고갈이면 세우지 않는다.
func (m *Manager) fail(b Backend, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || b != m.backend {
		return
	}
	_ = b.Close()
	m.backend = nil
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENOSPC) || m.restarts >= MaxRestarts {
		dmlog.Infof(nil, "[fswatch] 감시자가 멎었다 — 폴링이 맡는다: %v", err)
		m.dead = true
		return
	}
	m.restarts++
	m.startLocked()
	if m.backend == nil {
		return
	}
	for real := range m.ref {
		_ = m.backend.Add(real)
	}
}

// handleRaw 는 감시 중인 디렉터리의 이벤트만 파이프라인에 넣는다.
func (m *Manager) handleRaw(e RawEvent) {
	m.mu.Lock()
	_, inDir := m.ref[filepath.Dir(e.Name)]
	_, self := m.ref[e.Name]
	m.mu.Unlock()
	if inDir || self {
		m.pipe.Push(e)
	}
}

// out 은 실제 경로의 변화를 등록한 철자로 되돌려 내보낸다 (FR-ELR-54).
func (m *Manager) out(cs []Change, overflow bool) {
	if overflow {
		m.opt.Emit(nil, true)
		return
	}
	seen := map[string]bool{}
	var res []Change
	m.mu.Lock()
	for _, c := range cs {
		for _, p := range m.spellingsLocked(c.Path) {
			if seen[p] {
				continue
			}
			seen[p] = true
			res = append(res, Change{p, c.Kind})
		}
	}
	m.mu.Unlock()
	if len(res) > 0 {
		sort.SliceStable(res, func(i, j int) bool { return res[i].Path < res[j].Path })
		m.opt.Emit(res, false)
	}
}

func (m *Manager) spellingsLocked(real string) []string {
	var out []string
	base := filepath.Base(real)
	for sp := range m.spell[filepath.Dir(real)] {
		out = append(out, filepath.Join(sp, base))
	}
	for sp := range m.spell[real] {
		out = append(out, sp)
	}
	return out
}
