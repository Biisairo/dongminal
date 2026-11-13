//go:build !windows

package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-20: claude shim. POSIX 실행 비트로 진짜 claude 를 흉내 내므로 POSIX 전용이다.

type shimRun struct {
	path string
	argv []string
	env  []string
}

// shimFixture 는 DONGMINAL_HOME, 진짜 claude 가 있는 PATH, 실행 가로채기를 세운다.
func shimFixture(t *testing.T) (home, real string, ran *shimRun) {
	t.Helper()
	home = t.TempDir()
	shims := dmenv.AgentShimsDirIn(filepath.Join(home, "bin"))
	realDir := t.TempDir()
	for _, d := range []string{shims, realDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(dmenv.EnvHome, home)
	t.Setenv("PATH", shims+string(os.PathListSeparator)+realDir)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv(dmenv.EnvToolID, "tool-1")
	ran = &shimRun{}
	prev := shimExec
	shimExec = func(path string, argv, env []string) int {
		ran.path, ran.argv, ran.env = path, argv, env
		return 7
	}
	t.Cleanup(func() { shimExec = prev })
	return home, filepath.Join(realDir, "claude"), ran
}

func shimServer(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	host, port, _ := net.SplitHostPort(u.Host)
	t.Setenv(dmenv.EnvHost, host)
	t.Setenv(dmenv.EnvPort, port)
}

func envValue(env []string, key string) (string, bool) {
	v := ""
	found := false
	for _, kv := range env {
		if k, val, ok := strings.Cut(kv, "="); ok && k == key {
			v, found = val, true
		}
	}
	return v, found
}

func TestClaudeShimFindsRealClaudeOutsideShims(t *testing.T) {
	_, real, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"source":"none"}`)) })
	var errb bytes.Buffer
	if code := runClaude([]string{"-p", "hi"}, &bytes.Buffer{}, &errb); code != 7 {
		t.Fatalf("code %d %s", code, errb.String())
	}
	if ran.path != real {
		t.Fatalf("path %q want %q", ran.path, real)
	}
	if got := ran.argv[len(ran.argv)-2:]; got[0] != "-p" || got[1] != "hi" {
		t.Fatalf("argv %v", ran.argv)
	}
	if v, ok := envValue(ran.env, "CLAUDE_CONFIG_DIR"); ok && v != "" {
		t.Fatalf("none must not set CLAUDE_CONFIG_DIR: %q", v)
	}
}

func TestClaudeShimNotFound(t *testing.T) {
	home, _, ran := shimFixture(t)
	t.Setenv("PATH", dmenv.AgentShimsDirIn(filepath.Join(home, "bin")))
	var errb bytes.Buffer
	if code := runClaude(nil, &bytes.Buffer{}, &errb); code != 127 {
		t.Fatalf("code %d", code)
	}
	if !strings.Contains(errb.String(), "claude 를 찾을 수 없습니다") || ran.path != "" {
		t.Fatalf("%q %q", errb.String(), ran.path)
	}
}

// 기존 래퍼와 같은 규칙: 있을 때만 붙인다. 붙이는 플래그는 어댑터 선언과 같다.
func TestClaudeShimInjectsHookArgs(t *testing.T) {
	home, _, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"source":"none"}`)) })
	_ = runClaude([]string{"x"}, &bytes.Buffer{}, &bytes.Buffer{})
	if len(ran.argv) != 2 {
		t.Fatalf("no assets → no flags: %v", ran.argv)
	}
	bin := filepath.Join(home, "bin")
	settings := filepath.Join(dmenv.AgentHooksDirIn(bin), "claude.json")
	plugin := filepath.Join(bin, "agent-plugin")
	_ = os.MkdirAll(filepath.Dir(settings), 0o755)
	_ = os.WriteFile(settings, []byte("{}"), 0o644)
	_ = os.MkdirAll(plugin, 0o755)
	_ = runClaude([]string{"x"}, &bytes.Buffer{}, &bytes.Buffer{})
	want := []string{ran.path, "--settings", settings, "--plugin-dir", plugin, "x"}
	if strings.Join(ran.argv, "|") != strings.Join(want, "|") {
		t.Fatalf("argv %v want %v", ran.argv, want)
	}
	ad, err := agentadapter.Get("claude")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range ad.PolicyInjection.Flags {
		if !strings.Contains(strings.Join(ran.argv, " "), f) {
			t.Errorf("declared flag %q not injected", f)
		}
	}
}

