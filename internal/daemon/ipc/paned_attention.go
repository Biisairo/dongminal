package ipc

import (
	"errors"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 3 — 알람 판정은 데몬 Tool 이 한다 (FR-ARD-30~32, §3.3a).
// 서버는 attn push 를 받아 거울과 방송만 한다.

// wireAttention 은 도구의 알림을 현재 연결의 attn push 로 잇는다. 도구를 만들 때 실리므로
// 도구보다 먼저 불러야 한다 — boot.Run 이 PanedServer 를 LoadAll 앞에서 만든다.
func (ps *PanedServer) wireAttention() {
	ps.pm.SetAttentionNotifier(func(id, reason string) {
		ps.pushAttn(id, toolipc.AttnKindAttention, reason)
	}, func(id string) {
		ps.pushAttn(id, toolipc.AttnKindClear, "")
	})
	ps.pm.SetActivityNotifier(func(id, _, _, _ string) {
		ps.pushAttn(id, toolipc.AttnKindActivity, "")
	})
}

// pushAttn 은 알린 뒤의 상태를 실어 보낸다. attn push 를 모르는 서버나 서버가 없으면
// 보내지 않는다 — 판정은 이미 상태에 남았다 (FR-ARD-25). push 는 버리지 않는다.
func (ps *PanedServer) pushAttn(id, kind, reason string) {
	ps.mu.Lock()
	c := ps.currConn
	ps.mu.Unlock()
	if c == nil || !c.attention.Load() {
		return
	}
	p := ps.pm.Get(id)
	if p == nil {
		return
	}
	c.enqueue(toolipc.AttnEvent{Event: toolipc.EventAttn, Tool: id, Kind: kind, Reason: reason, Agent: p.AgentState()}, false)
}

// attnConfig 는 서버가 붙을 때 보내는 판정 설정이다 (FR-ARD-31).
func (pc *panedConn) attnConfig(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.AttnConfigParams](req)
	if perr != nil {
		return *perr
	}
	pc.pm.SetAttentionConfig(time.Duration(p.IdleMS)*time.Millisecond, p.AllowBell)
	return okResp(req, struct{}{})
}

// attend 는 알람 해제다 (FR-ARD-32). 없는 도구는 종전 HTTP 처럼 무동작이다.
func (pc *panedConn) attend(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.AttendParams](req)
	if perr != nil {
		return *perr
	}
	switch t := pc.pm.Get(p.Tool); {
	case t == nil:
	case p.Typed:
		t.AttendTyped()
	default:
		t.Attend()
	}
	return okResp(req, struct{}{})
}

// report 는 서버 HTTP 로 온 보고다. 요청한 연결이 곧 서버이므로 옛 서버 검사는 없다.
func (pc *panedConn) report(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.ReportParams](req)
	if perr != nil {
		return *perr
	}
	if !agentrec.KnownMethod(p.Method) {
		return errResp(req, toolipc.CodeInvalidParams, errReportMethod)
	}
	if pc.srv == nil {
		return errResp(req, toolipc.CodeInvalidParams, errNoServer)
	}
	if err := pc.srv.acceptReport(pc, p.Method, p.Body); err != nil {
		code := toolipc.CodeInvalidParams
		if errors.Is(err, toolhub.ErrToolNotFound) {
			code = toolipc.CodeNotFound
		}
		return errResp(req, code, err)
	}
	return okResp(req, struct{}{})
}

var errNoServer = errors.New("연결이 데몬에 실리지 않았다")
