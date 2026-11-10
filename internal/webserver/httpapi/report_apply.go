package httpapi

import (
	"encoding/json"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmlog"
)

// ApplyReport 는 데몬이 넘긴 보고 하나다 (AGENT_RECORD_DAEMON_SRS §3.2a). 같은 보고의 HTTP
// 처리기와 같은 함수를 지나므로 알람·방송·Run 맥락 관측이 한 자리에 남는다. 데몬이 이미
// 거른 보고지만 같은 검사를 다시 한다.
func (s *Server) ApplyReport(method string, body json.RawMessage) {
	var err error
	switch method {
	case agentrec.MethodActivity:
		var r agentrec.ActivityReport
		if err = json.Unmarshal(body, &r); err == nil {
			if code := s.applyActivityReport(r); code != "" {
				dmlog.Warnf(nil, "report: 활동 보고를 받지 않았다(%s)", code)
			}
		}
	case agentrec.MethodUsage:
		var r agentrec.UsageReport
		if err = json.Unmarshal(body, &r); err == nil && r.ToolID != "" {
			s.applyUsageReport(r)
		}
	case agentrec.MethodSubagents:
		var r agentrec.SubagentsReport
		if err = json.Unmarshal(body, &r); err == nil && r.ToolID != "" {
			s.applySubagentsReport(r)
		}
	case agentrec.MethodNotify:
		var r agentrec.NotifyReport
		if err = json.Unmarshal(body, &r); err == nil && r.ToolID != "" {
			s.applyNotifyReport(r)
		}
	default:
		dmlog.Warnf(nil, "report: 모르는 보고 %q", method)
	}
	if err != nil {
		dmlog.Warnf(nil, "report: %s 를 읽지 못했다: %v", method, err)
	}
}
