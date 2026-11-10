package httpapi

import (
	"encoding/json"
	"maps"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 1 — 서버의 저장소는 데몬 기록의 거울이다 (D-ARD-1,
// FR-ARD-11·13, §3.1a). 쓰기는 거울과 데몬에 함께 가고, 스냅샷은 거울을 통째로 바꾼다.

// RecordSink 는 기록을 데몬에 쓰는 큐다 (recordsync.Writer). v 가 nil 이면 지운다.
type RecordSink interface {
	Put(kind, tool string, v any)
}

func (s *Server) putRecord(kind, tool string, v any) {
	if s.Records != nil {
		s.Records.Put(kind, tool, v)
	}
}

func (st *rateLimitStore) records() map[string]agentrec.LimitRecord {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make(map[string]agentrec.LimitRecord, len(st.m))
	for agent, obs := range st.m {
		out[agent] = agentrec.LimitRecord{Windows: maps.Clone(obs.windows), ObservedAt: obs.observedAt.UnixMilli()}
	}
	return out
}

func (st *rateLimitStore) replace(recs map[string]agentrec.LimitRecord) {
	m := make(map[string]limitObs, len(recs))
	for agent, r := range recs {
		m[agent] = limitObs{windows: r.Windows, observedAt: time.UnixMilli(r.ObservedAt)}
	}
	st.mu.Lock()
	st.m = m
	st.mu.Unlock()
}

func (st *subagentActivityStore) byTool(toolID string) map[string]subagentActivity {
	st.mu.Lock()
	defer st.mu.Unlock()
	return maps.Clone(st.m[toolID])
}

// ApplyRecords 는 스냅샷으로 거울을 통째로 바꾼다 (FR-ARD-13). 알람은 울리지 않는다.
func (s *Server) ApplyRecords(res toolipc.RecordsResult) {
	agents := make(map[string]toolhub.AgentState, len(res.Tools))
	usage := map[string]toolUsage{}
	subs := map[string]subagentList{}
	acts := map[string]map[string]subagentActivity{}
	told := map[string]bool{}
	for _, tr := range res.Tools {
		agents[tr.Tool] = tr.Agent
		for kind, raw := range tr.Records {
			switch kind {
			case toolipc.RecordUsage:
				var u toolUsage
				if decodeRecord(kind, tr.Tool, raw, &u) {
					usage[tr.Tool] = u
				}
			case toolipc.RecordSubagents:
				var r agentrec.SubagentList
				if decodeRecord(kind, tr.Tool, raw, &r) {
					subs[tr.Tool] = subagentList{tasks: r.Tasks, observedAt: time.UnixMilli(r.ObservedAt)}
				}
			case toolipc.RecordSubagentActs:
				var m map[string]subagentActivity
				if decodeRecord(kind, tr.Tool, raw, &m) && len(m) > 0 {
					acts[tr.Tool] = m
				}
			case toolipc.RecordMigrationTold:
				told[tr.Tool] = true
			}
		}
	}
	var limits map[string]agentrec.LimitRecord
	if raw, ok := res.Global[toolipc.RecordLimits]; ok {
		decodeRecord(toolipc.RecordLimits, "", raw, &limits)
	}

	s.usage.mu.Lock()
	s.usage.m = usage
	s.usage.mu.Unlock()
	s.subagents.mu.Lock()
	s.subagents.m = subs
	s.subagents.mu.Unlock()
	s.subActs.mu.Lock()
	s.subActs.m = acts
	s.subActs.mu.Unlock()
	s.migrationUnknownTold.Clear()
	for id := range told {
		s.migrationUnknownTold.Store(id, true)
	}
	s.rateLimits.replace(limits)
	if s.AttnTracker != nil {
		s.AttnTracker.RestoreAll(agents)
	}
	s.activityChanged.Notify()
}

func decodeRecord(kind, tool string, raw json.RawMessage, v any) bool {
	if err := json.Unmarshal(raw, v); err != nil {
		dmlog.Warnf(nil, "records: %s/%s 를 읽지 못했다: %v", kind, tool, err)
		return false
	}
	return true
}
