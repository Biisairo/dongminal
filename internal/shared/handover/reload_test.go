package handover

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
)

// shortHome 은 소켓 경로 한도(104바이트) 안의 임시 홈이다. 사용 중인 홈에는 닿지 않는다.
func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if real, err := os.UserHomeDir(); err == nil && strings.HasPrefix(dir, filepath.Join(real, ".dongminal")) {
		t.Fatalf("임시 홈이 사용 중인 홈 아래다: %s", dir)
	}
	return dir
}

// fakeDaemon 은 home 의 보고 소켓에서 요청 하나를 받아 reply 로 답한다. 받은 요청을 돌려준다.
func fakeDaemon(t *testing.T, home string, reply agentrec.Reply) <-chan agentrec.Request {
	t.Helper()
	ln, err := platform.Current().IPC.Listen(agentrec.SocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan agentrec.Request, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var rq agentrec.Request
		if json.NewDecoder(c).Decode(&rq) != nil {
			return
		}
		got <- rq
		_ = json.NewEncoder(c).Encode(reply)
	}()
	return got
}

// TC-DSK-1·5 의 와이어: 요청은 reload 메서드와 exe·인계 판을 싣는다. ok 는 교체다.
func TestReload_SendsRequestAndReadsSwapped(t *testing.T) {
	home := shortHome(t)
	got := fakeDaemon(t, home, agentrec.Reply{OK: true})

	out := Reload(home, "/opt/dm/dongminal", time.Second)
	if out.Kind != Swapped {
		t.Fatalf("Kind = %v, want Swapped (%+v)", out.Kind, out)
	}
	rq := <-got
	if rq.Method != MethodReload {
		t.Fatalf("method = %q, want %q", rq.Method, MethodReload)
	}
	var body ReloadRequest
	if err := json.Unmarshal(rq.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Exe != "/opt/dm/dongminal" || body.Handover != Version {
		t.Fatalf("본문 = %+v", body)
	}
}

// FR-DSK-3: 옛 데몬은 모르는 메서드로 답한다. 실패가 아니라 미지원이다.
func TestReload_OldDaemonIsUnsupported(t *testing.T) {
	home := shortHome(t)
	fakeDaemon(t, home, agentrec.Reply{Error: OldDaemonUnknownMethod + ": " + MethodReload})

	if out := Reload(home, "/x", time.Second); out.Kind != Unsupported {
		t.Fatalf("Kind = %v, want Unsupported (%+v)", out.Kind, out)
	}
}

// FR-DSK-3: 보고 소켓이 없는 데몬(보고 소켓 이전 판)도 물을 수 없으므로 미지원이다.
func TestReload_NoReportSocketIsUnsupported(t *testing.T) {
	home := shortHome(t)
	if out := Reload(home, "/x", 200*time.Millisecond); out.Kind != Unsupported {
		t.Fatalf("Kind = %v, want Unsupported (%+v)", out.Kind, out)
	}
}

// FR-DSK-2·11: 데몬이 거절하면 사유 코드를 그대로 돌려준다.
func TestReload_RefusalCarriesReason(t *testing.T) {
	home := shortHome(t)
	fakeDaemon(t, home, agentrec.Reply{Error: ReasonPreflight + ": 판이 다르다"})

	out := Reload(home, "/x", time.Second)
	if out.Kind != Refused || out.Reason != ReasonPreflight {
		t.Fatalf("got %+v, want Refused/%s", out, ReasonPreflight)
	}
	if !strings.Contains(out.Detail, "판이 다르다") {
		t.Fatalf("설명이 빠졌다: %+v", out)
	}
}

// 답 없이 끊기면 교체 여부를 모른다 — 거절로 보고 아무것도 끄지 않게 한다.
func TestReload_NoReplyIsRefused(t *testing.T) {
	home := shortHome(t)
	ln, err := platform.Current().IPC.Listen(agentrec.SocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			c.Close()
		}
	}()
	if out := Reload(home, "/x", time.Second); out.Kind != Refused {
		t.Fatalf("Kind = %v, want Refused", out.Kind)
	}
}

// Classify 는 순수 함수다 — 위 경우들의 판정이 한 자리에서 나온다.
func TestClassify(t *testing.T) {
	cases := []struct {
		name  string
		reply agentrec.Reply
		err   error
		kind  Kind
	}{
		{"ok", agentrec.Reply{OK: true}, nil, Swapped},
		{"옛 데몬", agentrec.Reply{Error: OldDaemonUnknownMethod + ": daemon.reload"}, nil, Unsupported},
		{"거절", agentrec.Reply{Error: ReasonBusy + ": 진행 중"}, nil, Refused},
		{"빈 답", agentrec.Reply{}, nil, Refused},
		{"읽기 실패", agentrec.Reply{}, errors.New("EOF"), Refused},
	}
	for _, c := range cases {
		if got := Classify(c.reply, c.err); got.Kind != c.kind {
			t.Errorf("%s: Kind = %v, want %v", c.name, got.Kind, c.kind)
		}
	}
}

// FR-DSK-17: hello 에 ok 로 답하는 데몬만 교체를 아는 새 데몬이다.
func TestHello(t *testing.T) {
	home := shortHome(t)
	if Hello(home, 200*time.Millisecond) {
		t.Fatal("소켓이 없는데 hello 가 참이다")
	}
	got := fakeDaemon(t, home, agentrec.Reply{OK: true})
	if !Hello(home, time.Second) {
		t.Fatal("ok 로 답했는데 hello 가 거짓이다")
	}
	if rq := <-got; rq.Method != MethodHello {
		t.Fatalf("method = %q", rq.Method)
	}
}
