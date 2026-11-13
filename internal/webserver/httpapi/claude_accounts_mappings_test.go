package httpapi

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-18 (API): mappings·resolve·launch.

func (e *caEnv) addOne(t *testing.T) string {
	t.Helper()
	e.login("a@x.com", "org-a", "SECRET-A", "RT-A")
	rec, out := e.do("POST", "/api/claude-accounts/add", "{}")
	if rec.Code != 200 {
		t.Fatalf("add %d %s", rec.Code, rec.Body)
	}
	return out["account"].(map[string]any)["id"].(string)
}

func TestClaudeAccountsMappingsAndLaunch(t *testing.T) {
	e := newCAEnv(t)
	id := e.addOne(t)
	repo := t.TempDir()
	sub := filepath.Join(repo, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	q := func(s string) string { return strings.ReplaceAll(s, `\`, `\\`) }

	rec, out := e.do("PUT", "/api/claude-accounts/mappings", `{"folder":"`+q(repo)+`","accountId":"`+id+`"}`)
	if rec.Code != 200 || len(out["folders"].(map[string]any)) != 1 {
		t.Fatalf("put %d %s", rec.Code, rec.Body)
	}

	// resolve 는 프로필을 맞추지 않는다.
	rec, out = e.do("GET", "/api/claude-accounts/resolve?cwd="+url.QueryEscape(sub), "")
	if rec.Code != 200 || out["source"] != "folder" || out["accountId"] != id || out["configDir"] == nil {
		t.Fatalf("resolve %d %s", rec.Code, rec.Body)
	}
	cfgDir := out["configDir"].(string)
	if _, err := os.Stat(cfgDir); !os.IsNotExist(err) {
		t.Fatalf("resolve prepared profile: %v", err)
	}

	// launch 는 프로필을 맞춘다.
	rec, out = e.do("POST", "/api/claude-accounts/launch", `{"cwd":"`+q(sub)+`"}`)
	if rec.Code != 200 || out["source"] != "folder" || out["configDir"] != cfgDir {
		t.Fatalf("launch %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(cfgDir, ".credentials.json")); err != nil {
		t.Fatalf("profile credentials: %v", err)
	}
	if strings.Contains(rec.Body.String(), "SECRET-A") || strings.Contains(rec.Body.String(), "RT-A") {
		t.Fatal("token leaked")
	}

	// 연결 밖은 none.
	rec, out = e.do("POST", "/api/claude-accounts/launch", `{"cwd":"`+q(t.TempDir())+`"}`)
	if rec.Code != 200 || out["source"] != "none" || out["configDir"] != nil {
		t.Fatalf("none %d %s", rec.Code, rec.Body)
	}

	// 해제.
	rec, out = e.do("PUT", "/api/claude-accounts/mappings", `{"folder":"`+q(repo)+`","accountId":""}`)
	if rec.Code != 200 || len(out["folders"].(map[string]any)) != 0 {
		t.Fatalf("unmap %d %s", rec.Code, rec.Body)
	}
}

// FR-CAC-81a: 살아 있지 않은 도구의 탭 지정은 목록을 알 때 지운다.
func TestClaudeAccountsTabPinPrunedForDeadTool(t *testing.T) {
	e := newCAEnv(t)
	id := e.addOne(t)
	rec, _ := e.do("PUT", "/api/claude-accounts/mappings", `{"toolId":"gone","accountId":"`+id+`"}`)
	if rec.Code != 200 {
		t.Fatalf("pin %d %s", rec.Code, rec.Body)
	}
	rec, out := e.do("GET", "/api/claude-accounts/mappings", "")
	if rec.Code != 200 || len(out["tabs"].(map[string]any)) != 0 {
		t.Fatalf("pruned %d %s", rec.Code, rec.Body)
	}
}

func TestClaudeAccountsMappingErrors(t *testing.T) {
	e := newCAEnv(t)
	id := e.addOne(t)
	for _, c := range []struct {
		method, path, body string
		code               int
	}{
		{"PUT", "/api/claude-accounts/mappings", `{"folder":"rel","accountId":"` + id + `"}`, 400},
		{"PUT", "/api/claude-accounts/mappings", `{"accountId":"` + id + `"}`, 400},
		{"PUT", "/api/claude-accounts/mappings", `{"folder":"/x","toolId":"t","accountId":"` + id + `"}`, 400},
		{"PUT", "/api/claude-accounts/mappings", `{"toolId":"t","accountId":"nope"}`, 404},
		{"POST", "/api/claude-accounts/launch", `{"cwd":"rel"}`, 400},
		{"GET", "/api/claude-accounts/resolve?cwd=rel", "", 400},
	} {
		rec, _ := e.do(c.method, c.path, c.body)
		if rec.Code != c.code {
			t.Errorf("%s %s %s → %d %s, want %d", c.method, c.path, c.body, rec.Code, rec.Body, c.code)
		}
	}
}

// CLAUDE_ACCOUNTS_SRS TC-CAC-30 (API): 보관 목록·삭제 (FR-CAC-34a), 링크 경고 (FR-CAC-88b).
func TestClaudeAccountsUnclaimedAPI(t *testing.T) {
	e := newCAEnv(t)
	dir := filepath.Join(e.srv.ca.svc.Dir, "unclaimed")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "100-aaaaaaaaaaaa.json"), []byte(`{"claudeAiOauth":{"accessToken":"SECRET-U"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	rec, out := e.do("GET", "/api/claude-accounts/unclaimed", "")
	entries, _ := out["entries"].([]any)
	if rec.Code != 200 || len(entries) != 1 || entries[0].(map[string]any)["fingerprint"] != "aaaaaaaaaaaa" {
		t.Fatalf("list %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "SECRET-U") {
		t.Fatal("token leaked")
	}
	rec, _ = e.do("POST", "/api/claude-accounts/unclaimed/remove", `{"name":"../accounts.json"}`)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "claude_account_invalid") {
		t.Fatalf("bad name %d %s", rec.Code, rec.Body)
	}
	rec, out = e.do("POST", "/api/claude-accounts/unclaimed/remove", `{"name":"100-aaaaaaaaaaaa.json"}`)
	if entries, _ := out["entries"].([]any); rec.Code != 200 || len(entries) != 0 {
		t.Fatalf("remove %d %s", rec.Code, rec.Body)
	}
}

func TestClaudeAccountsListCarriesProfileWarnings(t *testing.T) {
	e := newCAEnv(t)
	id := e.addOne(t)
	rec, _ := e.do("GET", "/api/claude-accounts", "")
	if strings.Contains(rec.Body.String(), "profileWarnings") {
		t.Fatalf("no warnings yet: %s", rec.Body)
	}
	e.srv.ca.svc.LinkShared = func(string, string) []string { return []string{"skills"} }
	if _, _, err := e.srv.ca.svc.PrepareProfile(id); err != nil {
		t.Fatal(err)
	}
	rec, out := e.do("GET", "/api/claude-accounts", "")
	acc := out["accounts"].([]any)[0].(map[string]any)
	if w, _ := acc["profileWarnings"].([]any); rec.Code != 200 || len(w) != 1 || w[0] != "skills" {
		t.Fatalf("warnings %d %s", rec.Code, rec.Body)
	}
}
