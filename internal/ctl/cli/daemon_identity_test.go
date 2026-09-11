package cli

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

// `FBE-07` (PRODUCTION_ROADMAP §M3) — **pidfile 을 PID 재사용 검증 없이 믿지
// 않는다.**
//
// `daemonPID` 는 `Alive(pid)` 만 본다. 데몬이 죽고 OS 가 그 번호를 다른
// 프로세스에 주면 그 프로세스가 살아 있으므로 참이 되고, `stopDaemon` 이
// **무관한 프로세스에 SIGTERM 을 보낸다.**
//
// 판정의 재료를 하나 더 둔다: **그 홈의 소켓이 답하는가.** 소켓은 홈마다 다르고
// 그것을 여는 것은 우리 데몬뿐이므로, 답한다면 거기 있는 것은 우리 것이다.
// `PanedServer.Listen` 이 "살아 있는 데몬이 이미 있는가" 를 가릴 때 쓰는 판정과
// 같다 — 두 벌을 만들지 않는다.

func writePID(t *testing.T, home string, pid int) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, daemonPIDFile),
		[]byte(itoa(pid)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// 소켓이 답하면 우리 데몬이다.
func TestDaemonOursWhenSocketAnswers(t *testing.T) {
	home := t.TempDir()
	tr := platform.Current().IPC
	ln, err := tr.Listen(tr.Endpoint(home))
	if err != nil {
		t.Skipf("소켓을 열 수 없다: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	writePID(t, home, os.Getpid())

	if _, ours := daemonOurs(home); !ours {
		t.Fatal("소켓이 답하는데 우리 데몬이 아니라고 한다")
	}
}

// **소켓이 답하지 않으면 pid 가 살아 있어도 우리 것이 아니다** — 이것이 `FBE-07`
// 이 막으려는 자리다. 여기서 참을 주면 무관한 프로세스가 죽는다.
func TestDaemonNotOursWhenSocketSilent(t *testing.T) {
	home := t.TempDir()
	// 자기 자신의 pid 를 적는다 — 확실히 **살아 있는** 번호다. 소켓은 없다.
	writePID(t, home, os.Getpid())

	if _, ours := daemonOurs(home); ours {
		t.Fatal("소켓이 없는데 살아 있는 pid 를 우리 데몬으로 믿었다 (FBE-07)")
	}
}

// pidfile 이 없으면 당연히 아니다.
func TestDaemonNotOursWithoutPIDFile(t *testing.T) {
	if _, ours := daemonOurs(t.TempDir()); ours {
		t.Fatal("pidfile 이 없는데 참이다")
	}
}
