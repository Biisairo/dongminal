package cli

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// FR-CLI-4/6/7: 액션 옵션 파싱.

func TestParseStart_Flags(t *testing.T) {
	o, err := ParseStart([]string{"--expose", "--restart-daemon", "--isolated", "--foreground"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !o.Expose || !o.RestartDaemon || !o.Isolated || !o.Foreground {
		t.Fatalf("플래그 누락: %+v", o)
	}
}

// V-WIN-5: `--open` 은 `dongminal window` 로 갈라져 나갔다 (FR-WIN-8/9). 별칭으로
// 남기지 않았으므로 모르는 옵션이어야 한다 — 조용히 무시되면 사용자는 창이 열리지
// 않는 이유를 모른다.
func TestParseStart_OpenIsGone(t *testing.T) {
	_, err := ParseStart([]string{"--open"})
	if err == nil {
		t.Fatal("--open 이 아직 받아들여진다")
	}
	if !strings.Contains(err.Error(), "--open") {
		t.Fatalf("무엇이 잘못됐는지 알리지 않는다: %v", err)
	}
}

func TestParseStart_Defaults(t *testing.T) {
	o, err := ParseStart(nil)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if o.Expose || o.RestartDaemon || o.Isolated || o.Foreground {
		t.Fatalf("기본값이 켜져 있음: %+v", o)
	}
	if o.Port != "" || o.Home != "" {
		t.Fatalf("공통 옵션 기본값은 빈 문자열이어야 한다: %+v", o.Common)
	}
}

func TestParseHelp_AllActions(t *testing.T) {
	cases := []struct {
		name string
		fn   func([]string) error
	}{
		{"start", func(a []string) error { _, e := ParseStart(a); return e }},
		{"stop", func(a []string) error { _, e := ParseStop(a); return e }},
		{"health", func(a []string) error { _, e := ParseHealth(a); return e }},
		{"window", func(a []string) error { _, e := ParseWindow(a); return e }},
		{"migrate", func(a []string) error { _, e := ParseMigrate(a); return e }},
	}
	for _, c := range cases {
		for _, flag := range []string{"-h", "--help"} {
			if err := c.fn([]string{flag}); !errors.Is(err, ErrHelp) {
				t.Errorf("%s %s → %v, want ErrHelp", c.name, flag, err)
			}
		}
	}
}

func TestParse_UnknownFlag(t *testing.T) {
	if _, err := ParseStop([]string{"--bogus"}); err == nil {
		t.Fatal("알 수 없는 옵션이 통과했다")
	} else if !strings.Contains(err.Error(), "--bogus") {
		t.Errorf("오류에 플래그명 없음: %v", err)
	}
}

func TestParse_CommonBothForms(t *testing.T) {
	for _, args := range [][]string{
		{"--port", "9000", "--home", "/tmp/x"},
		{"--port=9000", "--home=/tmp/x"},
	} {
		o, err := ParseStop(args)
		if err != nil {
			t.Fatalf("%v: err=%v", args, err)
		}
		if o.Port != "9000" || o.Home != "/tmp/x" {
			t.Errorf("%v → %+v", args, o.Common)
		}
	}
}

func TestParse_CommonMissingValue(t *testing.T) {
	for _, args := range [][]string{{"--port"}, {"--home"}, {"--port="}} {
		if _, err := ParseHealth(args); err == nil {
			t.Errorf("%v 가 통과했다", args)
		}
	}
}

func TestParse_PortMustBeNumeric(t *testing.T) {
	if _, err := ParseHealth([]string{"--port", "abc"}); err == nil {
		t.Fatal("포트가 아닌 값이 통과했다")
	}
	if _, err := ParseHealth([]string{"--port", "70000"}); err == nil {
		t.Fatal("범위 밖 포트가 통과했다")
	}
}

func TestParseMigrate_DryRunAliases(t *testing.T) {
	for _, flag := range []string{"--dry-run", "-n"} {
		o, err := ParseMigrate([]string{flag})
		if err != nil || !o.DryRun {
			t.Errorf("%s → %+v %v", flag, o, err)
		}
	}
}

// FR-CLI-9: 플래그 > 환경변수 > 기본값.

func TestResolvePort_Priority(t *testing.T) {
	t.Setenv(EnvPort, "7777")
	if got := (Common{Port: "9000"}).ResolvePort(); got != "9000" {
		t.Errorf("플래그가 이겨야 한다: %s", got)
	}
	if got := (Common{}).ResolvePort(); got != "7777" {
		t.Errorf("환경변수가 이겨야 한다: %s", got)
	}
	t.Setenv(EnvPort, "")
	if got := (Common{}).ResolvePort(); got != DefaultPort {
		t.Errorf("기본값이어야 한다: %s", got)
	}
}

func TestResolveHome_Priority(t *testing.T) {
	t.Setenv(EnvHome, "/tmp/env-home")
	got, err := (Common{Home: "/tmp/flag-home"}).ResolveHome()
	if err != nil || got != "/tmp/flag-home" {
		t.Errorf("플래그가 이겨야 한다: %s %v", got, err)
	}
	got, err = (Common{}).ResolveHome()
	if err != nil || got != "/tmp/env-home" {
		t.Errorf("환경변수가 이겨야 한다: %s %v", got, err)
	}
	t.Setenv(EnvHome, "")
	got, err = (Common{}).ResolveHome()
	if err != nil {
		t.Fatal(err)
	}
	uh, _ := os.UserHomeDir()
	if got != filepath.Join(uh, ".dongminal") {
		t.Errorf("기본값이어야 한다: %s", got)
	}
}

func TestResolveHome_ExpandsTilde(t *testing.T) {
	t.Setenv(EnvHome, "~/.dongminal-test")
	got, err := (Common{}).ResolveHome()
	if err != nil {
		t.Fatal(err)
	}
	uh, _ := os.UserHomeDir()
	if got != filepath.Join(uh, ".dongminal-test") {
		t.Errorf("~ 확장 실패: %s", got)
	}
}

// FR-CLI-3: help 는 액션 4개를 모두 담는다.

func TestHelp_ListsEveryAction(t *testing.T) {
	h := Help()
	for _, a := range Actions {
		if !strings.Contains(h, a) {
			t.Errorf("help 에 %q 가 없다", a)
		}
	}
	// 내부 진입점 `d`(데몬)는 액션으로 광고하지 않는다 (FR-CLI-8).
	for _, line := range strings.Split(h, "\n") {
		if strings.HasPrefix(strings.TrimRight(line, " "), "  d ") {
			t.Errorf("내부 진입점이 액션으로 노출됐다: %q", line)
		}
	}
}

func TestUsage_MentionsOwnAction(t *testing.T) {
	for _, a := range Actions {
		if !strings.Contains(Usage(a), "dongminal "+a) {
			t.Errorf("%s 사용법에 자기 이름이 없다", a)
		}
	}
}

// FR-ISO-1/3: 격리 대상 해석.

func TestResolveStartTarget_Isolated(t *testing.T) {
	t.Setenv(EnvHome, "/tmp/should-not-be-used")
	t.Setenv(EnvPort, "58146")
	home, port, err := resolveStartTarget(StartOpts{Isolated: true})
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	if !strings.Contains(filepath.Base(home), "dongminal-iso-") {
		t.Errorf("격리 홈이 아니다: %s", home)
	}
	if port == "58146" {
		t.Error("격리 실행이 운영 포트를 골랐다")
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 {
		t.Errorf("포트가 아니다: %s", port)
	}
}

func TestResolveStartTarget_IsolatedRespectsExplicit(t *testing.T) {
	home, port, err := resolveStartTarget(StartOpts{
		Isolated: true,
		Common:   Common{Port: "58200", Home: "/tmp/dm-explicit"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if home != "/tmp/dm-explicit" || port != "58200" {
		t.Errorf("명시한 값이 무시됐다: %s %s", home, port)
	}
}

func TestResolveStartTarget_Plain(t *testing.T) {
	t.Setenv(EnvHome, "/tmp/plain-home")
	t.Setenv(EnvPort, "58146")
	home, port, err := resolveStartTarget(StartOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if home != "/tmp/plain-home" || port != "58146" {
		t.Errorf("환경변수가 반영되지 않았다: %s %s", home, port)
	}
}

// FR-ISO-1: 빈 포트 확보.

func TestFreePort(t *testing.T) {
	p, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(p)
	if err != nil || n < 1024 || n > 65535 {
		t.Errorf("포트가 아니다: %s", p)
	}
}

// FR-FG-4: 자식 환경변수에 중복 키를 남기지 않는다.

func TestWithEnv_Overrides(t *testing.T) {
	got := withEnv([]string{"PATH=/bin", "PORT=1", "DONGMINAL_HOME=/old"}, map[string]string{
		"PORT":           "2",
		"DONGMINAL_HOME": "/new",
	})
	seen := map[string]int{}
	for _, e := range got {
		k, v, _ := strings.Cut(e, "=")
		seen[k]++
		if k == "PORT" && v != "2" {
			t.Errorf("PORT=%s", v)
		}
		if k == "DONGMINAL_HOME" && v != "/new" {
			t.Errorf("DONGMINAL_HOME=%s", v)
		}
	}
	for k, n := range seen {
		if n != 1 {
			t.Errorf("%s 가 %d번 나온다", k, n)
		}
	}
	if seen["PATH"] != 1 {
		t.Error("무관한 환경변수가 사라졌다")
	}
}

// FR-ACT-3a/3b: 대리 표식과 도구 식별자는 detach 되는 서버에 물려주지 않는다.
// 새 값도 주지 않고 지운다 — 사슬을 타고 도구 셸까지 흘러가면 다음 도구 안
// 재시작이 위임을 건너뛴다.

func TestWithEnv_Drops(t *testing.T) {
	got := withEnv([]string{
		"PATH=/bin",
		EnvRestartRunner + "=1",
		EnvToolID + "=tool-7",
	}, map[string]string{EnvPort: "2"}, EnvRestartRunner, EnvToolID)

	for _, e := range got {
		k, _, _ := strings.Cut(e, "=")
		if k == EnvRestartRunner || k == EnvToolID {
			t.Errorf("%s 가 자식 환경에 남았다", e)
		}
	}
	if !slices.Contains(got, "PATH=/bin") {
		t.Error("무관한 환경변수가 사라졌다")
	}
	if !slices.Contains(got, EnvPort+"=2") {
		t.Error("새 값이 붙지 않았다")
	}
}
