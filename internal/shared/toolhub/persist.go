package toolhub

import (
	"encoding/json"
	"log"
	"os"
	"sort"

	"dongminal/internal/shared/platform"
)

// ToolManager 의 영속화 — tools.json.
//
// 탭이 참조하는 도구만 기록된다. 백그라운드 도구가 기록되지 않아 데몬 재시작을
// 넘기지 않는 것이 여기서 정해진다 (architecture.md).

type ToolState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

// SaveAll writes tools.json. Skips when no state mutation has occurred since
// startup so a clean run never clobbers an existing user file with empty state.
//
// Cwd() can take tens to hundreds of ms on macOS (lsof). To keep it from
// blocking concurrent Create/Delete calls, we snapshot tool pointers under
// m.mu and then call Cwd() OUTSIDE the lock.
func (m *ToolManager) SaveAll() {
	if !m.mutated.Load() {
		return
	}
	// **스냅샷과 쓰기가 한 임계 구역 안에 있어야 한다** (FR-CAF-12).
	//
	// saveAsync 는 호출마다 고루틴을 띄운다. 직렬화가 없으면 스냅샷 시각이 A→B 인
	// 두 저장이 디스크에는 B→A 순으로 도착할 수 있고, 그러면 낡은 tools.json 이
	// 최종본이 된다. 도구를 빠르게 여닫을 때 실제로 생기는 순서다.
	//
	// m.mu 로 대신할 수 없다. 아래가 그것을 일부러 놓기 때문이다 — Cwd() 가
	// macOS 에서 수백 ms 를 쓰므로 레지스트리를 그동안 잠글 수 없다. 순서를 지키는
	// 잠금과 레지스트리를 지키는 잠금은 서로 다른 것을 지킨다.
	m.saveFile.Lock()
	defer m.saveFile.Unlock()

	m.mu.Lock()
	snap := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		snap = append(snap, p)
	}
	m.mu.Unlock()
	// 소유 집합은 루프 밖에서 한 번만 묻는다 — 제공자가 파일을 읽을 수 있으므로
	// 도구마다 부르면 SaveAll 한 번이 파일을 n번 읽는다.
	owned := m.ownedTools()
	states := make([]ToolState, 0, len(snap))
	for _, p := range snap {
		// FR-EM-12/FR-BG-9: 백그라운드 도구는 기재하지 않는다. 기재하면
		// 재시작 시 빈 셸로 되살아나 고아가 된다 — 백그라운드로 보낸 이유가
		// "돌고 있던 작업"이므로 빈 셸에는 의미가 없다.
		//
		// FR-HLM-3 이 그 규칙에 **예외 하나**를 낸다. 규칙이 사라지는 것이
		// 아니다 — 위 근거의 핵심은 그 도구에 **소유자가 없다**는 것이고, 그래서
		// 되살아나도 아무도 거둘 수 없다. 헤드리스 멤버의 도구는 Run 이 소유하며
		// (owned 가 그것을 답한다), 소유자가 있으면 되살아난 뒤에도 run status 의
		// 고아 목록과 run close 가 그것을 거둘 수 있다.
		if m.IsBackground(p.ID) {
			if _, own := owned[p.ID]; !own {
				continue
			}
		}
		states = append(states, ToolState{ID: p.ID, Name: p.Name, Cwd: cwdOrServer(p)})
	}
	sort.Slice(states, func(i, j int) bool { return states[i].ID < states[j].ID })
	data, err := json.Marshal(states)
	if err != nil {
		log.Printf("saveTools marshal: %v", err)
		return
	}
	// 원자적으로 쓴다 (FR-CAF-11) — 잘린 tools.json 은 다음 기동에서 도구를
	// 통째로 잃게 한다.
	if err := platform.WriteFileAtomic(m.dataPath("tools.json"), data, 0644); err != nil {
		log.Printf("saveTools: %v", err)
	}
}

// LoadAll reads tools.json and respawns the shells that referenced still
// points at. Unreferenced entries are discarded (FR-EM-14).
func (m *ToolManager) LoadAll(referenced map[string]struct{}) {
	data, err := os.ReadFile(m.dataPath("tools.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadTools: %v", err)
		}
		return
	}
	var states []ToolState
	if err := json.Unmarshal(data, &states); err != nil {
		log.Printf("loadTools unmarshal: %v", err)
		return
	}
	restored, skipped := 0, 0
	for _, s := range states {
		// FR-EM-14: 어떤 탭도 참조하지 않는 도구는 어느 UI 에서도 도달할 수
		// 없다. 되살리면 부팅마다 셸이 누적되기만 한다.
		if _, ok := referenced[s.ID]; !ok {
			skipped++
			continue
		}
		if err := m.Restore(s.ID, s.Name, s.Cwd, 120, 40); err != nil {
			log.Printf("[tool %s] restore error: %v", s.ID, err)
			continue
		}
		restored++
	}
	if skipped > 0 {
		log.Printf("tools: 미참조 %d개 폐기", skipped)
	}
	// Mark mutated so the next SaveAll (e.g. on shutdown) persists CWD changes
	// that happen after restore, even if no tools were created/deleted.
	m.mutated.Store(true)
	log.Printf("tools restored count=%d", restored)
}

// Snapshot locks + copies tool pointers; used by adapters.
func (m *ToolManager) Snapshot() []*Tool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		out = append(out, p)
	}
	return out
}
