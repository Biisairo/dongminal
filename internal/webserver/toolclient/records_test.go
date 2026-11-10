package toolclient

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-11(클라이언트 몫) — 쓴 기록이 연결을 넘어 남고,
// 새 연결이 스냅샷으로 받는다. record push 가 콜백에 닿는다.

func recordsDaemon(t *testing.T) (*ipc.PanedServer, string) {
	t.Helper()
	d := t.TempDir()
	dataDir := d + "/d"
	_ = os.MkdirAll(dataDir, 0o755)
	pm := toolhub.NewToolManager(dataDir, nil)
	pm.Adopt(toolhub.NewDetachedTool("t1", nil))
	t.Cleanup(func() { _ = pm.Delete("t1"); pm.StopSaving() })
	ps := ipc.NewPanedServer(pm, d+"/s", "")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	// Accept 는 연결이 끝나면 그 오류를 돌려준다. 시험이 쓰는 연결 수만큼 받는다.
	go func() {
		for range 4 {
			_ = ps.Accept()
		}
	}()
	return ps, d + "/s"
}

func TestRecords_SurviveReconnect(t *testing.T) {
	_, sock := recordsDaemon(t)
	c1, err := DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	if !c1.HasFeature(toolipc.FeatureRecords) {
		t.Fatal("records 기능을 보지 못했다")
	}
	agent, _ := json.Marshal(toolhub.AgentState{AgentSeen: true, Activity: &toolhub.ActivityState{State: activity.Waiting}})
	if err := c1.RecordSet(toolipc.RecordAgent, "t1", agent); err != nil {
		t.Fatal(err)
	}
	if err := c1.RecordSet(toolipc.RecordLimits, "", json.RawMessage(`{"claude":1}`)); err != nil {
		t.Fatal(err)
	}
	var rpcErr *toolipc.RPCError
	if err := c1.RecordSet(toolipc.RecordUsage, "gone", json.RawMessage(`{}`)); err == nil || !errors.As(err, &rpcErr) || rpcErr.Code != toolipc.CodeNotFound {
		t.Fatalf("없는 도구 err=%v", err)
	}
	c1.Close()

	c2, err := DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	res, err := c2.Records()
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Global[toolipc.RecordLimits]) != `{"claude":1}` || len(res.Tools) != 1 {
		t.Fatalf("records=%+v", res)
	}
	a := res.Tools[0].Agent
	if res.Tools[0].Tool != "t1" || !a.AgentSeen || a.Activity == nil || a.Activity.State != activity.Waiting {
		t.Fatalf("t1=%+v", res.Tools[0])
	}
}

// 다시 붙으면 재동기 콜백이 돈다 — 서버는 거기서 남은 쓰기를 보내고 스냅샷을 받는다.
func TestRecords_ResyncCallbackOnReconnect(t *testing.T) {
	drop := make(chan struct{})
	sock := fakeReconnectPaned(t, [][]string{{"t1"}, {"t1"}}, drop)
	c, err := DialToolClientWithReconnect(sock, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	called := make(chan struct{}, 1)
	c.SetOnResync(func() { called <- struct{}{} })
	close(drop)
	select {
	case <-called:
	case <-time.After(8 * time.Second):
		t.Fatal("재접속 뒤 재동기 콜백이 돌지 않았다")
	}
}
