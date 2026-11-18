package toolhub

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/outbuf"
	"dongminal/internal/shared/platform"
)

// 데몬 교체의 도구 인계 (DAEMON_SESSION_KEEP_SRS FR-DSK-14·21~23).

// HandoverTool 은 exec 를 넘는 도구 하나다. 셸과 PTY 는 fd·pid 로 넘고, 메모리에만 있던
// 값(화면·좌표·모드·에이전트 기록)은 여기 담긴다.
type HandoverTool struct {
	ID         string                     `json:"id"`
	Name       string                     `json:"name"`
	FD         uintptr                    `json:"fd"`
	PID        int                        `json:"pid"`
	Cols       uint16                     `json:"cols"`
	Rows       uint16                     `json:"rows"`
	Background bool                       `json:"background,omitempty"`
	Sandboxed  bool                       `json:"sandboxed,omitempty"`
	Screen     []byte                     `json:"screen,omitempty"`
	Offset     int64                      `json:"offset"`
	Modes      uint64                     `json:"modes,omitempty"`
	Cwd        string                     `json:"cwd,omitempty"`
	Agent      AgentState                 `json:"agent"`
	Records    map[string]json.RawMessage `json:"records,omitempty"`
}

var errNotFrozen = errors.New("멈추지 않은 도구가 있다 — FreezeAll 뒤에 담는다")

// ExportHandover 는 살아 있는 도구를 모두 담는다. FreezeAll 뒤에만 부른다 — 멈추지 않은
// 도구의 화면은 담는 사이에도 자라므로 담은 값이 사실이 아니게 된다.
func (m *ToolManager) ExportHandover() ([]HandoverTool, error) {
	out := make([]HandoverTool, 0)
	for _, p := range m.Snapshot() {
		if p.exitedNow() {
			continue
		}
		h, ok := p.term.(platform.Handover)
		if !ok || !p.parked() {
			return nil, fmt.Errorf("[tool %s] %w", p.ID, errNotFrozen)
		}
		cols, rows, err := p.term.Size()
		if err != nil {
			return nil, fmt.Errorf("[tool %s] 크기: %w", p.ID, err)
		}
		screen, _ := p.stream.Snapshot()
		ht := HandoverTool{
			ID: p.ID, Name: p.Name,
			FD: h.MasterFD(), PID: p.term.PID(),
			Cols: cols, Rows: rows,
			Background: m.IsBackground(p.ID),
			Sandboxed:  p.sandboxed,
			Screen:     screen,
			Offset:     p.stream.Offset(),
			Modes:      p.modes.Load(),
			Agent:      p.AgentState(),
			Records:    p.Records(),
		}
		if v, ok := p.reportedCwd.Load().(string); ok {
			ht.Cwd = v
		}
		out = append(out, ht)
	}
	return out, nil
}

// AdoptHandover 는 넘겨받은 셸로 같은 id 의 도구를 다시 세운다 (FR-DSK-21~23).
func (m *ToolManager) AdoptHandover(ht HandoverTool) error {
	if ht.ID == "" {
		return errors.New("도구 id 가 비었다")
	}
	term, err := platform.AdoptTerminal(ht.FD, ht.PID)
	if err != nil {
		return fmt.Errorf("[tool %s] %w", ht.ID, err)
	}
	m.mu.Lock()
	if _, dup := m.tools[ht.ID]; dup {
		m.mu.Unlock()
		return fmt.Errorf("[tool %s] 이미 있는 도구다", ht.ID)
	}
	hooks := m.attnHooks()
	m.mu.Unlock()

	p := newToolOnTerm(ht.ID, ht.Name, term, ht.Sandboxed, m.toolExited, hooks)
	p.stream = outbuf.Restore(bufMax, ht.Screen, ht.Offset)
	p.modes.Store(ht.Modes)
	p.noteCwdReport(ht.Cwd)
	p.RestoreAgentState(ht.Agent)
	p.LastOutputAt.Store(ht.Agent.LastOutputAt)
	for kind, v := range ht.Records {
		p.SetRecord(kind, v)
	}

	m.mu.Lock()
	m.tools[ht.ID] = p
	if ht.Background {
		if m.background == nil {
			m.background = map[string]int64{}
		}
		m.background[ht.ID] = time.Now().UnixNano()
	}
	m.mutated.Store(true)
	m.mu.Unlock()

	go p.readPTY()
	dmlog.Infof(nil, "[tool %s] 넘겨받음 pid=%d cols=%d rows=%d", ht.ID, ht.PID, ht.Cols, ht.Rows)
	return nil
}

func (p *Tool) parked() bool {
	f := &p.frz
	f.init()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.parked
}

func (p *Tool) exitedNow() bool {
	p.cmu.Lock()
	defer p.cmu.Unlock()
	return p.exited
}

// MasterFDs 는 살아 있는 도구가 쥔 PTY 마스터 fd 다. 되찾기가 이미 쥔 셸을 다시 찾지 않게
// 한다 (FR-DSK-27).
func (m *ToolManager) MasterFDs() map[uintptr]bool {
	out := map[uintptr]bool{}
	for _, p := range m.Snapshot() {
		if h, ok := p.term.(platform.Handover); ok {
			out[h.MasterFD()] = true
		}
	}
	return out
}
