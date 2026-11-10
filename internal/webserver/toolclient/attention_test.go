package toolclient

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS §3.3a — 서버가 데몬의 판정을 부르고 그 결과를 attn push 로 받는다.

func attnDaemon(t *testing.T) (*toolhub.ToolManager, string) {
	t.Helper()
	d, err := os.MkdirTemp("", "atc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	pm := toolhub.NewToolManager(d, nil)
	ps := ipc.NewPanedServer(pm, d+"/s", "")
	pm.AdoptDetached("t1")
	t.Cleanup(func() { _ = pm.Delete("t1"); pm.StopSaving() })
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	go func() { _ = ps.Accept() }()
	return pm, d + "/s"
}

func waitAttn(t *testing.T, ch <-chan toolipc.AttnEvent) toolipc.AttnEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("attn push 가 오지 않았다")
	}
	return toolipc.AttnEvent{}
}

func TestAttention_ReportAttendAndPush(t *testing.T) {
	pm, sock := attnDaemon(t)
	c, err := DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if !c.HasFeature(toolipc.FeatureAttention) {
		t.Fatal("attention 기능을 보지 못했다")
	}
	got := make(chan toolipc.AttnEvent, 8)
	c.SetOnAttn(func(ev toolipc.AttnEvent) { got <- ev })

	if err := c.AttnConfig(1000, false); err != nil {
		t.Fatal(err)
	}
	if err := c.Report(agentrec.MethodNotify, agentrec.NotifyReport{ToolID: "t1"}); err != nil {
		t.Fatal(err)
	}
	if ev := waitAttn(t, got); ev.Tool != "t1" || ev.Kind != toolipc.AttnKindAttention || ev.Reason != "signaled" || !ev.Agent.Attention {
		t.Fatalf("알람 push=%+v", ev)
	}
	if err := c.Attend("t1", false); err != nil {
		t.Fatal(err)
	}
	if ev := waitAttn(t, got); ev.Kind != toolipc.AttnKindClear || !ev.Agent.RearmLocked {
		t.Fatalf("해제 push=%+v", ev)
	}
	pm.Get("t1").ObserveOutput([]byte("\x1b]9;hi\x07"))
	waitAttn(t, got)
	if n, err := c.AttendAll(); err != nil || n != 1 {
		t.Fatalf("attendall=%d err=%v", n, err)
	}

	var re *toolipc.RPCError
	err = c.Report(agentrec.MethodNotify, json.RawMessage(`{"toolId":"nope"}`))
	if !errors.As(err, &re) || re.Code != toolipc.CodeNotFound {
		t.Fatalf("없는 도구의 report=%v", err)
	}
}
