package cli

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// M9_SRS FR-M9-1 — **노출 게이트는 없다.**
//
// `--expose` 는 허용 목록의 상태와 무관하게 뜬다 (D-M9-1). 종전에는 목록이
// 없거나·꺼져 있거나·비어 있으면 exit 1 로 기동을 막았고, 접수한 말은 그 거부가
// "IP 필터가 꺼져 있는데도 IP 등록을 요구한다" 로 읽힌다는 것이었다.
//
// **대가는 D-M9-1 에 적혀 있다** — 인증이 없는 동안 허용 목록을 켜지 않고 노출하면
// 같은 망의 누구나 셸에 닿는다. 그 판단이 사용자의 손으로 옮겨졌다.
func TestRunStart_ExposeStartsWithoutAllowlist(t *testing.T) {
	for _, tc := range []struct {
		name string
		acl  string // "" 이면 파일 없음
	}{
		{"목록 없음", ""},
		{"목록 꺼짐", `{"enabled":false,"entries":[]}`},
		{"켜졌으나 항목 없음", `{"enabled":true,"entries":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if tc.acl != "" {
				writeACL(t, home, tc.acl)
			}
			t.Setenv(EnvToolID, "")
			t.Setenv(EnvRestartRunner, "")
			t.Setenv(EnvHost, "")
			t.Setenv(dmenv.EnvToolHome, "")

			var out, errb bytes.Buffer
			var gotHost string
			serve := func(_, host, _ string) int { gotHost = host; return 0 }
			opts := StartOpts{Expose: true, Foreground: true}
			opts.Home = home
			opts.Port = "59999"

			if code := RunStart(opts, serve, &out, &errb); code != 0 {
				t.Fatalf("exit = %d, 노출 기동이 막혔다: %s", code, errb.String())
			}
			if gotHost != ExposeHost {
				t.Fatalf("serve 의 host = %q want %q", gotHost, ExposeHost)
			}
			if strings.Contains(errb.String(), "허용 목록") {
				t.Fatalf("사라진 게이트의 문구가 남아 있다:\n%s", errb.String())
			}
		})
	}
}

// FR-M9-1: `--insecure-no-acl` 은 게이트와 함께 사라진다. 아무것도 하지 않는
// 플래그를 남기면 그것이 곧 거짓 안내다.
func TestParseStart_InsecureNoACLIsGone(t *testing.T) {
	if _, err := ParseStart([]string{"--insecure-no-acl"}); err == nil {
		t.Fatal("--insecure-no-acl 이 아직 받아들여진다")
	}
	if h := usageStart(); strings.Contains(h, "insecure-no-acl") {
		t.Fatalf("헬프에 --insecure-no-acl 이 남아 있다:\n%s", h)
	}
}

// M9_SRS FR-M9-2 / D-M9-2 — **격리는 호스트를 상속하지 않는다.**
//
// 도구 셸은 `DONGMINAL_HOST` 를 물려받는다. 운영 인스턴스가 `--expose` 로 떠 있으면
// 그 값이 `0.0.0.0` 이고, 그 셸에서 `start --isolated` 를 치면 검사용 인스턴스가
// 0.0.0.0 에 열렸다 — 격리의 뜻("운영을 건드리지 않는다")에 반한다.
func TestStartFlagHost_IsolatedIgnoresInheritedHost(t *testing.T) {
	for _, tc := range []struct {
		name string
		o    StartOpts
		want string
	}{
		{"격리만", StartOpts{Isolated: true}, dmenv.DefaultHost},
		{"격리 + 노출은 노출이 이긴다", StartOpts{Isolated: true, Expose: true}, ExposeHost},
		{"노출만", StartOpts{Expose: true}, ExposeHost},
		{"둘 다 아님 — 정하지 않음", StartOpts{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(EnvHost, ExposeHost)
			if got := startFlagHost(tc.o); got != tc.want {
				t.Fatalf("startFlagHost = %q want %q", got, tc.want)
			}
		})
	}
}

// 같은 것을 기동 전량으로 한 번 더 — 계층이 실제로 그렇게 풀리는지는 `serve` 가 받는
// host 로만 알 수 있다.
func TestRunStart_IsolatedBindsLoopbackDespiteEnv(t *testing.T) {
	t.Setenv(EnvToolID, "")
	t.Setenv(EnvRestartRunner, "")
	t.Setenv(EnvHost, ExposeHost)
	t.Setenv(dmenv.EnvToolHome, "")

	var out, errb bytes.Buffer
	var gotHost, served string
	serve := func(home, host, _ string) int { served, gotHost = home, host; return 0 }
	if code := RunStart(StartOpts{Isolated: true, Foreground: true}, serve, &out, &errb); code != 0 {
		t.Fatalf("exit = %d (%s)", code, errb.String())
	}
	t.Cleanup(func() { os.RemoveAll(served) })
	if gotHost != dmenv.DefaultHost {
		t.Fatalf("격리 기동의 host = %q want %q", gotHost, dmenv.DefaultHost)
	}
}
