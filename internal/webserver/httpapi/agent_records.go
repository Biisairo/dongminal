package httpapi

import (
	"encoding/json"
	"maps"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/statusline"
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

// subagentRecord 는 서브에이전트 목록 기록의 모양이다. 시각은 밀리초다.
type subagentRecord struct {
	Tasks      []statusline.Subagent `json:"tasks"`
	ObservedAt int64                 `json:"observedAt"`
}

// limitRecord 는 에이전트 하나의 한도 기록이다. 시각은 밀리초다.
type limitRecord struct {
	Windows    map[string]statusline.RateWindow `json:"windows"`
	ObservedAt int64                            `json:"observedAt"`
}

func (st *rateLimitStore) records() map[string]limitRecord {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make(map[string]limitRecord, len(st.m))
	for agent, obs := range st.m {
		out[agent] = limitRecord{Windows: maps.Clone(obs.windows), ObservedAt: obs.observedAt.UnixMilli()}
	}
	return out
}

func (st *rateLimitStore) replace(recs map[string]limitRecord) {
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
				var r subagentRecord
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
	var limits map[string]limitRecord
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

// ApplyRecord 는 record push 하나를 반영한다 (FR-ARD-12). 값이 null 이면 지운다.
func (s *Server) ApplyRecord(ev toolipc.RecordEvent) {
	gone := len(ev.Value) == 0 || string(ev.Value) == "null"
	switch ev.Kind {
	case toolipc.RecordAgent:
		var st toolhub.AgentState
		if s.AttnTracker != nil && (gone || decodeRecord(ev.Kind, ev.Tool, ev.Value, &st)) {
			s.AttnTracker.Restore(ev.Tool, st)
		}
	case toolipc.RecordUsage:
		var u toolUsage
		s.usage.mu.Lock()
		delete(s.usage.m, ev.Tool)
		s.usage.mu.Unlock()
		if !gone && decodeRecord(ev.Kind, ev.Tool, ev.Value, &u) {
			s.usage.put(ev.Tool, u)
		}
	case toolipc.RecordSubagents:
		var r subagentRecord
		s.subagents.mu.Lock()
		delete(s.subagents.m, ev.Tool)
		s.subagents.mu.Unlock()
		if !gone && decodeRecord(ev.Kind, ev.Tool, ev.Value, &r) {
			s.subagents.put(ev.Tool, r.Tasks, time.UnixMilli(r.ObservedAt))
		}
	case toolipc.RecordSubagentActs:
		var m map[string]subagentActivity
		s.subActs.dropTool(ev.Tool)
		if !gone && decodeRecord(ev.Kind, ev.Tool, ev.Value, &m) && len(m) > 0 {
			s.subActs.mu.Lock()
			if s.subActs.m == nil {
				s.subActs.m = map[string]map[string]subagentActivity{}
			}
			s.subActs.m[ev.Tool] = m
			s.subActs.mu.Unlock()
		}
	case toolipc.RecordMigrationTold:
		if gone {
			s.migrationUnknownTold.Delete(ev.Tool)
		} else {
			s.migrationUnknownTold.Store(ev.Tool, true)
		}
	case toolipc.RecordLimits:
		var limits map[string]limitRecord
		if gone || decodeRecord(ev.Kind, "", ev.Value, &limits) {
			s.rateLimits.replace(limits)
		}
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
