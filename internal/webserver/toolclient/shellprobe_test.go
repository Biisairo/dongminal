package toolclient

import (
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// RUN_RECOVERY_SRS FR-RRC-10·NFR-RRC-3 — 셸 판정. 옛 데몬과 오류는 unknown 이다.

func shellProbeFake(t *testing.T, features []string, fail bool, state string) (*ToolClient, <-chan string) {
	t.Helper()
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "features": features}, func(req toolipc.PanedRequest) any {
		if fail {
			return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeServer, Message: "boom"}}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: toolipc.ShellProbeResult{State: state}}
	})
	pc := dialFake(t, sock)
	nextLine(t, lines) // hello
	return pc, lines
}

func TestShellProbeOneRPC(t *testing.T) {
	pc, lines := shellProbeFake(t, []string{toolipc.FeatureShellProbe}, false, "here")
	if got := pc.ShellProbe("a", []int{7, 8}); got != toolhub.ShellHere {
		t.Fatalf("got %s", got)
	}
	if l, want := nextLine(t, lines), `{"id":1,"method":"shellprobe","params":{"id":"a","pids":[7,8]}}`; l != want {
		t.Fatalf("요청\n got %s\nwant %s", l, want)
	}
}

func TestShellProbeLegacy(t *testing.T) {
	pc, lines := shellProbeFake(t, nil, false, "idle")
	if got := pc.ShellProbe("a", nil); got != toolhub.ShellUnknown {
		t.Fatalf("got %s", got)
	}
	noLine(t, lines)
}

func TestShellProbeBadIsUnk(t *testing.T) {
	pc, _ := shellProbeFake(t, []string{toolipc.FeatureShellProbe}, true, "")
	if got := pc.ShellProbe("a", nil); got != toolhub.ShellUnknown {
		t.Fatalf("오류: got %s", got)
	}
	pc, _ = shellProbeFake(t, []string{toolipc.FeatureShellProbe}, false, "뭔가")
	if got := pc.ShellProbe("a", nil); got != toolhub.ShellUnknown {
		t.Fatalf("모르는 값: got %s", got)
	}
}
