package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/toolclient"
)

// AGENT_RECORD_DAEMON_SRS §3.2a — report push 는 읽기 루프 밖에서, 받은 순서대로 처리한다.
func TestReportQueue_InOrderOffLoop(t *testing.T) {
	got := make(chan string, 4)
	release := make(chan struct{})
	push := newReportQueue(func(method string, _ json.RawMessage) {
		<-release
		got <- method
	})
	returned := make(chan struct{})
	go func() {
		push(toolipc.ReportEvent{Method: "a"})
		push(toolipc.ReportEvent{Method: "b"})
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("처리가 끝날 때까지 push 가 읽기 루프를 막았다")
	}
	close(release)
	for _, want := range []string{"a", "b"} {
		select {
		case m := <-got:
			if m != want {
				t.Fatalf("순서: %s, want %s", m, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("처리되지 않았다")
		}
	}
}

// TC-ARD-22: 서버 없이 보고 소켓에 온 보고가, 나중에 붙은 서버의 스냅샷에 실린다 (FR-ARD-25).
func TestReport_NoServerThenSnapshot(t *testing.T) {
	d, err := os.MkdirTemp("", "ars")
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
	if err := ps.ListenReports(filepath.Join(d, agentrec.SocketFile)); err != nil {
		t.Fatal(err)
	}
	go ps.ServeReports()
	go func() { _ = ps.Accept() }()

	for _, body := range []string{
		`{"toolId":"t1","agent":"claude","state":"working","tool":"Bash"}`,
		`{"toolId":"t1","agent":"claude","state":"done"}`,
	} {
		c, err := platform.Current().IPC.Dial(filepath.Join(d, agentrec.SocketFile), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		_ = json.NewEncoder(c).Encode(agentrec.Request{Method: agentrec.MethodActivity, Body: json.RawMessage(body)})
		var r agentrec.Reply
		if err := json.NewDecoder(c).Decode(&r); err != nil || !r.OK {
			t.Fatalf("reply=%+v err=%v", r, err)
		}
		c.Close()
	}

	c, err := toolclient.DialToolClient(d + "/s")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fb := &countingBroker{}
	tr := hub.NewAttnTracker(fb, 0)
	syncRecords(c, newRecordWriter(c, tr), trackerMirror{tr})
	st := tr.AgentStateOf("t1")
	if st.Activity == nil || st.Activity.State != activity.Done || !st.Attention {
		t.Fatalf("새 서버의 거울=%+v — 서버가 꺼진 동안 끝난 턴이 done·알람으로 보여야 한다", st)
	}
	if fb.attention != 0 {
		t.Fatalf("스냅샷 반영이 알람을 %d 번 방송했다 (FR-ARD-25)", fb.attention)
	}
}
