package toolhub

import (
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/platform"
)

// 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N). PTY 의 전경 프로세스 그룹
// (tcgetpgrp)의 리더 이름이며, IsBusy 가 보는 "직접 자식이 있는가"(pgrep -P)와는
// 다른 것이다 (§2.1(b)). 두 경로는 서로를 건드리지 않는다.
//
// 이 파일에는 build tag 가 없다. 종전에는 fg_posix.go / fg_other.go 로 갈라져
// 있었지만, 갈라진 이유였던 tcgetpgrp 과 /proc 이 모두 platform 뒤로 갔다
// (CROSS_PLATFORM_SRS FR-XPT-4). 캐시·주기·이름 다듬기 규칙은 그대로다.

const (
	// fgNameMax 는 파생 이름의 최대 글자 수다 (FR-TAN-13).
	fgNameMax = 16
	// fgRefreshInterval 은 도구별 재조회 주기다 (FR-TAN-8). 조회는 이 간격보다
	// 자주 오는 요청에 대해 캐시로 답하므로 호출 빈도와 무관하게 상한이 선다.
	fgRefreshInterval = 2 * time.Second
)

// fgShellNames 는 전경 프로그램으로 취급하지 않는 셸들이다 (FR-TAN-11).
var fgShellNames = map[string]struct{}{
	"sh": {}, "bash": {}, "zsh": {}, "fish": {}, "dash": {},
}

// fgRequest 는 도구 하나의 전경 조회 입력이다. 일괄 조회를 위해 존재한다 —
// macOS 폴백이 도구마다 ps 를 띄우면 도구 100개에서 주기를 넘긴다 (NFR-CNV-1).
type fgRequest struct {
	ID       string
	Term     platform.Terminal
	ShellPID int
}

// fgProbe 는 전경 조회 구현이다. toolBusyProbe 와 같은 이유로 패키지 변수다 —
// 테스트가 호스트의 PTY 동작에 기대지 않고 결정론적으로 대체할 수 있다.
var fgProbe = foregroundNames

// foregroundNames 는 여러 도구를 한 번에 조회한다. 이름 읽기를 한 번의 조회로
// 묶는 것이 이 함수가 존재하는 이유다 (NFR-XP-4).
func foregroundNames(reqs []fgRequest) map[string]string {
	type hit struct {
		id  string
		pid int
	}
	hits := make([]hit, 0, len(reqs))
	pids := make([]int, 0, len(reqs))
	for _, r := range reqs {
		if r.Term == nil || r.ShellPID <= 0 {
			continue
		}
		pgid, ok := r.Term.ForegroundPGID()
		if !ok {
			continue
		}
		hits = append(hits, hit{r.ID, pgid})
		pids = append(pids, pgid)
	}
	names := platform.Current().Info.Names(pids)
	out := make(map[string]string, len(hits))
	for _, h := range hits {
		if n := derivedName(names[h.pid]); n != "" {
			out[h.id] = n
		}
	}
	return out
}

// derivedName 은 조회한 프로세스 이름을 탭에 쓸 파생 이름으로 만든다.
// 이름은 그대로 쓰며 매핑 표를 두지 않는다 (FR-TAN-10/14) — 다듬는 것은
// 경로를 벗기고(macOS ps 는 실행 경로를 낸다), 로그인 셸의 '-' 접두를 떼고,
// 16자로 자르는 것뿐이다. 셸이면 빈 문자열이다 (FR-TAN-11).
func derivedName(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" {
		return ""
	}
	name = strings.TrimPrefix(filepath.Base(name), "-")
	if name == "" || name == "." || name == string(filepath.Separator) {
		return ""
	}
	if _, ok := fgShellNames[name]; ok {
		return ""
	}
	if r := []rune(name); len(r) > fgNameMax {
		name = string(r[:fgNameMax])
	}
	return name
}

