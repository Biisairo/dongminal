package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/claudeacct"
	"dongminal/internal/webserver/httpresp"
)

// 로컬 API `/api/claude-accounts/*` (CLAUDE_ACCOUNTS_SRS FR-CAC-120·121). 본문 오류는 fs 방언
// `{code,message}` 다. 응답에는 토큰이 없다 (FR-CAC-9).

type claudeAccountsView struct {
	ActiveID string                   `json:"activeId"`
	Accounts []claudeacct.AccountView `json:"accounts"`
}

func (s *Server) claudeAccountsReady(w http.ResponseWriter) bool {
	if s.ca == nil {
		peerFail(w, http.StatusServiceUnavailable, apierr.CodeClaudeAccountsUnavailable, "claude accounts unavailable")
		return false
	}
	return true
}

// claudeAccountsFail 은 도메인 오류를 상태와 코드로 옮긴다.
func claudeAccountsFail(w http.ResponseWriter, err error) {
	type row struct {
		err    error
		status int
		code   string
	}
	for _, r := range []row{
		{claudeacct.ErrNotFound, http.StatusNotFound, apierr.CodeClaudeAccountNotFound},
		{claudeacct.ErrInvalid, http.StatusBadRequest, apierr.CodeClaudeAccountInvalid},
		{claudeacct.ErrInvalidID, http.StatusBadRequest, apierr.CodeClaudeAccountInvalid},
		{claudeacct.ErrNotLoggedIn, http.StatusConflict, apierr.CodeClaudeNotLoggedIn},
		{claudeacct.ErrNoCredentials, http.StatusConflict, apierr.CodeClaudeNotLoggedIn},
		{claudeacct.ErrEmptyBackup, http.StatusConflict, apierr.CodeClaudeBackupEmpty},
		{claudeacct.ErrClaudeLockTimeout, http.StatusConflict, apierr.CodeClaudeLocked},
		{claudeacct.ErrLiveChanged, http.StatusConflict, apierr.CodeClaudeLiveChanged},
		{claudeacct.ErrNoCandidate, http.StatusConflict, apierr.CodeClaudeNoCandidate},
		{claudeacct.ErrKeychainUnavailable, http.StatusServiceUnavailable, apierr.CodeClaudeKeychain},
		{claudeacct.ErrTooSoon, http.StatusConflict, apierr.CodeClaudeTooSoon},
	} {
		if errors.Is(err, r.err) {
			peerFail(w, r.status, r.code, err.Error())
			return
		}
	}
	dmlog.Infof(nil, "claude-accounts: %v", err)
	peerFail(w, http.StatusInternalServerError, apierr.CodeInternal, "claude accounts operation failed")
}

func (s *Server) apiClaudeAccountsList(w http.ResponseWriter, _ *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	st, err := s.ca.svc.Store.Load()
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	v := claudeAccountsView{ActiveID: st.ActiveID, Accounts: claudeacct.BuildViews(st, s.ca.eng.Rows(), time.Now().Unix())}
	httpresp.JSON(w, http.StatusOK, v)
}

func (s *Server) apiClaudeAccountsAdd(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	a, created, err := s.ca.svc.AddCurrent(r.Context())
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	s.ca.eng.Wake()
	s.claudeAccountsChanged()
	httpresp.JSON(w, http.StatusOK, map[string]any{"account": a, "created": created})
}

type claudeAccountItemReq struct {
	ID string `json:"id"`
	claudeacct.Patch
}

func (s *Server) apiClaudeAccountsItem(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req claudeAccountItemReq
	if !peerReadJSON(w, r, &req) {
		return
	}
	a, err := s.ca.svc.Update(req.ID, req.Patch)
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	s.claudeAccountsChanged()
	httpresp.JSON(w, http.StatusOK, a)
}

func (s *Server) apiClaudeAccountsRemove(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	if err := s.ca.svc.Remove(req.ID); err != nil {
		claudeAccountsFail(w, err)
		return
	}
	s.claudeAccountsChanged()
	httpresp.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) apiClaudeAccountsOrder(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	if err := s.ca.svc.Reorder(req.IDs); err != nil {
		claudeAccountsFail(w, err)
		return
	}
	s.claudeAccountsChanged()
	httpresp.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) apiClaudeAccountsSwitch(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		ID       string `json:"id"`
		Strategy string `json:"strategy"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	var (
		res claudeacct.SwitchResult
		err error
	)
	switch {
	case req.ID != "":
		res, err = s.ca.svc.Switch(r.Context(), req.ID)
	case req.Strategy == "next":
		res, err = s.ca.svc.SwitchNext(r.Context())
	default:
		peerFail(w, http.StatusBadRequest, apierr.CodeClaudeAccountInvalid, "id 또는 strategy(next) 가 필요합니다")
		return
	}
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	if !res.NoOp {
		s.ca.eng.Wake()
		s.claudeAccountsChanged()
	}
	httpresp.JSON(w, http.StatusOK, res)
}

// apiClaudeAccountsRefresh 는 계정 하나를 바로 조회한다 (FR-CAC-58).
func (s *Server) apiClaudeAccountsRefresh(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		ID     string `json:"id"`
		Resets bool   `json:"resets"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	fetch := s.ca.eng.FetchNow
	if req.Resets {
		fetch = s.ca.eng.FetchResetsNow // FR-CAC-65: 계정 줄을 펼칠 때 — 두 초기화 상태만
	}
	if err := fetch(r.Context(), req.ID); err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// apiClaudeAccountsReset 은 제한 초기화 하나를 쓴다 (FR-CAC-62·63·65). 사용자가 확인한 뒤에만 불린다.
// 결과(`reset`·`already_used`·`unconfirmed` 등)는 언제나 200 이다.
func (s *Server) apiClaudeAccountsReset(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var req struct {
		ID      string `json:"id"`
		Program string `json:"program"`
		GrantID string `json:"grantId"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	// 브라우저가 끊겨도 보낸 사용은 끝까지 기다린다 — 중간에 끊으면 결과를 모르는 채로 자원만 쓴다. 제한은 25초다.
	res, err := s.ca.eng.Claim(context.WithoutCancel(r.Context()), req.ID, req.Program, req.GrantID)
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, res)
}
