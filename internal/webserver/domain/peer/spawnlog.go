package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// SpawnLog 은 agent.spawn 으로 만든 도구와 띄운 짝의 지문이다 (FR-PNW-62·63).
// 서버를 다시 시작해도 남아야 하므로 파일에 둔다.
type SpawnLog struct {
	mu    sync.Mutex
	path  string
	owner map[string]string
	// inflight 는 짝마다 만드는 중인 spawn 수다. 기록 전이라 owner 에 아직 없다.
	inflight map[string]int
}

// OpenSpawnLog 은 path 를 읽는다. 없거나 망가졌으면 빈 기록으로 선다.
func OpenSpawnLog(path string) *SpawnLog {
	l := &SpawnLog{path: path, owner: map[string]string{}, inflight: map[string]int{}}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			dmlog.Infof(nil, "loadPeerSpawns: %v", err)
		}
		return l
	}
	if err := json.Unmarshal(data, &l.owner); err != nil || l.owner == nil {
		dmlog.Infof(nil, "loadPeerSpawns: %v — 빈 기록으로 시작한다", err)
		l.owner = map[string]string{}
	}
	return l
}

func (l *SpawnLog) saveLocked() error {
	data, err := json.MarshalIndent(l.owner, "", "  ")
	if err != nil {
		return err
	}
	return platform.WriteFileAtomic(l.path, data, fileMode)
}

// Record 는 toolID 를 fp 가 띄웠다고 남긴다.
func (l *SpawnLog) Record(toolID, fp string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.owner[toolID] = fp
	return l.saveLocked()
}

// Reserve 는 fp 의 spawn 자리 하나를 잡는다 (I-31). 살아 있는 기록과 만드는 중인 것을
// 합쳐 max 이상이면 거짓이다. 셀 때 죽은 도구의 기록은 지운다(모든 짝의 것).
// 잡았으면 spawn 이 끝날 때 release 를 부른다.
func (l *SpawnLog) Reserve(fp string, max int, live func(toolID string) bool) (release func(), ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n, pruned := l.inflight[fp], false
	for id, owner := range l.owner {
		if !live(id) {
			delete(l.owner, id)
			pruned = true
			continue
		}
		if owner == fp {
			n++
		}
	}
	if pruned {
		if err := l.saveLocked(); err != nil {
			dmlog.Infof(nil, "peer-spawns 정리 저장 실패: %v", err)
		}
	}
	if n >= max {
		return nil, false
	}
	l.inflight[fp]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.inflight[fp]--; l.inflight[fp] <= 0 {
				delete(l.inflight, fp)
			}
		})
	}, true
}

// Owner 는 toolID 를 띄운 짝의 지문이다.
func (l *SpawnLog) Owner(toolID string) (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fp, ok := l.owner[toolID]
	return fp, ok
}

// Forget 은 toolID 의 기록을 지운다.
func (l *SpawnLog) Forget(toolID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.owner[toolID]; !ok {
		return nil
	}
	delete(l.owner, toolID)
	return l.saveLocked()
}

// DirAllowed 는 dir 의 실제 경로(심볼릭 링크를 푼 것, Windows 는 junction 까지 푼 것)가 allowed 중 하나와 같거나 그
// 아래인가다 (FR-PNW-59). 맞으면 그 실제 경로를 돌려준다. allowed 가 비면 언제나 거짓이다.
func DirAllowed(dir string, allowed []string) (string, bool) {
	if !filepath.IsAbs(dir) {
		return "", false
	}
	real, err := realDir(dir)
	if err != nil {
		return "", false
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", false
	}
	for _, a := range allowed {
		base, err := realDir(a)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(base, real)
		if err != nil {
			continue
		}
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			return real, true
		}
	}
	return "", false
}
