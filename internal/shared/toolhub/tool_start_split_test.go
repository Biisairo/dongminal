package toolhub

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// FR-OPT-9-5 (SHR-26): StartTool 에서 떼어낸 조각들의 계약.

func TestToolStartDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	home := userHome()
	if home == "" {
		home = "."
	}
	cases := []struct{ name, cwd, want string }{
		{"빈 값은 홈", "", home},
		{"디렉터리는 그대로", dir, dir},
		{"없는 경로는 홈", filepath.Join(dir, "nope"), home},
		{"파일은 홈", file, home},
	}
	for _, c := range cases {
		if got := toolStartDir(c.cwd); got != c.want {
			t.Errorf("%s: toolStartDir(%q) = %q, want %q", c.name, c.cwd, got, c.want)
		}
	}
}

func TestToolEnvOrderAndIdentity(t *testing.T) {
	// toolEnv 는 히스토리 파일을 심는다 — 사용자의 인스턴스 홈에 쓰지 않게 가른다.
	t.Setenv(dmenv.EnvHome, t.TempDir())
	env := toolEnv("tid", "/bin/zsh", "/x/bin", []string{"SHELLVAR=1"}, []string{"EXTRA=1", "TERM=dumb"})
	idx := func(kv string) int {
		for i := len(env) - 1; i >= 0; i-- {
			if env[i] == kv {
				return i
			}
		}
		return -1
	}
	must := []string{"TERM=xterm-256color", "COLORTERM=truecolor", dmenv.EnvToolID + "=tid", "SHELLVAR=1", "EXTRA=1", "TERM=dumb"}
	for _, kv := range must {
		if idx(kv) < 0 {
			t.Fatalf("toolEnv missing %q: %v", kv, env)
		}
	}
	// os.Environ 이 앞, 도구 기본값이 그 뒤, 호출자 추가 환경이 맨 뒤 (dedupEnv 가 뒤를 남긴다).
	if n := len(os.Environ()); idx("TERM=xterm-256color") < n {
		t.Fatalf("tool defaults must follow os.Environ: idx=%d environ=%d", idx("TERM=xterm-256color"), n)
	}
	if !(idx("TERM=xterm-256color") < idx("SHELLVAR=1") && idx("SHELLVAR=1") < idx("EXTRA=1") && env[len(env)-1] == "TERM=dumb") {
		t.Fatalf("order broken: %v", env)
	}
}

func TestApplyHooksSharedByDetachedTool(t *testing.T) {
	var got string
	h := &ToolHooks{OnAttention: func(id, reason string) { got = id + ":" + reason }, AllowBell: true,
		OnSize: func(string, uint16, uint16) {}}
	p := &Tool{ID: "a"}
	p.applyHooks(h)
	if p.onAttention == nil || !p.allowBell || p.onAttentionClear != nil || p.onActivity != nil {
		t.Fatalf("applyHooks did not copy attention wiring")
	}
	if p.onSize != nil {
		t.Fatal("applyHooks must not wire OnSize (StartTool only)")
	}
	p.onAttention("a", "r")
	if got != "a:r" {
		t.Fatalf("hook not the given one: %q", got)
	}
	var nilTool Tool
	nilTool.applyHooks(nil)
}
