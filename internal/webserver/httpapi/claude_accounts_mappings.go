package httpapi

import (
	"net/http"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/claudeacct"
	"dongminal/internal/webserver/httpresp"
)

// 계정별 실행 (CLAUDE_ACCOUNTS_SRS 묶음 H): 폴더 매핑·탭 지정·해석·실행 준비.

// claudePruneTabs 는 도구 목록을 아는 때에만, 살아 있지 않은 도구의 탭 지정을 지운다 (FR-CAC-81a).
// 목록을 모르는 동안(데몬 재접속 창)에는 지우지 않는다 — 재기동 뒤 같은 toolId 로 되살아날 탭이다.
func (s *Server) claudePruneTabs() {
	if s.Tools == nil {
		return
	}
	tools, known := s.Tools.ListOK()
	if !known {
		return
	}
	live := make(map[string]bool, len(tools))
	for _, t := range tools {
		live[t.ID] = true
	}
	changed, err := s.ca.svc.PruneTabs(func(id string) bool { return live[id] })
	if err != nil {
		dmlog.Infof(nil, "claude-accounts: 탭 지정을 정리하지 못했다: %v", err)
		return
	}
	if changed {
		s.claudeAccountsChanged()
	}
}

func (s *Server) claudeMappingsReply(w http.ResponseWriter) {
	m, err := s.ca.svc.Mappings()
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, m)
}

func (s *Server) apiClaudeAccountsMappingsGet(w http.ResponseWriter, _ *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	s.claudePruneTabs()
	s.claudeMappingsReply(w)
}

// apiClaudeAccountsMappingsPut 은 `{folder|toolId, accountId}` 하나를 고친다. accountId 가 비면 푼다.
func (s *Server) apiClaudeAccountsMappingsPut(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		Folder    string `json:"folder"`
		ToolID    string `json:"toolId"`
		AccountID string `json:"accountId"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	if (req.Folder == "") == (req.ToolID == "") {
		peerFail(w, http.StatusBadRequest, apierr.CodeClaudeAccountInvalid, "folder 와 toolId 중 하나만 주세요")
		return
	}
	var err error
	if req.Folder != "" {
		err = s.ca.svc.SetFolder(req.Folder, req.AccountID)
	} else {
		err = s.ca.svc.SetTab(req.ToolID, req.AccountID)
	}
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	s.claudeAccountsChanged()
	s.claudeMappingsReply(w)
}

// apiClaudeAccountsResolve 는 해석만 한다. 프로필을 맞추지 않는다 (FR-CAC-88).
func (s *Server) apiClaudeAccountsResolve(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	s.claudePruneTabs()
	q := r.URL.Query()
	res, err := s.ca.svc.Resolve(q.Get("toolId"), q.Get("cwd"))
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, res)
}

// apiClaudeAccountsLaunch 는 해석하고, 계정이 있으면 프로필을 맞춘다. shim 이 부른다 (FR-CAC-83·88).
func (s *Server) apiClaudeAccountsLaunch(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		ToolID string `json:"toolId"`
		Cwd    string `json:"cwd"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	s.claudePruneTabs()
	res, err := s.ca.svc.Resolve(req.ToolID, req.Cwd)
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	if res.AccountID == "" {
		httpresp.JSON(w, http.StatusOK, claudeacct.Resolution{Source: claudeacct.SourceNone})
		return
	}
	if _, _, err := s.ca.svc.PrepareProfile(res.AccountID); err != nil {
		dmlog.Infof(nil, "claude-accounts: 프로필을 맞추지 못했다: %v", err)
		peerFail(w, http.StatusInternalServerError, apierr.CodeInternal, "profile preparation failed")
		return
	}
	httpresp.JSON(w, http.StatusOK, res)
}
