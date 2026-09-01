package toolhub

import (
	"net/http"
	"sort"
	"strconv"
	"time"
)

// ToolManager 가 ToolHub 인터페이스를 채우는 메서드들 (DAEMON_SPLIT_SRS Phase 1).
//
// hub.go 의 인터페이스와 짝이며, 갈라 둔 이유는 그 짝을 눈으로 확인할 수 있게
// 하기 위해서다 — 인터페이스가 늘면 이 파일이 늘고, 다른 파일은 그대로다.

// Write sends data to the PTY master of the named tool.
func (m *ToolManager) Write(id string, data []byte) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return nil // silently drop write to nonexistent tool
	}
	return p.Write(data)
}

// Resize changes the PTY dimensions of the named tool.
func (m *ToolManager) Resize(id string, cols, rows uint16) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return nil
	}
	return p.Resize(cols, rows)
}

// Cwd returns the current working directory of the named tool.
func (m *ToolManager) Cwd(id string) string {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ""
	}
	return p.Cwd()
}

// Busy reports whether the named tool has a running foreground process.
func (m *ToolManager) Busy(id string) bool {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return false
	}
	return p.IsBusy()
}

// ToolSnapshot captures the outbuf state of a tool for reattach scrollback
// restoration (DAEMON_SPLIT_SRS §6.6).
type ToolSnapshot struct {
	Data           []byte
	TotalBytesIn   int64
	TotalBytesDrop int64
	Retained       int
}

// SnapshotTool returns the outbuf snapshot of the named tool.
func (m *ToolManager) SnapshotTool(id string) (ToolSnapshot, error) {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ToolSnapshot{}, nil
	}
	s := p.Stream()
	if s == nil {
		return ToolSnapshot{}, nil
	}
	data, stats := s.Snapshot()
	return ToolSnapshot{
		Data:           data,
		TotalBytesIn:   stats.TotalBytesIn,
		TotalBytesDrop: stats.TotalBytesDrop,
		Retained:       stats.Retained,
	}, nil
}

// MaxTerminalDim is the upper bound (inclusive) accepted for cols and rows.
// Values above this clamp back to the default to reject pathological inputs.
const MaxTerminalDim uint64 = 4096

// ParseSize extracts cols/rows from request query.
// Out-of-range (0 or > MaxTerminalDim) or unparseable values fall back to defaults (120, 40).
func ParseSize(r *http.Request) (uint16, uint16) {
	c, ro := uint16(120), uint16(40)
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		c = uint16(v)
	}
	if v, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		ro = uint16(v)
	}
	return c, ro
}

// SetBackground marks tool id as background (bg=true) or restores it to a tab
// (bg=false). Returns false when the tool does not exist.
//
// Background is not a lifecycle of its own: the tool keeps running exactly as
// before. The flag records the *intent* that it outlives its tab, which is the
// one thing the server could not express — and without it "no tab references
// this tool" cannot be told apart from a leak (FR-BG).
func (m *ToolManager) SetBackground(id string, bg bool) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.tools[id]; !ok {
		return false
	}
	if m.background == nil {
		m.background = map[string]int64{}
	}
	if bg {
		if _, already := m.background[id]; !already {
			m.background[id] = time.Now().UnixNano()
		}
	} else {
		delete(m.background, id)
	}
	m.dirty.Store(true)
	return true
}

// IsBackground reports whether tool id was explicitly sent to the background.
func (m *ToolManager) IsBackground(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.background[id]
	return ok
}

// BackgroundList returns every background tool, oldest transition first.
func (m *ToolManager) BackgroundList() []BackgroundEntry {
	m.mu.RLock()
	type pair struct {
		t     *Tool
		since int64
	}
	pairs := make([]pair, 0, len(m.background))
	for id, since := range m.background {
		if t, ok := m.tools[id]; ok {
			pairs = append(pairs, pair{t, since})
		}
	}
	m.mu.RUnlock()

	// Cwd() shells out (lsof on macOS) — never hold the lock across it.
	out := make([]BackgroundEntry, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, BackgroundEntry{ToolID: p.t.ID, Name: p.t.Name, Cwd: p.t.Cwd(), Since: p.since})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since < out[j].Since })
	return out
}
