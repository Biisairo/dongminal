package httpapi

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/settingsschema"
	"dongminal/internal/webserver/fswatch"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/sse"
)

// fsWatchDirsMax 는 한 클라이언트가 등록할 수 있는 디렉터리 수다 (EDITOR_LIVE_RELOAD_SRS
// FR-ELR-51). 탐색기 겹(`fsStampMax`)과 열린 파일(`fileStampsMax`)의 상한을 더한 값이다.
const fsWatchDirsMax = fsStampMax + fileStampsMax

type fsWatchReq struct {
	ClientID string   `json:"clientId"`
	Dirs     []string `json:"dirs"`
}

// PUT /api/fs/watch — 그 클라이언트의 감시 집합을 통째로 바꾼다 (FR-ELR-51).
//
// 디렉터리마다 판정은 읽기와 같다(`fileAllow`). 통과하지 못한 것·없는 것·디렉터리가
// 아닌 것은 **빠진다** — 한 경로의 사정이 나머지 감시를 막지 않는다 (FR-ELR-5 와 같다).
func (s *Server) apiFSWatch(w http.ResponseWriter, r *http.Request) {
	var req fsWatchReq
	if !fsDecode(w, r, &req) {
		return
	}
	if len(req.Dirs) > fsWatchDirsMax {
		fsFail(w, fsErrBadRequest, "dirs 가 너무 많다")
		return
	}
	dirs := make([]fswatch.Dir, 0, len(req.Dirs))
	for _, d := range req.Dirs {
		target, den := s.fileAllow(d)
		if den != nil {
			continue
		}
		real, err := filepath.EvalSymlinks(target)
		if err != nil {
			continue
		}
		st, err := os.Stat(real)
		if err != nil || !st.IsDir() {
			continue
		}
		dirs = append(dirs, fswatch.Dir{Path: d, Real: real})
	}
	watching, err := s.fsWatch.Set(req.ClientID, dirs)
	if errors.Is(err, fswatch.ErrNotAttached) {
		fsFail(w, fsErrBadRequest, "SSE 구독이 없는 clientId")
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"watching": watching})
}

// fsChangedPayload 는 `fs_changed` 방송 본문이다 (FR-ELR-59).
func fsChangedPayload(changes []fswatch.Change, overflow bool) []byte {
	if overflow {
		return sse.Payload("fs_changed", map[string]any{"overflow": true})
	}
	out := make([]map[string]string, 0, len(changes))
	for _, c := range changes {
		out = append(out, map[string]string{"path": c.Path, "type": c.Kind.String()})
	}
	return sse.Payload("fs_changed", map[string]any{"changes": out})
}

// newFSWatch 는 감시자를 세운다. 이벤트는 방송하고, 같은 경로로 git 관측을 당긴다
// (FR-ELR-59·75).
func newFSWatch(cmds hub.CommandBroker, git *hub.GitWatcher) *fswatch.Manager {
	return fswatch.NewManager(fswatch.DefaultOptions(func(c []fswatch.Change, overflow bool) {
		if cmds != nil {
			cmds.Broadcast(fsChangedPayload(c, overflow))
		}
		if git != nil && len(c) > 0 {
			paths := make([]string, 0, len(c))
			for _, x := range c {
				paths = append(paths, x.Path)
			}
			git.Kick(paths)
		}
	}))
}

const gitWorktreeKey = "gitWorktreeInterval"

var gitWorktreeSpec = sync.OnceValue(func() settingsschema.Spec {
	specs, err := settingsschema.Load()
	if err != nil {
		return settingsschema.Spec{}
	}
	return settingsschema.ByKey(specs)[gitWorktreeKey]
})

// gitWorktreeRounds 는 설정 blob 에서 워크트리 회차 간격을 회차 수로 낸다 (FR-ELR-76).
// 값은 `GitWatchInterval` 로 나눠 올림한다. 읽을 수 없거나 범위 밖이면 표의 기본값이다.
func gitWorktreeRounds(blob []byte) uint64 {
	spec := gitWorktreeSpec()
	def, ok := spec.Def.(float64)
	if spec.Key == "" || !ok {
		return hub.GitWatchWorktreeEvery
	}
	ms := def
	var m map[string]any
	if len(blob) > 0 && json.Unmarshal(blob, &m) == nil {
		if v, ok := m[gitWorktreeKey].(float64); ok {
			if i := int(v); float64(i) == v &&
				(spec.Min == nil || i >= *spec.Min) &&
				(spec.Max == nil || i <= *spec.Max) {
				ms = v
			}
		}
	}
	return uint64(math.Ceil(ms / float64(hub.GitWatchInterval/time.Millisecond)))
}

// applyGitWorktree 는 지금 설정의 워크트리 회차 간격을 감시자에 얹는다 (FR-ELR-76).
// 기동 때와 설정 저장 뒤에 부른다 — 재시작 없이 다음 회차부터 적용된다.
func (s *Server) applyGitWorktree() {
	if s.gitWatch == nil || s.Settings == nil {
		return
	}
	s.gitWatch.SetWorktreeEvery(gitWorktreeRounds(s.Settings.Get()))
}
