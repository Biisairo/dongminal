//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/handover"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/toolclient"
)

// DAEMON_SESSION_KEEP_SRS TC-DSK-9: 검사 바이너리로 띄운 데몬을 실제로 교체한다. 데몬 pid 와
// 셸 pid 가 그대로이고, 교체 뒤의 입력이 같은 셸에 닿는다.
//
// 임시 홈에서만 돈다. 사용 중인 데몬·서버의 소켓·포트에는 닿지 않는다.
func TestSessionKeep_RealReload(t *testing.T) {
	if testing.Short() {
		t.Skip("바이너리를 빌드한다")
	}
	home, err := os.MkdirTemp("", "dsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	if real, err := os.UserHomeDir(); err == nil && strings.HasPrefix(home, filepath.Join(real, ".dongminal")) {
		t.Fatalf("임시 홈이 사용 중인 홈 아래다: %s", home)
	}
	bin := filepath.Join(home, "dongminal")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	daemon := exec.Command(bin, "d")
	daemon.Env = isolatedEnv(home)
	logf, err := os.Create(filepath.Join(home, "daemon.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logf.Close()
	daemon.Stdout, daemon.Stderr = logf, logf
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	var shellPID int
	t.Cleanup(func() {
		if shellPID > 0 {
			_ = platform.Current().Process.Kill(shellPID)
		}
		_ = platform.Current().Process.Terminate(daemon.Process.Pid)
		done := make(chan struct{})
		go func() { _ = daemon.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = daemon.Process.Kill()
		}
		if t.Failed() || testing.Verbose() {
			log, _ := os.ReadFile(filepath.Join(home, "daemon.log"))
			t.Logf("daemon.log:\n%s", log)
		}
	})
	eventually(t, "데몬 기동", func() bool { return handover.Hello(home, 200*time.Millisecond) })

	sock := platform.Current().IPC.Endpoint(home)
	pc, err := toolclient.DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	tool, err := pc.Create(home, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatal(err)
	}
	p1 := filepath.Join(home, "p1")
	if err := pc.Write(tool.ID, []byte("echo $$ > "+p1+"\n")); err != nil {
		t.Fatal(err)
	}
	shellPID = readPID(t, p1)
	pc.Close()

	out := handover.Reload(home, bin, 15*time.Second)
	if out.Kind != handover.Swapped {
		t.Fatalf("Reload = %+v", out)
	}
	// 데몬은 교체 답을 쓴 **뒤에** 새 판으로 exec 한다(pid 는 같다). 그래서 hello·pid 만으로는 아직 옛 판이
	// 답하는 것과 가리지 못하고, 그 틈에 붙은 연결은 exec 에 끊긴다. 새 판이 남기는 기동 줄을 함께 기다린다.
	eventually(t, "교체 뒤 hello", func() bool {
		log, _ := os.ReadFile(filepath.Join(home, "daemon.log"))
		return strings.Contains(string(log), "handover=true") &&
			handover.Hello(home, 200*time.Millisecond) && pidFile(home) == daemon.Process.Pid
	})

	pc2, err := toolclient.DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer pc2.Close()
	var found bool
	for _, info := range pc2.List() {
		if info.ID == tool.ID {
			found = true
			if info.PID != shellPID {
				t.Fatalf("셸 pid 가 바뀌었다: %d → %d", shellPID, info.PID)
			}
		}
	}
	if !found {
		t.Fatalf("교체 뒤 도구 %s 가 없다", tool.ID)
	}
	p2 := filepath.Join(home, "p2")
	if err := pc2.Write(tool.ID, []byte("echo $$ > "+p2+"\n")); err != nil {
		t.Fatal(err)
	}
	if got := readPID(t, p2); got != shellPID {
		t.Fatalf("교체 뒤 입력이 다른 셸에 닿았다: %d, want %d", got, shellPID)
	}
}

// isolatedEnv 는 사용자 인스턴스를 가리키는 값을 모두 지우고 임시 홈만 심는다.
func isolatedEnv(home string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "DONGMINAL_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, dmenv.EnvHome+"="+home, dmenv.EnvToolHome+"="+filepath.Join(home, "tool-home"))
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s 을(를) 기다리다 시한을 넘겼다", what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	var pid int
	eventually(t, path, func() bool {
		b, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && pid > 0
	})
	return pid
}

func pidFile(home string) int {
	b, err := os.ReadFile(filepath.Join(home, dmenv.PanedPIDFile))
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid
}
