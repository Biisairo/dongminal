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
}

// OpenSpawnLog 은 path 를 읽는다. 없거나 망가졌으면 빈 기록으로 선다.
func OpenSpawnLog(path string) *SpawnLog {
	l := &SpawnLog{path: path, owner: map[string]string{}}
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

// DirAllowed 는 dir 의 실제 경로(심볼릭 링크를 푼 것)가 allowed 중 하나와 같거나 그
// 아래인가다 (FR-PNW-59). 맞으면 그 실제 경로를 돌려준다. allowed 가 비면 언제나 거짓이다.
func DirAllowed(dir string, allowed []string) (string, bool) {
	if !filepath.IsAbs(dir) {
		return "", false
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", false
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", false
	}
	for _, a := range allowed {
		base, err := filepath.EvalSymlinks(a)
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
