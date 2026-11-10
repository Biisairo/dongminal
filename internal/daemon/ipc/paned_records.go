package ipc

import (
	"encoding/json"
	"errors"
	"maps"
	"sync"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 1 — 에이전트 기록 (FR-ARD-10~13, §3.1a).
//
// 도구별 기록은 Tool 에 매달려 도구와 함께 사라진다. 여기 있는 것은 도구 없는 전역
// 기록(계정 한도)과 두 메서드·push 다. 전역 기록은 연결이 아니라 데몬의 것이다 —
// 서버가 다시 붙어도 남는다.

type globalRecords struct {
	mu sync.Mutex
	m  map[string]json.RawMessage
}

func (g *globalRecords) set(kind string, v json.RawMessage) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(v) == 0 || string(v) == "null" {
		delete(g.m, kind)
		return
	}
	if g.m == nil {
		g.m = map[string]json.RawMessage{}
	}
	g.m[kind] = append(json.RawMessage(nil), v...)
}

// update 는 kind 의 값을 읽고 고쳐 쓴다. 잠금 안에서 한 번에 일어난다.
func (g *globalRecords) update(kind string, fn func(old json.RawMessage) any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	raw, err := json.Marshal(fn(g.m[kind]))
	if err != nil {
		dmlog.Warnf(nil, "records: %s 를 쓰지 못했다: %v", kind, err)
		return
	}
	if g.m == nil {
		g.m = map[string]json.RawMessage{}
	}
	g.m[kind] = raw
}

func (g *globalRecords) snapshot() map[string]json.RawMessage {
	g.mu.Lock()
	defer g.mu.Unlock()
	return maps.Clone(g.m)
}

var errRecordShape = errors.New("기록의 종류와 도구가 맞지 않는다")

// applyRecord 는 기록 하나를 쓴다 (recordset).
func applyRecord(pm *toolhub.ToolManager, g *globalRecords, kind, tool string, v json.RawMessage) (code int, err error) {
	global, ok := toolipc.RecordIsGlobal(kind)
	if !ok || global != (tool == "") || g == nil {
		return toolipc.CodeInvalidParams, errRecordShape
	}
	if global {
		g.set(kind, v)
		return 0, nil
	}
	p := pm.Get(tool)
	if p == nil {
		return toolipc.CodeNotFound, toolhub.ErrToolNotFound
	}
	if kind != toolipc.RecordAgent {
		p.SetRecord(kind, v)
		return 0, nil
	}
	var st toolhub.AgentState
	if err := json.Unmarshal(v, &st); err != nil {
		return toolipc.CodeInvalidParams, err
	}
	p.RestoreAgentState(st)
	return 0, nil
}

// recordSet 은 서버의 쓰기다 (FR-ARD-11). 보낸 연결에 되돌려 push 하지 않는다.
func (pc *panedConn) recordSet(req *toolipc.PanedRequest) interface{} {
	p, perr := decodeParams[toolipc.RecordSetParams](req)
	if perr != nil {
		return *perr
	}
	if code, err := applyRecord(pc.pm, pc.records, p.Kind, p.Tool, p.Value); err != nil {
		return errResp(req, code, err)
	}
	return okResp(req, struct{}{})
}

// recordsSnapshot 은 서버가 (다시) 붙을 때 받는 기록 전부다 (FR-ARD-13).
func (pc *panedConn) recordsSnapshot(req *toolipc.PanedRequest) interface{} {
	res := toolipc.RecordsResult{Tools: []toolipc.ToolRecords{}}
	if pc.records != nil {
		res.Global = pc.records.snapshot()
	}
	for _, p := range pc.pm.Snapshot() {
		res.Tools = append(res.Tools, toolipc.ToolRecords{Tool: p.ID, Agent: p.AgentState(), Records: p.Records()})
	}
	return okResp(req, res)
}
