package main

import (
	"encoding/json"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/recordsync"
)

// AGENT_RECORD_DAEMON_SRS 단계 1 — 에이전트 기록의 조립 (FR-ARD-11~14, §3.1a).

type recordClient interface {
	HasFeature(name string) bool
	RecordSet(kind, tool string, v json.RawMessage) error
	Records() (toolipc.RecordsResult, error)
}

type recordMirror interface {
	ApplyRecords(res toolipc.RecordsResult)
}

// recordSender 는 보낼 때마다 데몬의 기능을 본다 — 다시 붙은 데몬이 옛 판일 수 있다
// (FR-ARD-14). 말하지 않으면 보내지 않고 거울만 남는다.
func recordSender(c recordClient) recordsync.Sender {
	return func(kind, tool string, v json.RawMessage) error {
		if !c.HasFeature(toolipc.FeatureRecords) {
			return nil
		}
		return c.RecordSet(kind, tool, v)
	}
}

// syncRecords 는 (다시) 붙었을 때의 재동기다 (FR-ARD-13). 끊긴 동안 거울에만 반영된
// 쓰기를 먼저 보내야 낡은 스냅샷이 그것을 덮지 않는다.
func syncRecords(c recordClient, w *recordsync.Writer, m recordMirror) {
	if !c.HasFeature(toolipc.FeatureRecords) {
		return
	}
	w.Flush()
	res, err := c.Records()
	if err != nil {
		dmlog.Warnf(nil, "records: 데몬의 스냅샷을 받지 못했다 — 거울을 그대로 둔다: %v", err)
		return
	}
	m.ApplyRecords(res)
}

// newRecordWriter 는 추적기의 판정 결과를 데몬에 쓰는 큐를 만든다.
func newRecordWriter(c recordClient, t *hub.AttnTracker) *recordsync.Writer {
	w := recordsync.New(recordSender(c))
	t.SetOnChange(func(id string, st toolhub.AgentState) { w.Put(toolipc.RecordAgent, id, st) })
	return w
}

// reportQueueSize 는 처리를 기다리는 report push 의 상한이다.
const reportQueueSize = 1024

// newReportQueue 는 report push 를 받은 순서대로 고루틴 하나가 apply 로 처리하게 한다
// (AGENT_RECORD_DAEMON_SRS §3.2a). push 는 읽기 루프에서 오는데, 처리 중에 데몬 RPC 를
// 기다리면(맥락 경고 전달의 입력 등) 응답을 읽을 루프가 자기 자신이라 교착이다. 줄이 차면
// 버리고 로그를 남긴다 — 버린 보고도 데몬 기록에는 남는다.
func newReportQueue(apply func(method string, body json.RawMessage)) func(toolipc.ReportEvent) {
	q := make(chan toolipc.ReportEvent, reportQueueSize)
	go func() {
		for ev := range q {
			apply(ev.Method, ev.Body)
		}
	}()
	return func(ev toolipc.ReportEvent) {
		select {
		case q <- ev:
		default:
			dmlog.Warnf(nil, "report: 처리 줄이 차서 %s 보고를 버렸다", ev.Method)
		}
	}
}
