package ipc

import (
	"encoding/json"
	"os"
	"runtime"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// RUN_RECOVERY_SRS FR-RRC-10 — 셸 판정 IPC.

func TestShellProbeFeature(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureShellProbe) {
		t.Fatalf("DaemonFeatures=%v — shellprobe 가 없다", toolipc.DaemonFeatures)
	}
}

// 없는 도구는 판정하지 못한다.
func TestShellProbeWire_UnknownTool(t *testing.T) {
	got := wireOf(t, func(pc *panedConn) {
		pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodShellProbe, Params: json.RawMessage(`{"id":"없음","pids":[1]}`)})
	})
	if want := `{"id":1,"result":{"state":"unknown"}}` + "\n"; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

// TC-RRC-3 (실제 셸): 빈 셸은 idle, 자식이 돌면 busy, 그 자식을 세션 pid 로 주면 here,
// 셸 밖의 살아 있는 pid 는 elsewhere 다. 임시 폴더의 도구 관리자만 쓴다.
func TestShellProbeRealShell(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	tl, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete(tl.ID)
	waitState := func(want toolhub.ShellState, pids []int) {
		t.Helper()
		got := toolhub.ShellUnknown
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if got = pm.ShellProbe(tl.ID, pids); got == want {
				return
			}
		}
		t.Fatalf("셸 판정 = %s, want %s", got, want)
	}
	waitState(toolhub.ShellIdle, nil)
	// pwsh 의 sleep 은 셸 안에서 도는 명령이라 자식이 생기지 않는다 — 외부 프로그램을 띄운다.
	busy := "sleep 30\r"
	if runtime.GOOS == "windows" {
		busy = "ping -n 30 127.0.0.1\r"
	}
	if err := pm.Write(tl.ID, []byte(busy)); err != nil {
		t.Fatal(err)
	}
	waitState(toolhub.ShellBusy, nil)

	parents, ok := platform.Current().Info.Parents()
	if !ok {
		t.Fatal("프로세스 표를 읽지 못했다")
	}
	shell := tl.CmdProcessPID()
	child := 0
	for pid, ppid := range parents {
		if ppid == shell {
			child = pid
		}
	}
	if child == 0 {
		t.Fatal("셸의 자식을 찾지 못했다")
	}
	waitState(toolhub.ShellHere, []int{child})
	waitState(toolhub.ShellElsewhere, []int{os.Getpid()})
	// 표에 없는 pid(끝난 세션)는 세션이 꺼진 것으로 보고 셸만 본다.
	waitState(toolhub.ShellBusy, []int{1 << 30})
}
