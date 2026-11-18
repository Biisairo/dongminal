package httpapi

import (
	"encoding/json"
	"net/http"
	"sync"

	"dongminal/internal/shared/toolipc"
)

// 로컬 API `/api/profile` (PROFILE_NAME_SRS §3.2). 이름은 노드 설정(`edges.json`)에 있으므로
// 노드의 연산으로 넘긴다 — 데몬 모드에서도 같은 길이다.

func (s *Server) apiProfileGet(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "profile", false)
}

func (s *Server) apiProfilePut(w http.ResponseWriter, r *http.Request) {
	s.edgeDo(w, r, "profile_name", true)
}

// handleCache 는 핸들을 기억한다. 노드 설정이 바뀌면(edgesChanged) 버린다. gen 은 묻는 동안
// 버려졌으면 옛 답을 기억하지 않게 한다 (PROFILE_NAME_SRS NFR-PFN-3).
type handleCache struct {
	mu  sync.Mutex
	val string
	gen uint64
}

func (c *handleCache) invalidate() {
	c.mu.Lock()
	c.val = ""
	c.gen++
	c.mu.Unlock()
}

// profileHandle 은 이 기기의 `이름#번호` 다. 노드가 없거나 답하지 못하면 빈 값이고, 그 결과는
// 기억하지 않는다.
func (s *Server) profileHandle() string {
	s.handle.mu.Lock()
	v, gen := s.handle.val, s.handle.gen
	s.handle.mu.Unlock()
	if v != "" {
		return v
	}
	v = s.askHandle()
	if v != "" {
		s.handle.mu.Lock()
		if s.handle.gen == gen {
			s.handle.val = v
		}
		s.handle.mu.Unlock()
	}
	return v
}

// askHandle 은 노드(데몬)에 핸들을 묻는다. IPC 한 번이다. 데몬이 없거나 준비되지 않았으면
// 빈 값이다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-23).
func (s *Server) askHandle() string {
	if s.EdgeDaemon == nil || !s.EdgeDaemon.EdgeReady() {
		return ""
	}
	res, err := s.EdgeDaemon.Edge(toolipc.EdgeParams{Op: "profile"})
	if err != nil || res.Code != "" {
		return ""
	}
	var v struct {
		Handle string `json:"handle"`
	}
	if json.Unmarshal(res.Body, &v) != nil {
		return ""
	}
	return v.Handle
}
