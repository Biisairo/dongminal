package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/recordsync"
	"dongminal/internal/webserver/toolclient"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-13·14 — 조립의 기록 배선.

type fakeRecordClient struct {
	features bool
	log      []string
}

func (f *fakeRecordClient) HasFeature(name string) bool {
	return f.features && name == toolipc.FeatureRecords
}

func (f *fakeRecordClient) RecordSet(kind, tool string, _ json.RawMessage) error {
	f.log = append(f.log, "set "+kind+"/"+tool)
	return nil
}

func (f *fakeRecordClient) Records() (toolipc.RecordsResult, error) {
	f.log = append(f.log, "records")
	return toolipc.RecordsResult{Tools: []toolipc.ToolRecords{{Tool: "t1"}}}, nil
}

type fakeMirror struct{ applied []toolipc.RecordsResult }

func (m *fakeMirror) ApplyRecords(res toolipc.RecordsResult) { m.applied = append(m.applied, res) }

// 다시 붙으면 남은 쓰기를 먼저 보내고, 그 뒤에 스냅샷을 받는다.
func TestSyncRecords_FlushThenSnapshot(t *testing.T) {
	c := &fakeRecordClient{features: true}
	w := recordsync.New(recordSender(c))
	w.Put(toolipc.RecordUsage, "t1", 1)
	m := &fakeMirror{}
	syncRecords(c, w, m)
	if len(c.log) != 2 || c.log[0] != "set usage/t1" || c.log[1] != "records" {
		t.Fatalf("순서=%v", c.log)
	}
	if len(m.applied) != 1 || m.applied[0].Tools[0].Tool != "t1" {
		t.Fatalf("applied=%+v", m.applied)
	}
}

// TC-ARD-12: records 를 말하지 않는 데몬에는 쓰지도 묻지도 않는다.
func TestSyncRecords_OldDaemon(t *testing.T) {
	c := &fakeRecordClient{}
	w := recordsync.New(recordSender(c))
	w.Put(toolipc.RecordUsage, "t1", 1)
	m := &fakeMirror{}
	syncRecords(c, w, m)
	if len(c.log) != 0 || len(m.applied) != 0 {
		t.Fatalf("옛 데몬에 보냈다: log=%v applied=%d", c.log, len(m.applied))
	}
}

// TC-ARD-11: 서버가 쓴 기록이 서버를 넘어 남는다 — 실제 데몬·클라이언트·추적기로 잰다.
// 새 서버는 붙을 때 스냅샷으로 같은 상태를 얻고, 그 반영은 알람을 방송하지 않는다.
func TestRecords_NewServerSeesOldServerState(t *testing.T) {
	// 유닉스 소켓 경로는 104 바이트까지다 — t.TempDir() 은 이 시험 이름으로 그보다 길다.
	d, err := os.MkdirTemp("", "ard")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	pm := toolhub.NewToolManager(d, nil)
	pm.Adopt(toolhub.NewDetachedTool("t1", nil))
	t.Cleanup(func() { _ = pm.Delete("t1"); pm.StopSaving() })
	ps := ipc.NewPanedServer(pm, d+"/s", "")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	go func() {
		for range 2 {
			_ = ps.Accept()
		}
	}()

	c1, err := toolclient.DialToolClient(d + "/s")
	if err != nil {
		t.Fatal(err)
	}
	tr1 := hub.NewAttnTracker(&countingBroker{}, 0)
	w1 := newRecordWriter(c1, tr1)
	tr1.SetActivity("t1", activity.Working, "Bash", "ls")
	tr1.SignalAttention("t1", activity.Waiting)
	w1.Flush()
	c1.Close()

	c2, err := toolclient.DialToolClient(d + "/s")
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	fb := &countingBroker{}
	tr2 := hub.NewAttnTracker(fb, 0)
	w2 := newRecordWriter(c2, tr2)
	syncRecords(c2, w2, trackerMirror{tr2})

	got, want := tr2.AgentStateOf("t1"), tr1.AgentStateOf("t1")
	got.LastOutputAt, want.LastOutputAt = 0, 0
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		t.Fatalf("새 서버의 거울\n got=%s\nwant=%s", gb, wb)
	}
	if fb.attention != 0 {
		t.Fatalf("스냅샷 반영이 알람을 %d 번 방송했다", fb.attention)
	}
}

type trackerMirror struct{ t *hub.AttnTracker }

func (m trackerMirror) ApplyRecords(res toolipc.RecordsResult) {
	states := map[string]toolhub.AgentState{}
	for _, tr := range res.Tools {
		states[tr.Tool] = tr.Agent
	}
	m.t.RestoreAll(states)
}

type countingBroker struct{ attention int }

func (b *countingBroker) Add() *hub.CmdSub     { return hub.NewCmdSub() }
func (b *countingBroker) Remove(s *hub.CmdSub) { s.Close() }
func (b *countingBroker) Broadcast(p []byte) int {
	if strings.Contains(string(p), `"action":"tool_attention"`) {
		b.attention++
	}
	return 1
}
func (b *countingBroker) BroadcastAndAwait(p []byte, _ string, _ time.Duration) (hub.CmdResult, int, bool) {
	return hub.CmdResult{}, 0, false
}
func (b *countingBroker) DeliverResult(string, hub.CmdResult) {}
