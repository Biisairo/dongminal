package cli

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

// fakeProc은 종료 요청의 결과를 시험자가 정하는 프로세스 제어다. 실기로는
// SIGKILL 을 견디는 프로세스를 만들 수 없어 "정지 실패" 경로를 확인할 길이
// 없다.
type fakeProc struct {
	alive     bool
	dieOnTerm bool
	dieOnKill bool
	terms     int
	kills     int
}

func (f *fakeProc) Alive(int) bool { return f.alive }
func (f *fakeProc) Terminate(int) error {
	f.terms++
	if f.dieOnTerm {
		f.alive = false
	}
	return nil
}
func (f *fakeProc) Kill(int) error {
	f.kills++
	if f.dieOnKill {
		f.alive = false
	}
	return nil
}
func (f *fakeProc) Detach(*exec.Cmd)             {}
func (f *fakeProc) ShutdownSignals() []os.Signal { return nil }
func (f *fakeProc) NewGroup(*exec.Cmd) platform.Group {
	panic("stopDaemon 은 프로세스 묶음을 쓰지 않는다")
}

// withProc은 procCtl 을 f 로 갈아끼우고 테스트가 끝나면 되돌린다.
func withProc(t *testing.T, f platform.Process) {
	t.Helper()
	prev := procCtl
	procCtl = func() platform.Process { return f }
	t.Cleanup(func() { procCtl = prev })
}

// stopHome은 pid 가 적힌 pidfile 과 종단 파일을 갖춘 홈이다.
func stopHome(t *testing.T, pid string) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, daemonPIDFile), []byte(pid), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, daemonSockFile), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

// 종료 시도가 먹히지 않으면 false 다. true 를 내면 stop.go 의 실패 분기가
// 죽은 코드가 되어 `stop --all` 이 실패를 ✅ 로 보고한다.
func TestStopDaemon_StillAliveReportsFailure(t *testing.T) {
	f := &fakeProc{alive: true}
	withProc(t, f)
	home := stopHome(t, "4242")

	var out bytes.Buffer
	if stopDaemon(home, &out) {
		t.Error("종료되지 않은 데몬에 대해 true 를 반환")
	}
	if f.terms == 0 || f.kills == 0 {
		t.Errorf("Terminate/Kill 시도 = %d/%d", f.terms, f.kills)
	}
	// 살아 있는 데몬의 pidfile 을 지우면 다음 stop 이 데몬을 찾지 못한다.
	if _, err := os.Stat(filepath.Join(home, daemonPIDFile)); err != nil {
		t.Error("정지 실패인데 pidfile 이 제거됨")
	}
	if _, err := os.Stat(filepath.Join(home, daemonSockFile)); err != nil {
		t.Error("정지 실패인데 종단 파일이 제거됨")
	}
}

// Terminate 로 죽으면 Kill 까지 가지 않고, 잔여물은 치운다.
func TestStopDaemon_TerminateSucceeds(t *testing.T) {
	f := &fakeProc{alive: true, dieOnTerm: true}
	withProc(t, f)
	home := stopHome(t, "4242")

	var out bytes.Buffer
	if !stopDaemon(home, &out) {
		t.Fatal("정지에 성공했는데 false")
	}
	if f.kills != 0 {
		t.Errorf("Terminate 로 끝났는데 Kill 을 보냄 (%d회)", f.kills)
	}
	if _, err := os.Stat(filepath.Join(home, daemonPIDFile)); err == nil {
		t.Error("pidfile 이 남음")
	}
	if _, err := os.Stat(filepath.Join(home, daemonSockFile)); err == nil {
		t.Error("종단 파일이 남음")
	}
}

// Terminate 를 무시해도 Kill 로 끝나면 성공이다.
func TestStopDaemon_KillSucceeds(t *testing.T) {
	f := &fakeProc{alive: true, dieOnKill: true}
	withProc(t, f)
	home := stopHome(t, "4242")

	var out bytes.Buffer
	if !stopDaemon(home, &out) {
		t.Fatal("Kill 로 끝났는데 false")
	}
	if f.kills != 1 {
		t.Errorf("Kill 시도 = %d회, want 1", f.kills)
	}
}

// 낡은 pidfile 만 남은 홈은 잔여물 정리 후 성공이다.
func TestStopDaemon_StalePidfileIsSuccess(t *testing.T) {
	withProc(t, &fakeProc{alive: false})
	home := stopHome(t, "4242")

	var out bytes.Buffer
	if !stopDaemon(home, &out) {
		t.Fatal("낡은 pidfile 정리가 false")
	}
	if _, err := os.Stat(filepath.Join(home, daemonPIDFile)); err == nil {
		t.Error("낡은 pidfile 이 남음")
	}
}
