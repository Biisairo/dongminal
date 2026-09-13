package httpapi

import (
	"net/http"
	"path/filepath"
)

// /api/editors/* — Editor 목록 (EDITOR_TAB_SRS §3.11). 탐색기(/api/fs/*)와 같은
// 오류 규약(fsFail·fsJSON)을 쓴다 — 그쪽 파일에서 옮겨 왔다 (M8 GO-14, D-A-10).

// ── /api/editors/* ──────────────────────────────────

func (s *Server) fsEntries(w http.ResponseWriter) bool {
	if s.Entries == nil {
		fsFail(w, fsErrIO, "workspace 를 쓸 수 없다")
		return false
	}
	return true
}

// GET /api/editors — {home, notes, plugins, list}. 앞의 셋은 list 에 없다
// (FR-EDT-29·110, NOTES_LIVE_EXPLORER_SRS FR-NOT-3).
func (s *Server) apiEditorsGet(w http.ResponseWriter, r *http.Request) {
	if !s.fsEntries(w) {
		return
	}
	home, list, err := s.Entries.List()
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	out := map[string]any{"home": home, "list": list}
	// FR-NOT-11: 메모 루트를 얻지 못하는 것은 이 응답의 실패가 아니다 — 키가
	// 빠지고 클라이언트에는 메모장 행 하나가 없을 뿐이다.
	if notes, err := s.Entries.Notes(); err == nil {
		out["notes"] = notes
	}
	// FR-EXT-9b: 플러그인 선언의 자리도 같은 규약이다 — 얻지 못하면 키가 빠지고
	// 화면에는 그 행 하나가 없을 뿐이다.
	if plugins, err := s.Entries.Plugins(); err == nil {
		out["plugins"] = plugins
	}
	fsJSON(w, http.StatusOK, out)
}

type fsPathReq struct {
	Path string `json:"path"`
}

// POST /api/editors/add — 추가는 멱등이고, 응답은 두 목록을 함께 준다
// (FR-EDT-25·39·110).
func (s *Server) apiEditorsAdd(w http.ResponseWriter, r *http.Request) {
	var req fsPathReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	l, err := s.Entries.EditorAdd(r.Context(), req.Path)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": l.Editors, "pinned": l.Pinned})
}

// POST /api/editors/remove — 문자열 완전 일치다. 경로를 다시 정규화하지 않는다
// (FR-EDT-26).
func (s *Server) apiEditorsRemove(w http.ResponseWriter, r *http.Request) {
	var req fsPathReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	if !filepath.IsAbs(req.Path) {
		fsFail(w, fsErrBadRequest, "path 는 절대경로여야 한다")
		return
	}
	l, err := s.Entries.EditorRemove(req.Path)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": l.Editors, "pinned": l.Pinned})
}

type fsReorderReq struct {
	Src    string `json:"src"`
	Target string `json:"target"`
	Before bool   `json:"before"`
}

// POST /api/editors/reorder — 전체 배열이 아니라 델타다 (FR-EDT-27·110).
func (s *Server) apiEditorsReorder(w http.ResponseWriter, r *http.Request) {
	var req fsReorderReq
	if !fsDecode(w, r, &req) {
		return
	}
	if !s.fsEntries(w) {
		return
	}
	if req.Src == "" {
		fsFail(w, fsErrBadRequest, "src 가 없다")
		return
	}
	// FR-EDT-111: 경로 인자는 절대경로여야 한다. target 은 비어 있을 수 있다 —
	// 끌어다 놓은 곳이 사라지면 맨 끝이다.
	if !filepath.IsAbs(req.Src) || (req.Target != "" && !filepath.IsAbs(req.Target)) {
		fsFail(w, fsErrBadRequest, "src·target 은 절대경로여야 한다")
		return
	}
	list, err := s.Entries.EditorReorder(req.Src, req.Target, req.Before)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"list": list})
}
