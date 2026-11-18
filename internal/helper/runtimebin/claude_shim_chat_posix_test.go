//go:build !windows

package runtimebin

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// PEER_CHAT_SRS TC-PCH-15 — shim 은 채팅 소켓이 열려 있을 때만 MCP 를 주입한다 (FR-PCH-50, NFR-PCH-5, D-PCH-36).

// chatHome 은 소켓 경로 상한(104바이트) 안의 짧은 홈이다.
func chatHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dmch")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// listenChat 은 home 에 채팅 소켓을 연다. 받은 연결은 serve 가 다룬다.
func listenChat(t *testing.T, home string, serve func(net.Conn)) {
	t.Helper()
	ln, err := platform.Current().IPC.Listen(chatwire.SocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); serve(c) }()
		}
	}()
}

func chatShimRun(t *testing.T, socket bool) *shimRun {
	t.Helper()
	_, _, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"source":"none"}`)) })
	home := chatHome(t)
	t.Setenv(dmenv.EnvHome, home)
	if socket {
		listenChat(t, home, func(net.Conn) {})
	}
	_ = runClaude([]string{"--mcp-config", "user.json", "질문"}, &bytes.Buffer{}, &bytes.Buffer{})
	return ran
}

func TestClaudeShimInjectsChatMCP(t *testing.T) {
	ran := chatShimRun(t, true)
	home := os.Getenv(dmenv.EnvHome)
	n := len(ran.argv)
	if n < 5 || strings.Join(ran.argv[n-3:], "|") != "--mcp-config|user.json|질문" {
		t.Fatalf("사용자 인자가 끝에 그대로 있지 않다: %q", ran.argv)
	}
	if ran.argv[n-4] != "--allowedTools=mcp__dongminal" {
		t.Fatalf("허락 인자 %q", ran.argv[n-4])
	}
	cfgArg := ran.argv[n-5]
	if !strings.HasPrefix(cfgArg, "--mcp-config=") {
		t.Fatalf("mcp 인자 %q", cfgArg)
	}
	var cfg struct {
		Servers map[string]struct {
			Type    string            `json:"type"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(cfgArg, "--mcp-config=")), &cfg); err != nil {
		t.Fatal(err)
	}
	s, ok := cfg.Servers["dongminal"]
	if !ok || s.Type != "stdio" || s.Command != filepath.Join(home, "bin", "dmctl") || strings.Join(s.Args, " ") != "chat-mcp" {
		t.Fatalf("config %+v", cfg)
	}
	if s.Env[dmenv.EnvHome] != home || s.Env[dmenv.EnvToolID] != "tool-1" {
		t.Fatalf("env %+v", s.Env)
	}
}

func TestClaudeShimNoChatWithoutSocket(t *testing.T) {
	ran := chatShimRun(t, false)
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--mcp-config=") || strings.HasPrefix(a, "--allowedTools") {
			t.Fatalf("소켓이 없는데 주입했다: %q", ran.argv)
		}
	}
}

func TestClaudeShimNoChatWithoutTool(t *testing.T) {
	_, _, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"source":"none"}`)) })
	home := chatHome(t)
	t.Setenv(dmenv.EnvHome, home)
	t.Setenv(dmenv.EnvToolID, "")
	listenChat(t, home, func(net.Conn) {})
	_ = runClaude(nil, &bytes.Buffer{}, &bytes.Buffer{})
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--mcp-config=") {
			t.Fatalf("도구 id 없이 주입했다: %q", ran.argv)
		}
	}
}

// FR-PCH-60: 맥락 훅은 안 읽은 글이 있을 때만 줄을 덧붙인다. 방 이름은 싣지 않는다.
func chatHookRun(t *testing.T, verdict string, total int) (string, chatwire.Frame) {
	t.Helper()
	home := chatHome(t)
	t.Setenv(dmenv.EnvHome, home)
	asked := make(chan chatwire.Frame, 1)
	listenChat(t, home, func(c net.Conn) {
		sc := chatwire.NewScanner(c)
		if !sc.Scan() {
			return
		}
		var f chatwire.Frame
		_ = json.Unmarshal(sc.Bytes(), &f)
		asked <- f
		b, _ := chatwire.Encode(chatwire.Frame{T: chatwire.TypeUnread, Total: total})
		c.Write(b)
	})
	out, _ := ctxHookRun(t, verdict, `{"hook_event_name":"PostToolUse","session_id":"s-1"}`)
	select {
	case f := <-asked:
		return out, f
	default:
		return out, chatwire.Frame{}
	}
}

func hookContext(t *testing.T, out string) string {
	t.Helper()
	if out == "" {
		return ""
	}
	var got struct {
		H struct {
			Ctx string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("출력=%q: %v", out, err)
	}
	return got.H.Ctx
}

func TestCtxHookAddsUnreadLine(t *testing.T) {
	out, asked := chatHookRun(t, `{"verdict":"none"}`, 3)
	if asked.T != chatwire.TypeUnread || asked.Session != "s-1" {
		t.Fatalf("질의 %+v", asked)
	}
	if ctx := hookContext(t, out); ctx != "[dongminal chat] 읽지 않은 글 3건. 하던 일을 마친 뒤 chat_read 로 확인한다." {
		t.Fatalf("ctx %q", ctx)
	}
}

func TestCtxHookNoUnreadNoLine(t *testing.T) {
	if out, _ := chatHookRun(t, `{"verdict":"none"}`, 0); out != "" {
		t.Fatalf("출력 %q", out)
	}
}

func TestCtxHookJoinsAdviceAndUnread(t *testing.T) {
	out, _ := chatHookRun(t, `{"verdict":"unknown"}`, 2)
	ctx := hookContext(t, out)
	lines := strings.Split(ctx, "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "맥락 사용률을 읽을 수 없어") || !strings.Contains(lines[1], "읽지 않은 글 2건") {
		t.Fatalf("ctx %q", ctx)
	}
}
