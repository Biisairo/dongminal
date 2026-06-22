// Package mdscroll persists per-tab markdown viewer scroll positions.
//
// File model: $DONGMINAL_HOME/mdscroll.json. Map keyed by tab id.
//
//	{ "tabs": { "<tabId>": {"top": 123.0, "ratio": 0.45, "ts": 1700000000000} } }
//
// The store is intentionally separate from workspace.json because scroll PUTs
// are high-frequency and would otherwise trigger workspace rev increments and
// SSE storms. Latest-wins coalescing on the writer goroutine matches the
// workspace pattern.
package mdscroll

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"sync"
)

type Entry struct {
	Top   float64 `json:"top"`
	Ratio float64 `json:"ratio"`
	TS    int64   `json:"ts"`
}

type Persister interface {
	Read() ([]byte, error)
	Write(data []byte) error
}

type FilePersister struct{ Path string }

func (p FilePersister) Read() ([]byte, error) { return os.ReadFile(p.Path) }
func (p FilePersister) Write(b []byte) error  { return os.WriteFile(p.Path, b, 0o644) }

type fileShape struct {
	Tabs map[string]Entry `json:"tabs"`
}

type Manager struct {
	store Persister

	mu      sync.RWMutex
	entries map[string]Entry

	writeCh    chan struct{}
	done       chan struct{}
	wg         sync.WaitGroup
	closedOnce sync.Once
}

func New(store Persister) (*Manager, error) {
	m := &Manager{
		store:   store,
		entries: map[string]Entry{},
		writeCh: make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
	data, err := store.Read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("mdscroll read: %v (starting empty)", err)
	} else if len(data) > 0 {
		var f fileShape
		if jerr := json.Unmarshal(data, &f); jerr != nil {
			log.Printf("mdscroll parse: %v (starting empty)", jerr)
		} else if f.Tabs != nil {
			m.entries = f.Tabs
		}
	}
	m.wg.Add(1)
	go m.writer()
	return m, nil
}

func (m *Manager) writer() {
	defer m.wg.Done()
	for {
		select {
		case <-m.writeCh:
			m.flush()
		case <-m.done:
			select {
			case <-m.writeCh:
				m.flush()
			default:
			}
			return
		}
	}
}

func (m *Manager) flush() {
	m.mu.RLock()
	blob, _ := json.Marshal(fileShape{Tabs: m.entries})
	m.mu.RUnlock()
	if err := m.store.Write(blob); err != nil {
		log.Printf("mdscroll write: %v", err)
	}
}

func (m *Manager) enqueue() {
	select {
	case m.writeCh <- struct{}{}:
	default:
	}
}

func (m *Manager) Close() error {
	m.closedOnce.Do(func() {
		close(m.done)
		m.wg.Wait()
	})
	return nil
}

func (m *Manager) Get(tabID string) (Entry, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.entries[tabID]
	return e, ok
}

func (m *Manager) Set(tabID string, e Entry) {
	if tabID == "" {
		return
	}
	m.mu.Lock()
	m.entries[tabID] = e
	m.mu.Unlock()
	m.enqueue()
}

func (m *Manager) Delete(tabID string) {
	m.mu.Lock()
	if _, ok := m.entries[tabID]; !ok {
		m.mu.Unlock()
		return
	}
	delete(m.entries, tabID)
	m.mu.Unlock()
	m.enqueue()
}

// Snapshot returns a copy of all entries.
func (m *Manager) Snapshot() map[string]Entry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]Entry, len(m.entries))
	for k, v := range m.entries {
		out[k] = v
	}
	return out
}

// Reconcile drops entries whose tab id is not in validIDs.
func (m *Manager) Reconcile(validIDs map[string]struct{}) (removed int) {
	m.mu.Lock()
	for k := range m.entries {
		if _, ok := validIDs[k]; !ok {
			delete(m.entries, k)
			removed++
		}
	}
	m.mu.Unlock()
	if removed > 0 {
		m.enqueue()
	}
	return removed
}
