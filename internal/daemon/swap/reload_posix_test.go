//go:build !windows

package swap

import (
	"dongminal/internal/shared/platform"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/handover"
	"dongminal/internal/shared/toolhub"

	"golang.org/x/sys/unix"
)

type rig struct {
	self string
	home string
	pm   *toolhub.ToolManager
	ps   *ipc.PanedServer
	tool *toolhub.Tool
}

// newRig 는 임시 홈에 소켓 둘과 cat 도구 하나를 세운다. 사용 중인 데몬에는 닿지 않는다.
func newRig(t *testing.T) *rig {
	t.Helper()
	home, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	pm := toolhub.NewToolManager(home, nil)
	ps := ipc.NewPanedServer(pm, platform.Current().IPC.Endpoint(home), "")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	if err := ps.ListenReports(filepath.Join(home, agentrec.SocketFile)); err != nil {
		t.Fatal(err)
	}
	p, err := pm.Create(home, 80, 24, toolhub.Placement{Command: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pm.Delete(p.ID); ps.Close() })
	return &rig{self: selfExe(t), home: home, pm: pm, ps: ps, tool: p}
}

func (r *rig) reloader(exec func(string, []string, []string) error) *Reloader {
	return New(Deps{
		Home: r.home, Tools: r.pm, Server: r.ps,
		Env:       Env{EUID: os.Geteuid(), GOOS: "darwin", SelfExe: r.self},
		Preflight: func(string) error { return nil },
		Exec:      exec,
	})
}

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func req(t *testing.T) handover.ReloadRequest {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return handover.ReloadRequest{Exe: exe, Handover: handover.Version}
}

func cloexec(t *testing.T, fd uintptr) bool {
	t.Helper()
	v, err := unix.FcntlInt(fd, unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	return v&unix.FD_CLOEXEC != 0
}

// TC-DSK-7 (FR-DSK-13·14): commit 은 넘길 fd 의 close-on-exec 를 지우고, 인계 상태 fd 를
// 인자로 실어 exec 한다. 그 fd 를 읽으면 도구가 담겨 있다.
func TestReload_CommitExecsWithState(t *testing.T) {
	r := newRig(t)
	var argv []string
	var masterFD uintptr
	var masterCloexec, stateCloexec bool
	execErr := errors.New("시험: exec 하지 않는다")
	rl := r.reloader(func(exe string, a, env []string) error {
		argv = a
		fd, err := strconv.Atoi(a[len(a)-1])
		if err != nil {
			t.Fatal(err)
		}
		stateCloexec = cloexec(t, uintptr(fd))
		dup, err := unix.Dup(fd)
		if err != nil {
			t.Fatal(err)
		}
		st, err := ReadState(os.NewFile(uintptr(dup), "state"))
		if err != nil || len(st.Tools) != 1 || st.Tools[0].ID != r.tool.ID {
			t.Fatalf("인계 상태 = %+v %v", st, err)
		}
		masterFD = st.Tools[0].FD
		masterCloexec = cloexec(t, masterFD)
		return execErr
	})
	commit, err := rl.Reload(req(t))
	if err != nil {
		t.Fatalf("Reload: %v", err)
	}
	commit()
	if len(argv) != 4 || argv[1] != "d" || argv[2] != handover.ArgFD {
		t.Fatalf("argv = %v", argv)
	}
	if masterCloexec || stateCloexec {
		t.Fatalf("exec 순간에 close-on-exec 였다: 도구=%v 상태=%v", masterCloexec, stateCloexec)
	}
	// exec 가 실패했으므로 모두 되돌린다.
	if !cloexec(t, masterFD) {
		t.Fatal("되돌린 뒤에도 도구 fd 의 close-on-exec 가 지워져 있다")
	}
	if err := r.tool.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, _ := r.tool.Stream().Snapshot()
		if strings.Contains(string(b), "after") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("되돌린 뒤 도구가 다시 읽지 않는다")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := rl.Reload(req(t)); err != nil {
		t.Fatalf("되돌린 뒤 다시 교체할 수 없다: %v", err)
	}
}

// FR-DSK-11: 진행 중이면 reload_busy, 검사 거절이면 아무것도 멈추지 않는다.
func TestReload_BusyAndRefusalLeaveToolsRunning(t *testing.T) {
	r := newRig(t)
	rl := r.reloader(func(string, []string, []string) error { return errors.New("x") })
	if _, err := rl.Reload(req(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := rl.Reload(req(t)); reasonOf(err) != handover.ReasonBusy {
		t.Fatalf("두 번째 요청 = %v, want busy", err)
	}

	r2 := newRig(t)
	rl2 := r2.reloader(nil)
	bad := req(t)
	bad.Handover++
	if _, err := rl2.Reload(bad); reasonOf(err) != handover.ReasonVersion {
		t.Fatalf("판 다름 = %v", err)
	}
	if _, err := r2.pm.Create(r2.home, 80, 24, toolhub.Placement{Command: "cat"}); err != nil {
		t.Fatalf("거절 뒤 도구 생성이 막혀 있다: %v", err)
	}
}

// FR-DSK-14·20: 인계 상태는 fd 로 읽힌다. 디스크에 이름이 없다 (D-DSK-12).
func TestState_WriteReadAnonymous(t *testing.T) {
	dir := t.TempDir()
	st := State{Version: handover.Version, Tools: []toolhub.HandoverTool{{ID: "t1", Screen: []byte("hi"), Offset: 9}}, PanedFD: 7, ReportFD: 8}
	f, err := WriteState(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("디스크에 이름이 남았다: %v", ents)
	}
	got, err := ReadState(f)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != st.Version || len(got.Tools) != 1 || string(got.Tools[0].Screen) != "hi" || got.PanedFD != 7 {
		t.Fatalf("got %+v", got)
	}
}
