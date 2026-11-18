package toolhub

// ShellState 는 복구 판정의 셸 상태다 (RUN_RECOVERY_SRS FR-RRC-10).
type ShellState string

const (
	// ShellIdle 은 셸이 비었다 — 자식이 없고 세션도 돌지 않는다.
	ShellIdle ShellState = "idle"
	// ShellBusy 는 세션은 꺼졌지만 셸에 다른 자식이 있다.
	ShellBusy ShellState = "busy"
	// ShellHere 는 세션이 이 셸(자신 또는 자손)에서 돈다.
	ShellHere ShellState = "here"
	// ShellElsewhere 는 세션이 다른 곳에서 돈다.
	ShellElsewhere ShellState = "elsewhere"
	// ShellUnknown 은 판정하지 못했다.
	ShellUnknown ShellState = "unknown"
)

// ShellProbe 는 도구 셸의 상태를 판정한다. cands 는 세션 등록부가 그 세션을 기록한 pid 들이다.
// 프로세스 표는 한 번만 읽는다.
func (m *ToolManager) ShellProbe(id string, cands []int) ShellState {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return ShellUnknown
	}
	parents, ok := toolProcInfo().Parents()
	return judgeShell(parents, ok, p.CmdProcessPID(), cands)
}

// judgeShell 은 FR-RRC-10 의 순서다. 표에 있는 후보만 살아 있는 세션으로 본다.
func judgeShell(parents map[int]int, ok bool, shell int, cands []int) ShellState {
	if !ok || shell <= 0 {
		return ShellUnknown
	}
	// 살아 있는 셸이 표에 없으면 표가 비었거나 일부다. 그 표로는 아무것도 확인하지 못한다.
	if _, live := parents[shell]; !live {
		return ShellUnknown
	}
	alive := false
	for _, c := range cands {
		if _, live := parents[c]; !live {
			continue
		}
		alive = true
		if descendsFrom(parents, c, shell) {
			return ShellHere
		}
	}
	if alive {
		return ShellElsewhere
	}
	for pid, ppid := range parents {
		if ppid == shell && pid != shell {
			return ShellBusy
		}
	}
	return ShellIdle
}

// descendsFrom 은 pid 가 anc 자신이거나 그 자손인가다. 고리가 있어도 끝난다.
func descendsFrom(parents map[int]int, pid, anc int) bool {
	seen := map[int]bool{}
	for cur := pid; cur > 0 && !seen[cur]; {
		if cur == anc {
			return true
		}
		seen[cur] = true
		next, ok := parents[cur]
		if !ok {
			return false
		}
		cur = next
	}
	return false
}
