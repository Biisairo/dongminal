package ipc

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/handover"
	"dongminal/internal/shared/platform"
)

// DAEMON_SESSION_KEEP_SRS — 보고 소켓의 교체 메서드 (FR-DSK-10·11·17·19).

// controlSocket 은 짧은 임시 경로에 보고 소켓을 연다. 사용 중인 데몬의 소켓에는 닿지 않는다.
func controlSocket(t *testing.T, ps *PanedServer) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, agentrec.SocketFile)
	if err := ps.ListenReports(path); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { ps.ServeReports(); close(served) }()
	t.Cleanup(func() {
		ps.Close()
		<-served
	})
	return path
}

func ask(t *testing.T, path string, rq agentrec.Request, within time.Duration) agentrec.Reply {
	t.Helper()
	c, err := platform.Current().IPC.Dial(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(within))
	if err := json.NewEncoder(c).Encode(rq); err != nil {
		t.Fatal(err)
	}
	var r agentrec.Reply
	if err := json.NewDecoder(c).Decode(&r); err != nil {
		t.Fatalf("답을 읽지 못했다: %v", err)
	}
	return r
}

func reloadReq(t *testing.T) agentrec.Request {
	return reportReq(t, handover.MethodReload, handover.ReloadRequest{Exe: "/x/dongminal", Handover: handover.Version})
}

// FR-DSK-17: hello 는 교체를 아는 데몬의 표지다. 붙은 서버가 옛 판이어도 답한다.
func TestControl_HelloAnswersEvenWithOldServer(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	attachServer(ps, false)
	if r := ps.handleReport(agentrec.Request{Method: handover.MethodHello}); !r.OK {
		t.Fatalf("hello = %+v", r)
	}
}

// D-DSK-7: 교체기를 꽂지 않은 데몬(Windows)은 reload_unsupported 로 답한다.
func TestControl_ReloadWithoutReloaderIsUnsupported(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	r, commit := ps.handleControl(reloadReq(t))
	if commit != nil || r.OK || !strings.HasPrefix(r.Error, handover.ReasonUnsupported+": ") {
		t.Fatalf("reply = %+v", r)
	}
}

// FR-DSK-11: 교체기의 거절은 사유 코드 그대로 나간다. 교체는 일어나지 않는다.
func TestControl_ReloadRefusalPassesReason(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	ps.SetReloader(func(req handover.ReloadRequest) (func(), error) {
		if req.Exe != "/x/dongminal" || req.Handover != handover.Version {
			t.Errorf("본문 = %+v", req)
		}
		return nil, errors.New(handover.ReasonPreflight + ": 판이 다르다")
	})
	path := controlSocket(t, ps)
	r := ask(t, path, reloadReq(t), 2*time.Second)
	if r.OK || r.Error != handover.ReasonPreflight+": 판이 다르다" {
		t.Fatalf("reply = %+v", r)
	}
}

// FR-DSK-13 6→7: 성공 답이 먼저 나가고 그다음에 교체한다. 거꾸로면 exec 가 답을 지운다.
func TestControl_ReloadRepliesBeforeCommit(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	release := make(chan struct{})
	committed := make(chan struct{})
	ps.SetReloader(func(handover.ReloadRequest) (func(), error) {
		return func() {
			<-release // 답이 먼저 나가지 않으면 여기서 막혀 아래 ask 가 시한을 넘긴다
			close(committed)
		}, nil
	})
	path := controlSocket(t, ps)
	if r := ask(t, path, reloadReq(t), 2*time.Second); !r.OK {
		t.Fatalf("reply = %+v", r)
	}
	close(release)
	select {
	case <-committed:
	case <-time.After(2 * time.Second):
		t.Fatal("답한 뒤 교체를 실행하지 않았다")
	}
}

// FR-DSK-12: 보고 소켓의 2초 시한은 사전 확인(5초)보다 짧다. 교체 요청은 그보다 오래 기다린다.
func TestControl_ReloadOutlivesReportDeadline(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	ps.SetReloader(func(handover.ReloadRequest) (func(), error) {
		time.Sleep(agentrec.IOTimeout + 500*time.Millisecond)
		return nil, errors.New(handover.ReasonPreflight + ": 늦은 거절")
	})
	path := controlSocket(t, ps)
	r := ask(t, path, reloadReq(t), 10*time.Second)
	if r.Error != handover.ReasonPreflight+": 늦은 거절" {
		t.Fatalf("reply = %+v", r)
	}
}

// TC-DSK-12 (FR-DSK-19): 64 KiB 를 넘는 교체 요청은 교체기에 닿지 않는다.
func TestControl_ReloadRejectsOversizedBody(t *testing.T) {
	ps := NewPanedServer(recordsPM(t), "", "")
	called := false
	ps.SetReloader(func(handover.ReloadRequest) (func(), error) { called = true; return nil, nil })
	big := handover.ReloadRequest{Exe: "/" + strings.Repeat("a", handover.MaxRequestBytes), Handover: handover.Version}
	r, commit := ps.handleControl(reportReq(t, handover.MethodReload, big))
	if r.OK || called || commit != nil {
		t.Fatalf("reply=%+v called=%v", r, called)
	}
}
