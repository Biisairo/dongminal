package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/claudeacct"
	"dongminal/internal/webserver/httpresp"
)

// 로컬 API `/api/claude-accounts/*` (CLAUDE_ACCOUNTS_SRS FR-CAC-120·121). 본문 오류는 fs 방언
// `{code,message}` 다. 응답에는 토큰이 없다 (FR-CAC-9).

const (
	claudeHistoryDefault = 50
	claudeHistoryMax     = 1000
)

type claudeAccountsView struct {
	ActiveID   string                   `json:"activeId"`
	Accounts   []claudeacct.AccountView `json:"accounts"`
	Autoswitch claudeAutoSummary        `json:"autoswitch"`
	// OtherStatusLines 는 등록되지 않은 계정의 statusLine 값이다 (FR-CAC-78·93).
	OtherStatusLines []claudeacct.StatusLineView `json:"otherStatusLines"`
}

// claudeAutoSummary 는 foot 표식에 쓰는 자동 전환 요약이다 (FR-CAC-76·92).
type claudeAutoSummary struct {
	Enabled bool   `json:"enabled"`
	Status  string `json:"status"`
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
		{claudeacct.ErrLiveEmpty, http.StatusConflict, apierr.CodeClaudeNotLoggedIn},
		{claudeacct.ErrEmptyBackup, http.StatusConflict, apierr.CodeClaudeBackupEmpty},
		{claudeacct.ErrClaudeLockTimeout, http.StatusConflict, apierr.CodeClaudeLocked},
		{claudeacct.ErrLiveChanged, http.StatusConflict, apierr.CodeClaudeLiveChanged},
		{claudeacct.ErrNoCandidate, http.StatusConflict, apierr.CodeClaudeNoCandidate},
		{claudeacct.ErrKeychainUnavailable, http.StatusServiceUnavailable, apierr.CodeClaudeKeychain},
		{claudeacct.ErrTooSoon, http.StatusConflict, apierr.CodeClaudeTooSoon},
		{claudeacct.ErrCswapRunning, http.StatusConflict, apierr.CodeClaudeCswapRunning},
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
	av := s.ca.auto.View()
	now := time.Now().Unix()
	views := claudeacct.BuildViews(st, s.ca.eng.Rows(), now)
	for i := range views {
		if u, at, ok := s.ca.sl.get(views[i].Account); ok {
			views[i].StatusLine = claudeacct.StatusLineViewOf(u, at, now)
		}
		views[i].ProfileWarnings = s.ca.svc.ProfileWarnings(views[i].ID)
	}
	v := claudeAccountsView{ActiveID: st.ActiveID, Accounts: views,
		Autoswitch:       claudeAutoSummary{Enabled: av.Settings.Enabled, Status: av.State.Status},
		OtherStatusLines: s.ca.sl.others(st.Accounts, now)}
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
		By       string `json:"by"`
	}
	if !peerReadJSON(w, r, &req) {
		return
	}
	res, err := s.ca.eng.Switch(r.Context(), claudeacct.SwitchRequest{ID: req.ID, Strategy: req.Strategy, By: req.By})
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

// apiClaudeAccountsHistory 는 전환 기록이다 (FR-CAC-110a). 최신 먼저, limit 은 1~1000(기본 50).
func (s *Server) apiClaudeAccountsHistory(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	limit := claudeHistoryDefault
	if q := r.URL.Query().Get("limit"); q != "" {
		v, err := strconv.Atoi(q)
		if err != nil || v < 1 || v > claudeHistoryMax {
			peerFail(w, http.StatusBadRequest, apierr.CodeClaudeAccountInvalid, "limit 은 1~1000 입니다")
			return
		}
		limit = v
	}
	entries, err := claudeacct.ReadHistory(s.ca.svc.Dir, limit)
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// apiClaudeAccountsAutoswitchGet 은 자동 전환 설정과 상태다 (FR-CAC-76).
func (s *Server) apiClaudeAccountsAutoswitchGet(w http.ResponseWriter, _ *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	httpresp.JSON(w, http.StatusOK, s.ca.auto.View())
}

// apiClaudeAccountsAutoswitchPut 은 설정의 일부 키를 고친다 (FR-CAC-75·76).
func (s *Server) apiClaudeAccountsAutoswitchPut(w http.ResponseWriter, r *http.Request) {
	if !s.claudeAccountsReady(w) {
		return
	}
	var raw json.RawMessage
	if !peerReadJSON(w, r, &raw) {
		return
	}
	v, err := s.ca.auto.Put(raw)
	if err != nil {
		claudeAccountsFail(w, err)
		return
	}
	httpresp.JSON(w, http.StatusOK, v)
}