func TestClaudeShimUserConfigDirWins(t *testing.T) {
	_, _, ran := shimFixture(t)
	var calls atomic.Int32
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1) })
	t.Setenv("CLAUDE_CONFIG_DIR", "/mine")
	if code := runClaude(nil, &bytes.Buffer{}, &bytes.Buffer{}); code != 7 {
		t.Fatalf("code %d", code)
	}
	if calls.Load() != 0 {
		t.Fatal("server must not be asked")
	}
	if v, _ := envValue(ran.env, "CLAUDE_CONFIG_DIR"); v != "/mine" {
		t.Fatalf("env %q", v)
	}
}

func TestClaudeShimAppliesConfigDir(t *testing.T) {
	_, _, ran := shimFixture(t)
	var body map[string]any
	shimServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/claude-accounts/launch" {
			http.Error(w, "bad", 404)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"accountId":"a1","source":"tab","configDir":"/p/a1"}`))
	})
	if code := runClaude(nil, &bytes.Buffer{}, &bytes.Buffer{}); code != 7 {
		t.Fatalf("code %d", code)
	}
	if v, _ := envValue(ran.env, "CLAUDE_CONFIG_DIR"); v != "/p/a1" {
		t.Fatalf("env %q", v)
	}
	wd, _ := os.Getwd()
	if body["toolId"] != "tool-1" || body["cwd"] != wd {
		t.Fatalf("body %v", body)
	}
}

// D-CAC-25: 오류·시간 초과면 실행하지 않는다.
func TestClaudeShimServerErrorRefuses(t *testing.T) {
	_, _, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"code":"internal","message":"profile preparation failed"}`))
	})
	var errb bytes.Buffer
	if code := runClaude(nil, &bytes.Buffer{}, &errb); code != 1 {
		t.Fatalf("code %d", code)
	}
	if ran.path != "" || !strings.Contains(errb.String(), "dongminal: Claude 계정 지정을 적용하지 못했습니다 (") {
		t.Fatalf("%q ran=%q", errb.String(), ran.path)
	}
}

func TestClaudeShimTimeoutRefuses(t *testing.T) {
	_, _, ran := shimFixture(t)
	prev := shimBudget
	shimBudget = 50 * time.Millisecond
	t.Cleanup(func() { shimBudget = prev })
	release := make(chan struct{})
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { <-release })
	t.Cleanup(func() { close(release) })
	var errb bytes.Buffer
	if code := runClaude(nil, &bytes.Buffer{}, &errb); code != 1 {
		t.Fatalf("code %d", code)
	}
	if ran.path != "" || !strings.Contains(errb.String(), "적용하지 못했습니다") {
		t.Fatalf("%q", errb.String())
	}
}

// D-CAC-25: 서버가 꺼져 있으면(연결 거부) 기본 계정으로 실행한다.
func TestClaudeShimServerDownRunsDefault(t *testing.T) {
	_, real, ran := shimFixture(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	t.Setenv(dmenv.EnvHost, "127.0.0.1")
	t.Setenv(dmenv.EnvPort, port)
	var errb bytes.Buffer
	if code := runClaude(nil, &bytes.Buffer{}, &errb); code != 7 {
		t.Fatalf("code %d %s", code, errb.String())
	}
	if ran.path != real || errb.Len() != 0 {
		t.Fatalf("%q %q", ran.path, errb.String())
	}
}

// runClaude 는 등록부의 shim 이름으로 shim 을 부른다 — 디스패치가 하는 일과 같다.
func runClaude(args []string, stdout, stderr io.Writer) int {
	return commands["claude"](args, stdout, stderr)
}
