package httpapi

import (
	"errors"
	"net/http"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
)

// AttentionDaemon 은 데몬의 알람 판정이다 (AGENT_RECORD_DAEMON_SRS §3.3a). Judges 가 참이면
// 서버는 판정하지 않는다 — 보고·해제를 데몬에 넘기고, 결과는 attn push 로 거울에 온다.
type AttentionDaemon interface {
	// Judges 는 지금 붙은 데몬이 판정하는가다. 부를 때마다 묻는다.
	Judges() bool
	// Report 는 HTTP 로 온 보고를 데몬에 넘긴다. 데몬이 거절하면 *toolipc.RPCError 다.
	Report(method string, body any) error
	Attend(toolID string, typed bool) error
	AttendAll() (int, error)
}

func (s *Server) daemonJudges() bool { return s.AttnDaemon != nil && s.AttnDaemon.Judges() }

// forwardReport 는 데몬이 판정하면 보고를 넘기고 응답까지 쓴 뒤 참을 돌려준다. 없는 도구는
// 종전처럼 200 무동작이고, 넘기지 못하면 503 이다 — 서버가 대신 판정하지 않는다.
func (s *Server) forwardReport(w http.ResponseWriter, method string, body any) bool {
	if !s.daemonJudges() {
		return false
	}
	var re *toolipc.RPCError
	switch err := s.AttnDaemon.Report(method, body); {
	case err == nil, errors.As(err, &re) && re.Code == toolipc.CodeNotFound:
		httpresp.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		dmlog.Warnf(nil, "attention: %s 보고를 데몬에 넘기지 못했다: %v", method, err)
		httpErr(w, "daemon unavailable", http.StatusServiceUnavailable, apierr.CodeToolsUnready)
	}
	return true
}
