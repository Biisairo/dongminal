package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpreq"
)

// 워크스페이스 되돌리기 (M5 `G4-7`).
//
// M3 이 상태 파일마다 **세대**를 남겼고 `dongminal rollback` 이 그것을 CLI 에서
// 되돌린다. 다만 그 명령은 **서버가 내려가 있어야** 쓸 수 있다 — 돌고 있으면 곧
// 자기 메모리로 덮어쓰기 때문이다. 화면에서 되돌릴 길이 이 종단이다.
//
// **기계를 새로 만들지 않는다.** 세대는 이미 있고, 되돌리기는 그중 하나를
// `Save` 로 올리는 것이 전부다. 그러면 직전 판이 세대 사슬의 맨 앞으로 들어가
// **되돌리기도 되돌릴 수 있게** 된다 — 새 장치 없이.

// workspaceFile 은 홈 안의 워크스페이스 파일 이름이다.
const workspaceFile = "workspace.json"

type revisionEntry struct {
	Gen      int    `json:"gen"`
	Bytes    int64  `json:"bytes"`
	Modified string `json:"modified"`
}

type revisionsBody struct {
	Rev         uint64          `json:"rev"`
	Generations []revisionEntry `json:"generations"`
}

// apiWorkspaceRevisions 는 되돌릴 수 있는 자리를 보인다.
//
// **읽히는지까지는 묻지 않는다** — `listGenerations`(CLI)와 같은 규약이다.
// 여기서 미리 걸러 내면 사용자가 고를 수 있는 것이 줄고, 깨진 세대의 거절은
// 되돌리는 순간에 일어나면 된다.
func (s *Server) apiWorkspaceRevisions(w http.ResponseWriter, r *http.Request) {
	out := revisionsBody{Generations: []revisionEntry{}}
	if s.Work != nil {
		out.Rev = s.Work.CurrentRev()
	}
	path := s.workspacePath()
	for i := 1; i <= platform.StateFileGenerations; i++ {
		st, err := os.Stat(fmt.Sprintf("%s.bak.%d", path, i))
		if err != nil {
			continue
		}
		out.Generations = append(out.Generations, revisionEntry{
			Gen:      i,
			Bytes:    st.Size(),
			Modified: st.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// apiWorkspaceRevert 는 세대 하나를 현재로 올린다.
func (s *Server) apiWorkspaceRevert(w http.ResponseWriter, r *http.Request) {
	if s.Work == nil {
		httpErr(w, "workspace unavailable", http.StatusInternalServerError, apierr.CodeWorkUnready)
		return
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), apierr.CodeBodyTooBig)
		return
	}
	var req struct {
		Gen int `json:"gen"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	// **파일을 만지기 전에** 범위를 본다 — 번호로 경로를 짓게 하지 않는다.
	if req.Gen < 1 || req.Gen > platform.StateFileGenerations {
		httpErr(w, "gen must be 1.."+strconv.Itoa(platform.StateFileGenerations),
			http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	src := fmt.Sprintf("%s.bak.%d", s.workspacePath(), req.Gen)
	blob, err := os.ReadFile(src)
	if err != nil {
		httpErr(w, "generation not found", http.StatusNotFound, apierr.CodeNotFound)
		return
	}
	// **깨진 세대를 올리지 않는다.** 되돌리기가 빈 판을 만들면 그것이 `FE-2` 다 —
	// 이 저장소가 P0 으로 닫은 바로 그 손실이다.
	if !json.Valid(blob) {
		httpErr(w, "generation is not valid JSON", http.StatusConflict, apierr.CodeConflict)
		return
	}
	// `Save` 가 인덱스를 다시 세우므로 스키마가 어긋나면 여기서 걸린다.
	//
	// `ifMatch` 를 비우는 것은 의도다 — 되돌리기는 "지금 판 위에서 고치는 것" 이
	// 아니라 "지금 판을 버리는 것" 이고, 그 판단은 사용자가 세대를 고르는 순간에
	// 이미 내려졌다.
	rev, err := s.Work.Save(blob, "")
	if err != nil {
		code := http.StatusConflict
		if err == workspace.ErrStale {
			code = http.StatusConflict
		}
		httpErr(w, "revert failed", code, apierr.CodeConflict)
		return
	}
	dmlog.Info(r.Context(), "workspace reverted", "gen", req.Gen, "rev", rev)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"rev": rev, "gen": req.Gen})
}

// workspacePath 는 워크스페이스 파일의 자리다. `DataDir` 이 비면 작업 디렉터리다
// (`newSettingsStore` 와 같은 규약).
func (s *Server) workspacePath() string {
	if s.cfg.DataDir != "" {
		return filepath.Join(s.cfg.DataDir, workspaceFile)
	}
	return workspaceFile
}
