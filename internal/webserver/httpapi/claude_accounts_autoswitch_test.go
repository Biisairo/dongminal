package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
)

// TC-CAC-17·26: 자동 전환 API (FR-CAC-75·76·120).

func newCAEnvProcs(t *testing.T, procs *[]string) *caEnv {
	t.Helper()
	home, data := t.TempDir(), t.TempDir()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	srv, err := New(Config{DataDir: data, ClaudeHome: home, ClaudeAPI: "http://127.0.0.1:1", ClaudeSecrets: caNoSecrets{},
		ClaudeProcs: func() ([]string, error) { return *procs, nil }}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	return &caEnv{t: t, srv: srv, home: home, data: data}
}

func TestClaudeAccountsAutoswitchGetPut(t *testing.T) {
	var procs []string
	e := newCAEnvProcs(t, &procs)
	rec, out := e.do("GET", "/api/claude-accounts/autoswitch", "")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	set := out["settings"].(map[string]any)
	st := out["state"].(map[string]any)
	if set["enabled"] != false || set["threshold"] != float64(90) || set["strategy"] != "best" || st["status"] != "off" {
		t.Fatalf("%s", rec.Body)
	}
	if q, ok := st["quarantined"].([]any); !ok || len(q) != 0 {
		t.Fatalf("quarantined is an empty list: %s", rec.Body)
	}
	rec, out = e.do("PUT", "/api/claude-accounts/autoswitch", `{"enabled":true,"threshold":85}`)
	if rec.Code != 200 || out["settings"].(map[string]any)["threshold"] != float64(85) || out["state"].(map[string]any)["status"] != "on" {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	b, err := os.ReadFile(filepath.Join(e.data, "claude-accounts", "autoswitch.json"))
	if err != nil || !strings.Contains(string(b), `"threshold": 85`) {
		t.Fatalf("saved: %v %s", err, b)
	}
	_, out = e.do("GET", "/api/claude-accounts", "")
	sum := out["autoswitch"].(map[string]any)
	if sum["enabled"] != true || sum["status"] != "on" {
		t.Fatalf("list summary: %v", sum)
	}
	rec, _ = e.do("PUT", "/api/claude-accounts/autoswitch", `{"threshold":10}`)
	if rec.Code != 400 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeAccountInvalid {
		t.Fatalf("range: %d", rec.Code)
	}
	rec, _ = e.do("PUT", "/api/claude-accounts/autoswitch", `{"nope":1}`)
	if rec.Code != 400 {
		t.Fatalf("unknown key: %d", rec.Code)
	}
}

func TestClaudeAccountsAutoswitchCswapConflict(t *testing.T) {
	procs := []string{"/Users/u/.local/bin/cswap auto"}
	e := newCAEnvProcs(t, &procs)
	rec, _ := e.do("PUT", "/api/claude-accounts/autoswitch", `{"enabled":true}`)
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeCswapRunning {
		t.Fatalf("%d %s", rec.Code, rec.Header())
	}
}
