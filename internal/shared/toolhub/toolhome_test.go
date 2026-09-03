package toolhub

import (
	"os"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// 도구 셸은 로그인 셸이라 rc 를 읽고 히스토리를 쓴다. 그 HOME 이 언제나 사용자
// 홈이면 **검사가 주입한 명령이 사용자의 히스토리에 남는다** — 실제로 남았다.
// 이 자리가 그것을 떼어낼 수 있는 유일한 이음매다.
func TestToolHome_OverrideWins(t *testing.T) {
	iso := t.TempDir()
	t.Setenv(dmenv.EnvToolHome, iso)
	if got := toolHome(); got != iso {
		t.Fatalf("toolHome()=%q want %q", got, iso)
	}
}

// 오버라이드가 없으면 종전대로 사용자 홈이다 — 프로덕션 동작은 그대로다.
func TestToolHome_FallsBackToUserHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv(dmenv.EnvToolHome, "")
	t.Setenv(testpath.HomeEnv(), home)
	if got := toolHome(); got != home {
		t.Fatalf("toolHome()=%q want %q", got, home)
	}
}

// 순수 함수만으로는 환경 조립이 어긋나도 잡히지 않는다 — 실제로 뜬 셸이
// 그 HOME 을 보는지 확인한다.
func TestStartTool_ShellSeesIsolatedHome(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("$HOME 을 셸에게 되묻는 POSIX 문법이다")
	}
	iso := t.TempDir()
	t.Setenv(dmenv.EnvToolHome, iso)

	p, err := StartTool("t-home", "home", iso, 80, 24, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	defer p.kill()

	time.Sleep(500 * time.Millisecond)
	if err := p.Write([]byte("printf 'HOMEIS(%s)\\n' \"$HOME\"\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	want := "HOMEIS(" + iso + ")"
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		blob, _ := p.Stream().Snapshot()
		if strings.Contains(string(blob), want) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	blob, _ := p.Stream().Snapshot()
	t.Fatalf("셸이 격리 홈을 보지 못했습니다. want %q, got:\n%s", want, blob)
}

// 홈을 격리해도 **도구가 열리는 자리는 사용자 홈이다.**
//
// 둘을 한 값으로 묶었다가 e2e 여섯 건이 깨졌다 — 격리가 도구의 시작 디렉터리까지
// 옮기면서 상태바의 cwd 와 탭 이름이 달라졌다. 격리하려는 것은 셸이 쓰는 자리이지
// 사용자가 서 있는 자리가 아니다.
func TestStartTool_StartDirStaysUserHome(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("셸에게 pwd 를 되묻는 POSIX 문법이다")
	}
	want, err := os.UserHomeDir()
	if err != nil || want == "" {
		t.Skip("사용자 홈을 알 수 없다")
	}
	t.Setenv(dmenv.EnvToolHome, t.TempDir())

	// cwd 를 주지 않는다 — 그때 어디서 열리는가가 이 검사의 대상이다.
	p, err := StartTool("t-cwd", "cwd", "", 80, 24, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	defer p.kill()

	time.Sleep(500 * time.Millisecond)
	if err := p.Write([]byte("printf 'PWDIS(%s)\\n' \"$PWD\"\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	marker := "PWDIS(" + want + ")"
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		blob, _ := p.Stream().Snapshot()
		if strings.Contains(string(blob), marker) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	blob, _ := p.Stream().Snapshot()
	t.Fatalf("도구가 사용자 홈에서 열리지 않았습니다. want %q, got:\n%s", marker, blob)
}
