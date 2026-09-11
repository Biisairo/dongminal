package toolhub

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// ToolManager 가 ToolHub 인터페이스를 채우는 메서드들 (DAEMON_SPLIT_SRS Phase 1).
//
// hub.go 의 인터페이스와 짝이며, 갈라 둔 이유는 그 짝을 눈으로 확인할 수 있게
// 하기 위해서다 — 인터페이스가 늘면 이 파일이 늘고, 다른 파일은 그대로다.

// ErrToolNotFound 는 그 id 의 도구가 없다는 뜻이다 (`GO-8`).
//
// 종전에는 `nil` 이었다. 그 `nil` 이 데몬 IPC 를 지나 클라이언트에게 **성공**으로
// 전달되고, 브라우저는 자기가 보낸 키가 들어간 줄 안다 — "모른다" 를 "괜찮다" 로
// 바꿔 읽는 자리다 (FR-CBG-5).
//
// **판단은 호출자에게 남긴다.** 이미 없는 것을 지우는 일은 호출자에 따라 정상일
// 수 있으므로, 여기서는 사실만 돌려준다.
var ErrToolNotFound = errors.New("toolhub: tool not found")

// Write sends data to the PTY master of the named tool.
func (m *ToolManager) Write(id string, data []byte) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ErrToolNotFound
	}
	return p.Write(data)
}

// Resize changes the PTY dimensions of the named tool.
func (m *ToolManager) Resize(id string, cols, rows uint16) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ErrToolNotFound
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
	// End 는 Data 의 **끝** 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-6).
	// 클라이언트는 이 값을 자기 좌표로 세우고 다음 접속의 since 로 되돌려준다.
	End int64
	// Resumed 는 요청한 since 에서 **이어 붙였는가** 다. false 면 전량 재생이고,
	// 그때만 받는 쪽이 화면을 지운다 (FR-TRS-10).
	Resumed bool
}

// SnapshotTool returns the outbuf snapshot of the named tool.
func (m *ToolManager) SnapshotTool(id string) (ToolSnapshot, error) {
	return m.SnapshotToolSince(id, -1)
}

// SnapshotToolSince 는 since 에서 이어 붙일 수 있으면 **그 뒤만** 돌려준다
// (TERMINAL_RESUME_SRS FR-TRS-2~4). since<0 이면 전량이다.
//
// 강등은 조용하다 — 창 밖이면 Resumed=false 로 전량을 준다. 호출자는 그 플래그
// 하나로 "지우고 뿌릴 것인가" 를 정한다.
func (m *ToolManager) SnapshotToolSince(id string, since int64) (ToolSnapshot, error) {
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
	if since >= 0 {
		if data, end, ok := s.Since(since); ok {
			return ToolSnapshot{Data: data, TotalBytesIn: end, Retained: len(data), End: end, Resumed: true}, nil
		}
	}
	data, stats := s.Snapshot()
	return ToolSnapshot{
		Data:           data,
		TotalBytesIn:   stats.TotalBytesIn,
		TotalBytesDrop: stats.TotalBytesDrop,
		Retained:       stats.Retained,
		End:            stats.TotalBytesIn,
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
//
// **여기서 방송하지 않는다** (UX_BATCH6_SRS FR-BGP-2). 이 경로에는 언제나 HTTP
// 종단(`apiToolBackgroundSet`)이 앞에 있고, 데몬 모드에서는 이 함수가 웹서버가
// 아니라 데몬 프로세스에서 돈다 — 거기에는 알릴 구독자가 없다. 방송은 두 모드가
// 공유하는 그 종단이 한다. 이 훅이 답하는 것은 **아무도 부탁하지 않은 변화**,
// 곧 프로세스의 죽음뿐이다 (`Delete`).
func (m *ToolManager) SetBackground(id string, bg bool) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, found := m.tools[id]
	if !found {
		return false
	}
	// FR-SBX-27: 샌드박스 도구는 백그라운드로 갈 수 없다. 백그라운드 도구는
	// 어느 탭에도 매이지 않은 것인데, 이 도구는 컨테이너에 매이고 컨테이너는
	// Window 에 매인다 — 소유 관계가 둘이 되면 Window 를 닫을 때 돌던 작업을
	// 죽이거나 주인 없는 컨테이너가 남는다.
	//
	// 명령 경로가 아니라 여기서 막는 이유는 경로가 여럿이기 때문이다(dmctl ·
	// detach · UI). 그것들이 모두 이 자리를 지난다.
	if bg && t.sandboxed {
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
	m.mutated.Store(true)
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
		out = append(out, BackgroundEntry{ToolID: p.t.ID, Name: p.t.Name, Cwd: cwdOrServer(p.t), Since: p.since})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since < out[j].Since })
	return out
}
