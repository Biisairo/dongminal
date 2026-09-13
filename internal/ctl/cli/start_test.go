package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// 격리 기동은 검사가 쓰는 경로다 — verify 가 도구 셸에 명령을 주입한다. 그
// 셸이 사용자 홈을 자기 홈으로 삼으면 주입한 명령이 사용자의 히스토리에 남는다.
func TestIsolatedToolHome(t *testing.T) {
	iso := testpath.Abs("tmp", isolatedHomePrefix+"abc123")
	// 인스턴스 홈 **아래**여야 한다. 홈을 그대로 주면 셸의 히스토리가
	// workspace·tools 와 같은 디렉터리에 쌓여 인스턴스의 저장과 겹친다.
	want := filepath.Join(iso, toolHomeDir)
	if got := isolatedToolHome(iso); got != want {
		t.Fatalf("isolatedToolHome(%q)=%q want %q", iso, got, want)
	}
}

// 사용자 인스턴스의 탭은 종전대로 사용자 홈을 쓴다 — 평소 히스토리와 rc 가
// 그대로 보여야 한다.
func TestIsolatedToolHome_UserInstanceUntouched(t *testing.T) {
	user := testpath.Abs("Users", "someone", ".dongminal")
	if got := isolatedToolHome(user); got != "" {
		t.Fatalf("isolatedToolHome(%q)=%q want \"\"", user, got)
	}
}

// M8_UNIFIED_SRS D-A-9 (FBE-09·10): 격리 기동은 **어디에 떴고 도구 셸의 홈이 무엇인지**
// 말한다 — `--foreground` 에서도. 종전에는 그 안내가 `startDetached` 안에만 있어
// 전경 기동은 임시 홈의 경로를 끝내 알리지 않았고, 도구 홈 격리도 하지 않았다.
func TestRunStart_IsolatedForegroundAnnouncesHomes(t *testing.T) {
	t.Setenv(EnvToolID, "")
	t.Setenv(EnvRestartRunner, "")
	t.Setenv(EnvHost, "")
	t.Setenv(dmenv.EnvToolHome, "")
	var out, errb bytes.Buffer
	var served string
	serve := func(home, host, port string) int {
		served = home
		// 도구 셸의 홈은 서버 프로세스의 환경으로 자식에게 간다.
		if got := os.Getenv(dmenv.EnvToolHome); got != isolatedToolHome(home) {
			t.Errorf("전경 격리 기동의 도구 홈 = %q, want %q", got, isolatedToolHome(home))
		}
		return 0
	}
	if code := RunStart(StartOpts{Isolated: true, Foreground: true}, serve, &out, &errb); code != 0 {
		t.Fatalf("exit = %d (%s)", code, errb.String())
	}
	if served == "" {
		t.Fatal("serve 가 불리지 않았다")
	}
	t.Cleanup(func() { os.RemoveAll(served) })
	for _, want := range []string{"격리 홈: " + served, "도구 셸의 홈: " + isolatedToolHome(served)} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("안내에 %q 가 없다:\n%s", want, out.String())
		}
	}
}

func TestStartHelp_MentionsIsolatedToolHome(t *testing.T) {
	if h := usageStart(); !strings.Contains(h, "도구 셸") || !strings.Contains(h, "--isolated") {
		t.Fatal("--isolated 헬프가 도구 홈 상실을 말하지 않는다")
	}
}
