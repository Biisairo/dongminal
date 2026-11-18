package swap

import (
	"encoding/json"
	"os"
	"path/filepath"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/uuid"
)

// 되찾기와 입양 (DAEMON_SESSION_KEEP_SRS FR-DSK-26~28).
//
// exec 뒤의 새 데몬은 인계 상태를 잃어도 PTY 마스터 fd 와 자식 셸을 여전히 쥐고 있다. 둘을
// 단말 이름으로 짝짓고, tools.json 에 적힌 셸 pid 로 어느 도구인지 안다 (D-DSK-14). OS 에
// 묻는 일은 platform 이 한다.

// Orphan 은 인계 상태 없이 찾은 셸 하나다.
type Orphan struct {
	FD  uintptr
	PID int
}

// FindOrphans 는 이 프로세스가 쥔 PTY 마스터 fd 중 claimed 에 없는 것을 직계 자식 셸과
// 짝짓는다 (FR-DSK-27 1·2).
func FindOrphans(claimed map[uintptr]bool) ([]Orphan, error) {
	masters, err := platform.PTYMasters(claimed)
	if err != nil || len(masters) == 0 {
		return nil, err
	}
	children, err := platform.ChildTTYs(os.Getpid())
	if err != nil {
		return nil, err
	}
	var out []Orphan
	taken := map[uintptr]bool{}
	for _, c := range children {
		fd, ok := masters[c.TTY]
		if !ok || taken[fd] {
			continue
		}
		taken[fd] = true
		out = append(out, Orphan{FD: fd, PID: c.PID})
	}
	return out, nil
}

// Recover 는 찾은 셸을 도구로 되세운다. tools.json 에 그 pid 가 적혀 있고 아직 없는 도구면
// 같은 id 로 되찾고 (FR-DSK-27 3~5), 아니면 새 id 의 백그라운드 도구로 입양한다 (FR-DSK-28).
// 어느 탭도 가리키지 않는 되찾은 도구도 백그라운드다.
func Recover(pm *toolhub.ToolManager, home string, refs map[string]struct{}, orphans []Orphan) (recovered, adopted int) {
	byPID := map[int]toolhub.ToolState{}
	for _, s := range toolStates(home) {
		if s.PID > 0 {
			byPID[s.PID] = s
		}
	}
	for _, o := range orphans {
		ht := toolhub.HandoverTool{FD: o.FD, PID: o.PID, Cols: toolhub.DefaultCols, Rows: toolhub.DefaultRows}
		s, known := byPID[o.PID]
		if known && pm.Get(s.ID) == nil {
			ht.ID, ht.Name, ht.Cwd = s.ID, s.Name, s.Cwd
			_, ref := refs[s.ID]
			ht.Background = !ref
		} else {
			known = false
			ht.ID = uuid.NewString()
			ht.Name = platform.CommandName(o.PID)
			ht.Background = true
		}
		if err := pm.AdoptHandover(ht); err != nil {
			dmlog.Errorf(nil, "셸 pid=%d 를 되찾지 못했다: %v", o.PID, err)
			continue
		}
		if known {
			recovered++
			dmlog.Infof(nil, "[tool %s] 인계 상태 없이 되찾음 pid=%d", ht.ID, o.PID)
		} else {
			adopted++
			dmlog.Warnf(nil, "[tool %s] 어느 도구인지 모르는 셸을 백그라운드로 입양 pid=%d", ht.ID, o.PID)
		}
	}
	return recovered, adopted
}

// toolStates 는 tools.json 의 도구들이다. 읽지 못하면 빈 목록이다.
func toolStates(home string) []toolhub.ToolState {
	blob, err := os.ReadFile(filepath.Join(home, dmenv.ToolsFile))
	if err != nil {
		return nil
	}
	var out []toolhub.ToolState
	if json.Unmarshal(blob, &out) != nil {
		return nil
	}
	return out
}

// CloseInheritedSockets 는 paths 에 묶인 유닉스 소켓 fd 를 모두 닫고 그 수를 돌려준다
// (FR-DSK-26). exec 로 넘어왔으나 쓰지 못한 리스너가 대상이다.
func CloseInheritedSockets(paths ...string) int { return platform.CloseSocketsBoundTo(paths...) }