// fgEntry 는 도구 하나의 캐시된 조회 결과다. name 이 빈 문자열인 것도 유효한
// 결과이며(전경 프로그램 없음 / 조회 실패), 그래서 존재 여부와 값을 나눠 둔다.
type fgEntry struct {
	name string
	at   time.Time
}

// SetForegroundNotifier 는 전경 이름이 **바뀌었을 때만** 불리는 콜백을 건다
// (FR-TAN-9). 같은 값을 반복해서 알리지 않는다. 데몬 모드에서는 PanedServer 가
// 이것을 IPC push 로 잇는다.
func (m *ToolManager) SetForegroundNotifier(notify func(id, name string)) {
	m.fgMu.Lock()
	m.fgNotify = notify
	m.fgMu.Unlock()
}

// ForegroundNames 는 살아 있는 도구들의 파생 전경 이름을 낸다. 전경 프로그램이
// 없거나 조회에 실패한 도구는 결과에 담기지 않는다 (FR-TAN-5/6).
//
// 호출마다 조회하지 않는다 — fgRefreshInterval 보다 최근에 조회한 도구는 캐시로
// 답한다 (FR-TAN-8, C-3).
func (m *ToolManager) ForegroundNames() map[string]string {
	m.refreshForeground(time.Now())
	m.fgMu.Lock()
	defer m.fgMu.Unlock()
	out := make(map[string]string, len(m.fgCache))
	for id, e := range m.fgCache {
		if e.name != "" {
			out[id] = e.name
		}
	}
	return out
}

// refreshForeground 는 오래된 항목만 다시 조회한다. fgFlight 가 single-flight 를
// 만들어, 동시에 들어온 목록 요청 여럿이 ps 를 겹쳐 띄우지 않게 한다.
func (m *ToolManager) refreshForeground(now time.Time) {
	m.fgFlight.Lock()
	defer m.fgFlight.Unlock()

	m.mu.RLock()
	live := make([]fgRequest, 0, len(m.tools))
	for id, p := range m.tools {
		live = append(live, fgRequest{ID: id, Term: p.term, ShellPID: p.CmdProcessPID()})
	}
	m.mu.RUnlock()

	alive := make(map[string]struct{}, len(live))
	for _, r := range live {
		alive[r.ID] = struct{}{}
	}

	m.fgMu.Lock()
	if m.fgCache == nil {
		m.fgCache = make(map[string]fgEntry)
	}
	stale := make([]fgRequest, 0, len(live))
	for _, r := range live {
		if e, ok := m.fgCache[r.ID]; ok && now.Sub(e.at) < fgRefreshInterval {
			continue
		}
		stale = append(stale, r)
	}
	for id := range m.fgCache {
		if _, ok := alive[id]; !ok {
			delete(m.fgCache, id)
		}
	}
	notify := m.fgNotify
	m.fgMu.Unlock()

	if len(stale) == 0 {
		return
	}
	// 조회는 락 밖에서 한다 — macOS ps 폴백은 수십 ms 가 걸리고, 그동안
	// Create/Delete 가 막히면 안 된다 (SaveAll 의 Cwd 와 같은 사정).
	names := fgProbe(stale)

	type change struct{ id, name string }
	var changed []change
	m.fgMu.Lock()
	for _, r := range stale {
		name := names[r.ID]
		// 캐시에 없는 도구의 이전 값은 빈 문자열로 본다 — 아직 아무 이름도
		// 내보낸 적이 없는 것과 "전경 프로그램 없음"은 표시가 같으므로,
		// 첫 조회가 빈 결과인 것은 알릴 변화가 아니다 (FR-TAN-9).
		prev := m.fgCache[r.ID].name
		m.fgCache[r.ID] = fgEntry{name: name, at: now}
		if prev != name {
			changed = append(changed, change{r.ID, name})
		}
	}
	m.fgMu.Unlock()

	if notify == nil {
		return
	}
	for _, c := range changed {
		notify(c.id, c.name)
	}
}
