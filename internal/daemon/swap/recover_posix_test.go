//go:build !windows

package swap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
)

// orphanShell 은 이 시험 프로세스의 자식으로 PTY 셸(cat)을 띄우고, 원래 핸들은 닫은 채
// 복제한 마스터 fd 만 남긴다 — exec 뒤에 누구 것인지 모르는 fd 만 쥔 상태와 같다.
func orphanShell(t *testing.T) (fd uintptr, pid int) {
	t.Helper()
	term, err := platform.Current().PTY.Start(platform.ProcSpec{Path: "/bin/cat", Args: []string{"cat"}, Env: os.Environ()}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	dup, err := syscall.Dup(int(term.(platform.Handover).MasterFD()))
	if err != nil {
		t.Fatal(err)
	}
	pid = term.PID()
	_ = term.Close()
	t.Cleanup(func() { _ = platform.Current().Process.Kill(pid) })
	return uintptr(dup), pid
}

// TC-DSK-14 (FR-DSK-27): 인계 상태 없이 열린 PTY fd 와 자식 셸을 짝짓는다.
func TestFindOrphans_MatchesChildShells(t *testing.T) {
	fdA, pidA := orphanShell(t)
	fdB, pidB := orphanShell(t)
	// 이 시험은 fd 를 입양하지 않는다 — 닫지 않으면 같은 프로세스의 다음 시험이 이 셸을 찾는다.
	t.Cleanup(func() {
		_ = syscall.Close(int(fdA))
		_ = syscall.Close(int(fdB))
	})

	orphans, err := FindOrphans(nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[int]Orphan{}
	for _, o := range orphans {
		got[o.PID] = o
	}
	if o, ok := got[pidA]; !ok || o.FD != fdA {
		t.Fatalf("A = %+v (fd %d), 전체 %+v", o, fdA, orphans)
	}
	if o, ok := got[pidB]; !ok || o.FD != fdB {
		t.Fatalf("B = %+v (fd %d), 전체 %+v", o, fdB, orphans)
	}
	// 이미 쥔 fd 는 다시 찾지 않는다.
	again, err := FindOrphans(map[uintptr]bool{fdA: true, fdB: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range again {
		if o.PID == pidA || o.PID == pidB {
			t.Fatalf("이미 쥔 셸을 다시 찾았다: %+v", o)
		}
	}
}

// TC-DSK-14·15 (FR-DSK-27·28): tools.json 에 pid 가 적힌 셸은 같은 id·이름으로 되찾고,
// 적히지 않은 셸은 새 id 의 백그라운드 도구로 입양한다. 둘 다 살아 있고 입력이 닿는다.
func TestRecover_RecoversAndAdopts(t *testing.T) {
	home := t.TempDir()
	_, pidA := orphanShell(t)
	_, pidB := orphanShell(t)
	states := []toolhub.ToolState{{ID: "tool-a", Name: "alpha", Cwd: home, PID: pidA}}
	blob, _ := json.Marshal(states)
	if err := os.WriteFile(filepath.Join(home, dmenv.ToolsFile), blob, 0o600); err != nil {
		t.Fatal(err)
	}

	pm := toolhub.NewToolManager(home, nil)
	found, err := FindOrphans(nil)
	if err != nil {
		t.Fatal(err)
	}
	// FindOrphans 는 이 시험 프로세스 전체를 훑는다. 앞선 시험이 남긴 셸이 섞이지 않게
	// 이 시험이 띄운 둘만 넘긴다.
	var orphans []Orphan
	for _, o := range found {
		if o.PID == pidA || o.PID == pidB {
			orphans = append(orphans, o)
		}
	}
	refs := map[string]struct{}{"tool-a": {}}
	recovered, adopted := Recover(pm, home, refs, orphans)
	if recovered != 1 || adopted != 1 {
		t.Fatalf("recovered=%d adopted=%d", recovered, adopted)
	}
	a := pm.Get("tool-a")
	if a == nil || a.Name != "alpha" || a.CmdProcessPID() != pidA || pm.IsBackground("tool-a") {
		t.Fatalf("A = %+v background=%v", a, pm.IsBackground("tool-a"))
	}
	var b *toolhub.Tool
	for _, p := range pm.Snapshot() {
		if p.CmdProcessPID() == pidB {
			b = p
		}
	}
	if b == nil || b.ID == "" || !pm.IsBackground(b.ID) {
		t.Fatalf("B 를 백그라운드로 입양하지 않았다: %+v", b)
	}
	for _, p := range []*toolhub.Tool{a, b} {
		if err := p.Write([]byte("ping\n")); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, p := range []*toolhub.Tool{a, b} {
		for {
			s, _ := p.Stream().Snapshot()
			if strings.Contains(string(s), "ping") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("[%s] 되찾은 셸에 입력이 닿지 않는다", p.ID)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	for _, p := range pm.Snapshot() {
		pm.Delete(p.ID)
	}
}

// FR-DSK-26: 인계 상태를 잃은 새 데몬은 우리 소켓 경로에 묶인 물려받은 리스너를 닫는다.
// 닫지 않으면 일반 Listen 의 안전 검사가 그 소켓에 붙어 "다른 데몬이 있다" 로 보고 끝난다.
func TestCloseInheritedSockets(t *testing.T) {
	dir, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	ipcT := platform.Current().IPC
	ours := ipcT.Endpoint(dir)
	other := filepath.Join(dir, "other")
	lnOurs, err := ipcT.Listen(ours)
	if err != nil {
		t.Fatal(err)
	}
	defer lnOurs.Close()
	lnOther, err := ipcT.Listen(other)
	if err != nil {
		t.Fatal(err)
	}
	defer lnOther.Close()

	if n := CloseInheritedSockets(ours); n < 1 {
		t.Fatalf("닫은 fd %d개", n)
	}
	if c, err := ipcT.Dial(ours, time.Second); err == nil {
		c.Close()
		t.Fatal("우리 소켓이 아직 연결을 받는다")
	}
	c, err := ipcT.Dial(other, time.Second)
	if err != nil {
		t.Fatalf("다른 소켓까지 닫았다: %v", err)
	}
	c.Close()
}
