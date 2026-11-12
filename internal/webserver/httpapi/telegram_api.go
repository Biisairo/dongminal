package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/telegram"
	"dongminal/internal/webserver/httpresp"
)

// 로컬 API `/api/telegram/*` (TELEGRAM_BRIDGE_SRS FR-TGB-1~5·10~11). 본문 오류는 fs 방언
// `{code,message}` 다. token 은 받기만 하고 응답·로그에 싣지 않는다 (FR-TGB-3).

// tgTokenRe 는 BotFather token 의 모양이다. token 은 URL 경로에 들어가므로 다른 글자를 거른다.
var tgTokenRe = regexp.MustCompile(`^[0-9]{1,20}:[A-Za-z0-9_-]{30,64}$`)

// tgGetMeTimeout 은 token 확인의 상한이다.
const tgGetMeTimeout = 10 * time.Second

type telegramPairView struct {
	Expires time.Time `json:"expires"`
}

// telegramView 는 GET /api/telegram 이다. 진행 중 코드는 만료만 싣는다.
type telegramView struct {
	telegram.View
	Pair *telegramPairView `json:"pair"`
}

func (s *Server) telegramReady(w http.ResponseWriter) bool {
	if s.tg == nil || s.tg.bridge == nil {
		peerFail(w, http.StatusServiceUnavailable, apierr.CodeTelegramUnavailable, "telegram bridge unavailable")
		return false
	}
	return true
}

func (s *Server) telegramView() telegramView {
	v := telegramView{View: s.tg.st.View()}
	if exp, ok := s.tg.bridge.Pairing().Pending(); ok {
		v.Pair = &telegramPairView{Expires: exp}
	}
	return v
}

// telegramSaved 는 저장 오류를 답하거나 바뀐 화면 값을 돌려준다.
func (s *Server) telegramSaved(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		httpresp.JSON(w, http.StatusOK, s.telegramView())
	case errors.Is(err, telegram.ErrInvalidSilence):
		peerFail(w, http.StatusBadRequest, apierr.CodeTelegramConfigInvalid, err.Error())
	default:
		peerFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, "save failed")
	}
}

func (s *Server) apiTelegramGet(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	httpresp.JSON(w, http.StatusOK, s.telegramView())
}

// apiTelegramToken 은 token 을 getMe 로 확인하고 저장한다 (FR-TGB-4). 바뀌면 허용 계정과
// 토픽이 지워진다 (FR-TGB-5).
func (s *Server) apiTelegramToken(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	var in struct {
		Token string `json:"token"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	if !tgTokenRe.MatchString(in.Token) {
		peerFail(w, http.StatusBadRequest, apierr.CodeTelegramTokenInvalid, "token is malformed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), tgGetMeTimeout)
	defer cancel()
	me, err := telegram.NewClient(s.cfg.TelegramAPI, in.Token, nil).GetMe(ctx)
	var apiErr *telegram.APIError
	switch {
	case errors.As(err, &apiErr):
		peerFail(w, http.StatusBadRequest, apierr.CodeTelegramTokenInvalid, "telegram rejected the token")
		return
	case err != nil:
		dmlog.Infof(nil, "telegram: token 확인 실패: %v", err)
		peerFail(w, http.StatusBadGateway, apierr.CodeTelegramUnreachable, "telegram unreachable")
		return
	case !me.HasTopicsEnabled:
		peerFail(w, http.StatusBadRequest, apierr.CodeTelegramTopicsDisabled, "threaded mode is off for this bot")
		return
	}
	// 바꾸기 전에 만든 등록 코드는 그 봇을 위한 것이다. 허용 계정과 함께 버린다.
	s.tg.bridge.Pairing().Cancel()
	s.telegramSaved(w, s.tg.st.SetToken(in.Token, me.Username))
}

func (s *Server) apiTelegramEnabled(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	s.telegramSaved(w, s.tg.st.SetEnabled(in.Enabled))
}

func (s *Server) apiTelegramSilence(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	var in struct {
		Minutes int `json:"minutes"`
	}
	if !peerReadJSON(w, r, &in) {
		return
	}
	s.telegramSaved(w, s.tg.st.SetSilence(in.Minutes))
}

// apiTelegramPair 는 등록 코드를 만든다 (FR-TGB-10). 코드는 이 응답에만 있다.
func (s *Server) apiTelegramPair(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	if !s.tg.st.View().TokenSet {
		peerFail(w, http.StatusConflict, apierr.CodeTelegramNoToken, "no bot token")
		return
	}
	code, exp := s.tg.bridge.Pairing().Issue()
	if code == "" {
		peerFail(w, http.StatusInternalServerError, apierr.CodeInternal, "could not make a code")
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"code": code, "expires": exp})
}

// apiTelegramUnpair 는 허용 계정을 지우고 살아 있는 코드도 죽인다.
func (s *Server) apiTelegramUnpair(w http.ResponseWriter, r *http.Request) {
	if !s.telegramReady(w) {
		return
	}
	s.tg.bridge.Pairing().Cancel()
	s.telegramSaved(w, s.tg.st.SetUser(0))
}
