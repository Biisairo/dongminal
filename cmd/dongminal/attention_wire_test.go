package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/toolclient"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-30 — 실제 데몬·클라이언트·거울 추적기로 잰 알람 판정
// (FR-ARD-30~33, §3.3a). 판정은 데몬 Tool 이 하고, 서버는 그 결과를 방송한다.

// sseLog 는 방송된 SSE 를 모은다.
type sseLog struct {
	mu   sync.Mutex
	sent []string
}

func (b *sseLog) Add() *hub.CmdSub     { return hub.NewCmdSub() }
func (b *sseLog) Remove(s *hub.CmdSub) { s.Close() }
func (b *sseLog) Broadcast(p []byte) int {
	b.mu.Lock()
	b.sent = append(b.sent, string(p))
	b.mu.Unlock()
	return 1
}
func (b *sseLog) BroadcastAndAwait([]byte, string, time.Duration) (hub.CmdResult, int, bool) {
	return hub.CmdResult{}, 0, false
}
func (b *sseLog) DeliverResult(string, hub.CmdResult) {}

// await 는 subs 를 모두 담은 방송이 올 때까지 기다린다.
func (b *sseLog) await(t *testing.T, subs ...string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		for _, p := range b.sent {
			ok := true
			for _, s := range subs {
				ok = ok && strings.Contains(p, s)
			}
			if ok {
				b.sent = nil
				b.mu.Unlock()
				return
			}
		}
		b.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	t.Fatalf("%v 방송이 오지 않았다. 받은 것=%v", subs, b.sent)
}

type attnRig struct {
	pm   *toolhub.ToolManager
	tr   *hub.AttnTracker
	sse  *sseLog
	d    daemonAttention
	sock string
}

func newAttnRig(t *testing.T) *attnRig {
	t.Helper()
	t.Setenv(dmenv.EnvAttentionBell, "")
	// 데몬은 문턱 없이 뜬다 — 유휴 문턱은 서버가 붙을 때 attnconfig 로 준다.
	t.Setenv(dmenv.EnvAttentionIdleMS, "0")
	dir, err := os.MkdirTemp("", "atw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	pm := toolhub.NewToolManager(dir, nil)
	ps := ipc.NewPanedServer(pm, dir+"/s", "")
	pm.AdoptDetached("t1")
	t.Cleanup(func() { _ = pm.Delete("t1"); pm.StopSaving() })
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	sock := filepath.Join(dir, agentrec.SocketFile)
	if err := ps.ListenReports(sock); err != nil {
		t.Fatal(err)
	}
	go ps.ServeReports()
	go func() { _ = ps.Accept() }()

	c, err := toolclient.DialToolClient(dir + "/s")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	t.Setenv(dmenv.EnvAttentionIdleMS, "50")
	sse := &sseLog{}
	tr := hub.NewAttnTracker(sse, hub.DefaultIdleMS())
	d := wireDaemonAttention(c, tr)
	c.SetOnReport(func(toolipc.ReportEvent) {})
	return &attnRig{pm: pm, tr: tr, sse: sse, d: d, sock: sock}
}

func (r *attnRig) report(t *testing.T, method, body string) {
	t.Helper()
	c, err := platform.Current().IPC.Dial(r.sock, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_ = json.NewEncoder(c).Encode(agentrec.Request{Method: method, Body: json.RawMessage(body)})
	var rep agentrec.Reply
	if err := json.NewDecoder(c).Decode(&rep); err != nil || !rep.OK {
		t.Fatalf("reply=%+v err=%v", rep, err)
	}
}

func TestAttentionWire_DaemonJudgesServerBroadcasts(t *testing.T) {
	r := newAttnRig(t)
	if !r.d.Judges() {
		t.Fatal("새 데몬인데 판정을 넘기지 않았다")
	}
	p := r.pm.Get("t1")

	// 출력의 알림 시퀀스 — 데몬 Tool 이 판정한다.
	p.ObserveOutput([]byte("\x1b]9;hi\x07"))
	r.sse.await(t, `"action":"tool_attention"`, `"reason":"signaled"`)
	if !r.tr.Attention("t1") {
		t.Fatal("거울에 알람이 없다")
	}

	// 보기만 한 해제 — 데몬에 보내고 그 결과가 방송된다.
	if err := r.d.Attend("t1", false); err != nil {
		t.Fatal(err)
	}
	r.sse.await(t, `"tool_attention_clear"`)
	if p.Attention() || r.tr.Attention("t1") {
		t.Fatal("해제가 데몬·거울에 닿지 않았다")
	}

	// 보고 소켓의 사용자 턴 done — 직접 모드처럼 사유 done 으로 운다.
	r.report(t, agentrec.MethodActivity, `{"toolId":"t1","agent":"claude","state":"working","tool":"Bash","userPrompt":true}`)
	r.sse.await(t, `"tool_activity"`, `"state":"working"`)
	r.report(t, agentrec.MethodActivity, `{"toolId":"t1","agent":"claude","state":"done"}`)
	r.sse.await(t, `"action":"tool_attention"`, `"reason":"done"`)
	if a := r.tr.Activity("t1"); a == nil || a.State != activity.Done || !r.tr.Attention("t1") {
		t.Fatalf("거울=%+v attn=%v", a, r.tr.Attention("t1"))
	}
	if n, err := r.d.AttendAll(); err != nil || n != 1 {
		t.Fatalf("attendall=%d err=%v", n, err)
	}
	r.sse.await(t, `"tool_attention_clear"`)
}

// 유휴 판정은 데몬의 스위퍼가 한다. 문턱은 서버가 붙을 때 attnconfig 로 보낸 값이다.
func TestAttentionWire_DaemonIdle(t *testing.T) {
	defer toolhub.SetAttnBusyProbe(func(*toolhub.Tool) bool { return true })()
	r := newAttnRig(t)
	p := r.pm.Get("t1")
	p.ReportActivity(activity.Working, "Bash", "", true, true)
	p.SetActivity(activity.Idle, "", "")
	p.ObserveOutput([]byte("x"))

	stop := make(chan struct{})
	defer close(stop)
	tick := make(chan time.Time)
	r.pm.RunAttentionSweeper(stop, tick)
	time.Sleep(100 * time.Millisecond)
	tick <- time.Now()
	r.sse.await(t, `"action":"tool_attention"`, `"reason":"idle"`)
}

// 서버의 추적기는 판정하지 않는다 — 출력의 알림 시퀀스를 서버가 따로 보아도 울지 않는다.
func TestAttentionWire_ServerDoesNotJudge(t *testing.T) {
	r := newAttnRig(t)
	r.tr.FeedOutput("t1", []byte("\x1b]9;hi\x07"))
	if r.tr.Attention("t1") {
		t.Fatal("거울이 출력으로 판정했다")
	}
}
