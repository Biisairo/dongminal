package ipc

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 2 — 보고 소켓 (FR-ARD-20~22·25, §3.2a).
//
// 서버 연결 소켓은 연결을 하나씩 받고 그 하나를 서버가 쥔다 (IPC-24). 그래서 dmctl 의
// 훅 보고는 따로 연 이 소켓으로 받는다. 받는 메서드는 넷뿐이고 PTY 를 건드리지 않는다.

var (
	errReportMethod    = errors.New("보고 소켓이 받지 않는 메서드다")
	errReportOldServer = errors.New("붙은 서버가 report push 를 모른다")
	errReportToolID    = errors.New("toolId 가 비었다")
	errReportState     = errors.New("활동 상태가 틀렸다")
)

// ListenReports 는 path 에 보고 소켓을 연다. 폴더는 0700, 소켓은 0600 이다 (NFR-ARD-2).
func (ps *PanedServer) ListenReports(path string) error {
	transport := platform.Current().IPC
	transport.Remove(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	ln, err := transport.Listen(path)
	if err != nil {
		return err
	}
	ps.mu.Lock()
	ps.reportLn, ps.reportPath = ln, path
	ps.mu.Unlock()
	return nil
}

// ServeReports 는 보고 소켓의 연결을 받는다. 연결마다 고루틴 하나가 요청 하나에 답하고
// 닫는다. 리스너가 닫히면 돌아온다.
func (ps *PanedServer) ServeReports() {
	ps.mu.Lock()
	ln := ps.reportLn
	ps.mu.Unlock()
	if ln == nil {
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go ps.serveReport(c)
	}
}

func (ps *PanedServer) serveReport(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(agentrec.IOTimeout))
	var rq agentrec.Request
	if err := json.NewDecoder(c).Decode(&rq); err != nil {
		return
	}
	if err := json.NewEncoder(c).Encode(ps.handleReport(rq)); err != nil {
		dmlog.Warnf(nil, "report: 응답을 쓰지 못했다: %v", err)
	}
}

// handleReport 는 보고 하나를 데몬 기록에 반영하고, 붙은 서버에 보고 그대로 push 한다.
func (ps *PanedServer) handleReport(rq agentrec.Request) agentrec.Reply {
	if !agentrec.KnownMethod(rq.Method) {
		return agentrec.Reply{Error: errReportMethod.Error() + ": " + rq.Method}
	}
	ps.mu.Lock()
	c := ps.currConn
	ps.mu.Unlock()
	// 옛 서버는 push 를 버린다. 받으면 카드·알람이 사라지므로 거절해 HTTP 로 돌린다.
	if c != nil && !c.reports.Load() {
		return agentrec.Reply{Error: errReportOldServer.Error()}
	}
	ps.reportMu.Lock()
	err := ps.applyReport(rq.Method, rq.Body, time.Now())
	ps.reportMu.Unlock()
	if err != nil {
		return agentrec.Reply{Error: err.Error()}
	}
	if c != nil {
		c.enqueue(toolipc.ReportEvent{Event: toolipc.EventReport, Method: rq.Method, Body: rq.Body}, false)
	}
	return agentrec.Reply{OK: true}
}

// applyReport 는 보고를 데몬 기록에 쓴다. 기록의 record push 는 보내지 않는다 — 서버가
// 보고 push 를 같은 함수로 처리하고 그 결과를 되쓴다 (§3.2a).
func (ps *PanedServer) applyReport(method string, body json.RawMessage, now time.Time) error {
	switch method {
	case agentrec.MethodActivity:
		var r agentrec.ActivityReport
		p, err := ps.reportTool(body, &r, func() string { return r.ToolID })
		if err != nil {
			return err
		}
		return applyActivityReport(p, r, now)
	case agentrec.MethodUsage:
		var r agentrec.UsageReport
		p, err := ps.reportTool(body, &r, func() string { return r.ToolID })
		if err != nil {
			return err
		}
		setRecordJSON(p, toolipc.RecordUsage, agentrec.Usage{Usage: r.Usage, ObservedAt: now.UnixMilli()})
		if agent, ok := agentadapter.StatusLineReporter(); ok && len(r.Usage.RateLimits) > 0 {
			ps.records.update(toolipc.RecordLimits, func(old json.RawMessage) any {
				var m map[string]agentrec.LimitRecord
				if len(old) > 0 {
					_ = json.Unmarshal(old, &m)
				}
				return agentrec.MergeLimits(m, agent, r.Usage.RateLimits, now)
			})
		}
	case agentrec.MethodSubagents:
		var r agentrec.SubagentsReport
		p, err := ps.reportTool(body, &r, func() string { return r.ToolID })
		if err != nil {
			return err
		}
		setRecordJSON(p, toolipc.RecordSubagents, agentrec.SubagentList{Tasks: r.Tasks, ObservedAt: now.UnixMilli()})
	case agentrec.MethodNotify:
		var r agentrec.NotifyReport
		p, err := ps.reportTool(body, &r, func() string { return r.ToolID })
		if err != nil {
			return err
		}
		p.SignalAttention(agentrec.NotifyReason(r.Reason))
	}
	return nil
}

// reportTool 은 본문을 v 에 읽고 그 toolId 의 살아 있는 도구를 찾는다 (FR-ARD-22).
func (ps *PanedServer) reportTool(body json.RawMessage, v any, toolID func() string) (*toolhub.Tool, error) {
	if err := json.Unmarshal(body, v); err != nil {
		return nil, err
	}
	id := toolID()
	if id == "" {
		return nil, errReportToolID
	}
	p := ps.pm.Get(id)
	if p == nil {
		return nil, toolhub.ErrToolNotFound
	}
	return p, nil
}

func applyActivityReport(p *toolhub.Tool, r agentrec.ActivityReport, now time.Time) error {
	if !activity.Valid(r.State) {
		return errReportState
	}
	if r.AgentID != "" {
		if !agentrec.ValidSubagentState(r.State) {
			return errReportState
		}
		var acts map[string]agentrec.SubagentActivity
		if old, ok := p.Records()[toolipc.RecordSubagentActs]; ok {
			_ = json.Unmarshal(old, &acts)
		}
		setRecordJSON(p, toolipc.RecordSubagentActs, agentrec.PutSubagentActivity(acts, r.AgentID, agentrec.SubagentActivityOf(r), now))
		return nil
	}
	p.ReportActivity(r.State, agentrec.Sanitize(r.Tool, agentrec.ToolMax), agentrec.Sanitize(r.Detail, agentrec.DetailMax),
		r.UserPrompt, agentrec.AgentReportsUserTurn(r.Agent))
	if r.State == activity.Ended {
		p.SetRecord(toolipc.RecordSubagentActs, nil)
	}
	return nil
}

func setRecordJSON(p *toolhub.Tool, kind string, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		dmlog.Warnf(nil, "report: %s 를 쓰지 못했다: %v", kind, err)
		return
	}
	p.SetRecord(kind, raw)
}
