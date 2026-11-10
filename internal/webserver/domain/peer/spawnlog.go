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

// realDirFn 은 실제 경로 풀기다. 테스트가 파일 시스템에 닿는지 세는 자리다.
var realDirFn = realDir

// DirAllowed 는 dir 의 실제 경로(심볼릭 링크를 푼 것, Windows 는 junction 까지 푼 것)가
// allowed 중 하나와 같거나 그 아래인가다 (FR-PNW-59). 맞으면 그 실제 경로를 돌려준다.
// allowed 가 비면 언제나 거짓이다.
//
// 원격이 준 dir 은 **글자로 먼저** 허용 폴더 아래인지 본 뒤에야 연다. 먼저 열면 허용 밖의
// 경로(`\\host\share`, `/net/host`)로 그 호스트에 접속하게 된다 (보안 재리뷰 #4). 허용
// 폴더는 이 노드의 사용자가 정한 값이라 풀어도 된다 — 원래 값과 푼 값 둘 다로 비교한다.
func DirAllowed(dir string, allowed []string) (string, bool) {
	if !filepath.IsAbs(dir) || len(allowed) == 0 {
		return "", false
	}
	clean := filepath.Clean(dir)
	bases := make([]string, 0, 2*len(allowed))
	lexical := false
	for _, a := range allowed {
		cands := []string{filepath.Clean(a)}
		if r, err := realDirFn(a); err == nil {
			cands = append(cands, r)
		}
		for _, b := range cands {
			lexical = lexical || within(b, clean)
		}
		bases = append(bases, cands[len(cands)-1])
	}
	if !lexical {
		return "", false
	}
	real, err := realDirFn(clean)
	if err != nil {
		return "", false
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", false
	}
	for _, b := range bases {
		if within(b, real) {
			return real, true
		}
	}
	return "", false
}

// within 은 p 가 base 와 같거나 그 아래인가다.
func within(base, p string) bool {
	rel, err := filepath.Rel(base, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
