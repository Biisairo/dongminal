package server

import (
	"net/http"

	"dongminal/internal/webserver/domain/git"
)

// /api/git/{preflight,policy,recovery} — 안전 정책 표면 (GIT_SRS §3A.3
// FR-GIT-86~93). 파괴적 경로가 열리기 전에 방어가 먼저 선다.

// GET /api/git/preflight?repo=<abs> — 커밋 실행 전 검사 (FR-GIT-86~88).
//
// 차단 사유는 **막힌 이유와 해소법을 함께** 실어 보낸다. 클라이언트가 그것을
// 그대로 보이며, 여기서 이유를 잃으면 사용자는 갈 곳이 없다.
func (s *Server) apiGitPreflight(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	pf, err := s.Git.Service().Preflight(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": requested,
		"repo":      root,
		"preflight": pf,
	})
}

// GET /api/git/policy — 파괴적 동작 목록 (FR-GIT-89).
//
// repo 를 받지 않는다 — 정책은 저장소마다 다르지 않다. 클라이언트는 이 목록으로
// 확인 절차를 켜므로 목록을 프론트에 복제하지 않는다.
func (s *Server) apiGitPolicy(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"destructive": git.DestructiveActions})
}

// GET /api/git/recovery — 세션 동안 기록된 recovery hint (FR-GIT-92·93).
func (s *Server) apiGitRecovery(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"hints": s.Git.Service().Hints(0)})
}
