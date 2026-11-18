package swap

import (
	"dongminal/internal/shared/platform"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/handover"
)

// writeExe 는 dir 에 실행 파일 하나를 쓴다. 사전 확인 시험은 이것을 새 바이너리로 쓴다.
func writeExe(t *testing.T, dir, name, script string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func reasonOf(err error) string {
	if err == nil {
		return ""
	}
	r, _, _ := strings.Cut(err.Error(), ": ")
	return r
}

func posixOnly(t *testing.T) {
	t.Helper()
	if platform.Current().OS == platform.Windows {
		t.Skip("교체는 POSIX 만 지원한다 (D-DSK-7)")
	}
}

// TC-DSK-5 (FR-DSK-11): 요청 검사의 거절이 각 사유 코드로 나온다.
func TestValidate_Refusals(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	good := writeExe(t, dir, "good", "exit 0", 0o755)
	other := writeExe(t, dir, "other", "exit 0", 0o755)
	noexec := writeExe(t, dir, "noexec", "exit 0", 0o644)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(good, link); err != nil {
		t.Fatal(err)
	}
	me := os.Geteuid()
	self, err := filepath.EvalSymlinks(good)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		req    handover.ReloadRequest
		env    Env
		reason string
	}{
		{"정상", handover.ReloadRequest{Exe: good, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, ""},
		{"상대경로", handover.ReloadRequest{Exe: "bin/dongminal", Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"없는 파일", handover.ReloadRequest{Exe: filepath.Join(dir, "none"), Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"디렉터리", handover.ReloadRequest{Exe: dir, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"링크로 가리킨 자기 경로", handover.ReloadRequest{Exe: link, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, ""},
		// 보안: 데몬 자신의 실행 파일이 아닌 바이너리는 exec 하지 않는다 (샌드박스가 마운트한 폴더에 둔 파일 등).
		{"다른 바이너리", handover.ReloadRequest{Exe: other, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"자기 경로 모름", handover.ReloadRequest{Exe: good, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin"}, handover.ReasonExe},
		{"실행 불가", handover.ReloadRequest{Exe: noexec, Handover: handover.Version}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"소유자 다름", handover.ReloadRequest{Exe: good, Handover: handover.Version}, Env{EUID: me + 1, GOOS: "darwin", SelfExe: self}, handover.ReasonExe},
		{"판 다름", handover.ReloadRequest{Exe: good, Handover: handover.Version + 1}, Env{EUID: me, GOOS: "darwin", SelfExe: self}, handover.ReasonVersion},
		{"Windows", handover.ReloadRequest{Exe: good, Handover: handover.Version}, Env{EUID: me, GOOS: "windows", SelfExe: self}, handover.ReasonUnsupported},
	}
	for _, c := range cases {
		if got := reasonOf(Validate(c.req, c.env)); got != c.reason {
			t.Errorf("%s: 사유 = %q, want %q", c.name, got, c.reason)
		}
	}
}

// TC-DSK-6 (FR-DSK-12): 새 바이너리가 같은 인계 판을 말해야 통과한다.
func TestPreflight(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	same := writeExe(t, dir, "same", `[ "$1 $2" = "d --handover-version" ] && echo `+strconv.Itoa(handover.Version), 0o755)
	other := writeExe(t, dir, "other", "echo "+strconv.Itoa(handover.Version+1), 0o755)
	fails := writeExe(t, dir, "fails", "echo "+strconv.Itoa(handover.Version)+"; exit 3", 0o755)
	slow := writeExe(t, dir, "slow", "sleep 5", 0o755)
	junk := writeExe(t, dir, "junk", "echo hello", 0o755)

	if err := Preflight(same, time.Second); err != nil {
		t.Fatalf("같은 판인데 거절: %v", err)
	}
	for name, exe := range map[string]string{"판 다름": other, "비정상 종료": fails, "숫자 아님": junk} {
		if got := reasonOf(Preflight(exe, time.Second)); got != handover.ReasonPreflight {
			t.Errorf("%s: 사유 = %q, want %q", name, got, handover.ReasonPreflight)
		}
	}
	start := time.Now()
	if got := reasonOf(Preflight(slow, 200*time.Millisecond)); got != handover.ReasonPreflight {
		t.Errorf("시한 초과: 사유 = %q", got)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("시한을 지키지 않았다: %v", time.Since(start))
	}
}

// FR-DSK-11: 진행 중인 교체가 있으면 다음 요청은 reload_busy 다.
func TestGate_Busy(t *testing.T) {
	var g Gate
	if !g.Enter() {
		t.Fatal("처음 들어가지 못했다")
	}
	if g.Enter() {
		t.Fatal("진행 중인데 또 들어갔다")
	}
	g.Leave()
	if !g.Enter() {
		t.Fatal("나온 뒤 다시 들어가지 못했다")
	}
}
