package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-26 (1단계 경로): /api/claude-accounts.

// caNoSecrets 는 키체인이 없는 OS 처럼 군다 — 시험이 실제 키체인을 건드리지 않게 한다.
type caNoSecrets struct{}

func (caNoSecrets) Available() bool { return false }
func (caNoSecrets) Account() string { return "t" }
func (caNoSecrets) Get(string, string) (string, bool, error) {
	return "", false, platform.ErrSecretsUnavailable
}
func (caNoSecrets) Set(string, string, string) error { return platform.ErrSecretsUnavailable }
func (caNoSecrets) Delete(string, string) error      { return nil }

type caEnv struct {
	t    *testing.T
	srv  *Server
	home string
	data string
}

func newCAEnv(t *testing.T) *caEnv {
	t.Helper()
	home := t.TempDir()
	data := t.TempDir()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	srv, err := New(Config{DataDir: data, ClaudeHome: home, ClaudeAPI: "http://127.0.0.1:1", ClaudeSecrets: caNoSecrets{}}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	return &caEnv{t: t, srv: srv, home: home, data: data}
}

func (e *caEnv) login(email, org, access, refresh string) {
	e.t.Helper()
	_ = os.MkdirAll(filepath.Join(e.home, ".claude"), 0o700)
	cred := `{"claudeAiOauth":{"accessToken":"` + access + `","refreshToken":"` + refresh + `","expiresAt":1}}`
	if err := os.WriteFile(filepath.Join(e.home, ".claude", ".credentials.json"), []byte(cred), 0o600); err != nil {
		e.t.Fatal(err)
	}
	cfg := `{"oauthAccount":{"emailAddress":"` + email + `","organizationUuid":"` + org + `","accountUuid":"acc-` + org + `"}}`
	if err := os.WriteFile(filepath.Join(e.home, ".claude.json"), []byte(cfg), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func (e *caEnv) do(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	e.t.Helper()
	rec := httptest.NewRecorder()
	e.srv.Handler().ServeHTTP(rec, apiTestRequest(method, path, strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestClaudeAccountsAddListSwitch(t *testing.T) {
	e := newCAEnv(t)
	rec, out := e.do("GET", "/api/claude-accounts", "")
	if rec.Code != 200 || len(out["accounts"].([]any)) != 0 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	e.login("a@x.com", "org-a", "SECRET-A", "RT-A")
	rec, out = e.do("POST", "/api/claude-accounts/add", "{}")
	if rec.Code != 200 || out["created"] != true {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	idA := out["account"].(map[string]any)["id"].(string)
	e.login("b@x.com", "org-b", "SECRET-B", "RT-B")
	_, out = e.do("POST", "/api/claude-accounts/add", "{}")
	idB := out["account"].(map[string]any)["id"].(string)

	rec, out = e.do("GET", "/api/claude-accounts", "")
	if out["activeId"] != idB || len(out["accounts"].([]any)) != 2 {
		t.Fatalf("%s", rec.Body)
	}
	if strings.Contains(rec.Body.String(), "SECRET") || strings.Contains(rec.Body.String(), "RT-") {
		t.Fatal("list leaks tokens")
	}

	rec, out = e.do("POST", "/api/claude-accounts/switch", `{"id":"`+idA+`"}`)
	if rec.Code != 200 || out["to"] != idA {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	b, _ := os.ReadFile(filepath.Join(e.home, ".claude", ".credentials.json"))
	if !strings.Contains(string(b), "SECRET-A") {
		t.Fatal("live store switched to A")
	}
	rec, out = e.do("POST", "/api/claude-accounts/switch", `{"strategy":"next"}`)
	if rec.Code != 200 || out["to"] != idB {
		t.Fatalf("next: %d %s", rec.Code, rec.Body)
	}
}

func TestClaudeAccountsItemOrderRemove(t *testing.T) {
	e := newCAEnv(t)
	e.login("a@x.com", "org-a", "A", "RA")
	_, out := e.do("POST", "/api/claude-accounts/add", "{}")
	idA := out["account"].(map[string]any)["id"].(string)
	e.login("b@x.com", "org-b", "B", "RB")
	_, out = e.do("POST", "/api/claude-accounts/add", "{}")
	idB := out["account"].(map[string]any)["id"].(string)

	rec, out := e.do("PUT", "/api/claude-accounts/item", `{"id":"`+idA+`","alias":"work","threshold":80}`)
	if rec.Code != 200 || out["alias"] != "work" || out["threshold"] != float64(80) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	rec, _ = e.do("PUT", "/api/claude-accounts/item", `{"id":"`+idA+`","threshold":20}`)
	if rec.Code != 400 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeAccountInvalid {
		t.Fatalf("range: %d %s", rec.Code, rec.Header())
	}
	rec, _ = e.do("PUT", "/api/claude-accounts/item", `{"id":"nope","alias":"x"}`)
	if rec.Code != 404 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeAccountNotFound {
		t.Fatalf("missing: %d", rec.Code)
	}
	rec, _ = e.do("POST", "/api/claude-accounts/order", `{"ids":["`+idB+`","`+idA+`"]}`)
	if rec.Code != 200 {
		t.Fatalf("order %d %s", rec.Code, rec.Body)
	}
	_, out = e.do("GET", "/api/claude-accounts", "")
	if out["accounts"].([]any)[0].(map[string]any)["id"] != idB {
		t.Fatal("reordered")
	}
	rec, _ = e.do("POST", "/api/claude-accounts/remove", `{"id":"`+idA+`"}`)
	if rec.Code != 200 {
		t.Fatalf("remove %d", rec.Code)
	}
	_, out = e.do("GET", "/api/claude-accounts", "")
	if len(out["accounts"].([]any)) != 1 {
		t.Fatal("removed")
	}
}

func TestClaudeAccountsErrors(t *testing.T) {
	e := newCAEnv(t)
	rec, _ := e.do("POST", "/api/claude-accounts/add", "{}")
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeNotLoggedIn {
		t.Fatalf("not logged in: %d %s", rec.Code, rec.Header())
	}
	rec, _ = e.do("POST", "/api/claude-accounts/switch", `{"id":"x"}`)
	if rec.Code != 404 {
		t.Fatalf("unknown: %d", rec.Code)
	}
	rec, _ = e.do("POST", "/api/claude-accounts/switch", `{"strategy":"sideways"}`)
	if rec.Code != 400 {
		t.Fatalf("bad strategy: %d", rec.Code)
	}
	rec, _ = e.do("POST", "/api/claude-accounts/switch", `{"strategy":"next"}`)
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeNoCandidate {
		t.Fatalf("no candidate: %d %s", rec.Code, rec.Header())
	}
}

func TestClaudeAccountsUnavailableWithoutDataDir(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	srv, err := New(Config{}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, apiTestRequest("GET", "/api/claude-accounts", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("%d", rec.Code)
	}
}

func newCAEnvWithAPI(t *testing.T, h http.HandlerFunc) *caEnv {
	t.Helper()
	api := httptest.NewServer(h)
	t.Cleanup(api.Close)
	home, data := t.TempDir(), t.TempDir()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	srv, err := New(Config{DataDir: data, ClaudeHome: home, ClaudeAPI: api.URL, ClaudeSecrets: caNoSecrets{}}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	return &caEnv{t: t, srv: srv, home: home, data: data}
}

func TestClaudeAccountsRefreshAndUsageView(t *testing.T) {
	e := newCAEnvWithAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/oauth/usage" && r.Header.Get("Authorization") == "Bearer AT" {
			_, _ = w.Write([]byte(`{"five_hour":{"utilization":42},"seven_day":{"utilization":7}}`))
			return
		}
		w.WriteHeader(401)
	})
	e.login("a@x.com", "org-a", "AT", "RT")
	cred := `{"claudeAiOauth":{"accessToken":"AT","refreshToken":"RT","expiresAt":99999999999999}}`
	_ = os.WriteFile(filepath.Join(e.home, ".claude", ".credentials.json"), []byte(cred), 0o600)
	_, out := e.do("POST", "/api/claude-accounts/add", "{}")
	id := out["account"].(map[string]any)["id"].(string)

	rec, _ := e.do("POST", "/api/claude-accounts/refresh", `{"id":"`+id+`"}`)
	if rec.Code != 200 {
		t.Fatalf("refresh %d %s", rec.Code, rec.Body)
	}
	rec, out = e.do("GET", "/api/claude-accounts", "")
	acc := out["accounts"].([]any)[0].(map[string]any)
	usage := acc["usage"].(map[string]any)
	if usage["status"] != "ok" || acc["active"] != true {
		t.Fatalf("%s", rec.Body)
	}
	if usage["windows"].(map[string]any)["fiveHour"].(map[string]any)["pct"] != float64(42) {
		t.Fatalf("%s", rec.Body)
	}
	if strings.Contains(rec.Body.String(), "\"AT\"") || strings.Contains(rec.Body.String(), "\"RT\"") {
		t.Fatal("tokens leaked")
	}
	rec, _ = e.do("POST", "/api/claude-accounts/refresh", `{"id":"`+id+`"}`)
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeTooSoon {
		t.Fatalf("too soon: %d %s", rec.Code, rec.Header())
	}
	rec, _ = e.do("POST", "/api/claude-accounts/refresh", `{"id":"nope"}`)
	if rec.Code != 404 {
		t.Fatalf("%d", rec.Code)
	}
}

// TC-CAC-26 (FR-CAC-65): 제한 초기화 상태는 usage.resets 로, 사용은 /reset 로. 결과는 언제나 200 이다.
func TestClaudeAccountsResets(t *testing.T) {
	var claims []string
	e := newCAEnvWithAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer AT" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/api/oauth/usage" && r.URL.RawQuery == "at_wall=1&skip_spend=1":
			_, _ = w.Write([]byte(`{"juniper_tide":{"eligible":true,"available":true}}`))
		case r.URL.Path == "/api/oauth/usage" && r.URL.RawQuery == "cedar_ember=1&skip_spend=1":
			_, _ = w.Write([]byte(`{"cedar_ember":{"eligible":true,"grants":[{"id":"g_1","resets_left":1,"usable_now":true}]}}`))
		case r.URL.Path == "/api/oauth/usage":
			_, _ = w.Write([]byte(`{"five_hour":{"utilization":100},"seven_day":{"utilization":7}}`))
		case r.URL.Path == "/api/organizations/org-a/reset_rate_limits":
			b, _ := io.ReadAll(r.Body)
			claims = append(claims, string(b))
			_, _ = w.Write([]byte(`{"result":"already_used"}`))
		default:
			w.WriteHeader(404)
		}
	})
	e.login("a@x.com", "org-a", "AT", "RT")
	cred := `{"claudeAiOauth":{"accessToken":"AT","refreshToken":"RT","expiresAt":99999999999999}}`
	_ = os.WriteFile(filepath.Join(e.home, ".claude", ".credentials.json"), []byte(cred), 0o600)
	_, out := e.do("POST", "/api/claude-accounts/add", "{}")
	id := out["account"].(map[string]any)["id"].(string)

	rec, _ := e.do("POST", "/api/claude-accounts/refresh", `{"id":"`+id+`","resets":true}`)
	if rec.Code != 200 {
		t.Fatalf("resets refresh %d %s", rec.Code, rec.Body)
	}
	_, out = e.do("GET", "/api/claude-accounts", "")
	usage := out["accounts"].([]any)[0].(map[string]any)["usage"].(map[string]any)
	rs, _ := usage["resets"].(map[string]any)
	if rs == nil || rs["juniperTide"].(map[string]any)["available"] != true || len(rs["cedarEmber"].(map[string]any)["grants"].([]any)) != 1 {
		t.Fatalf("%v", usage)
	}
	if usage["windows"] != nil {
		t.Fatalf("resets:true 는 상태만 조회한다: %v", usage)
	}
	rec, _ = e.do("POST", "/api/claude-accounts/refresh", `{"id":"`+id+`","resets":true}`)
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeTooSoon {
		t.Fatalf("too soon %d", rec.Code)
	}

	rec, out = e.do("POST", "/api/claude-accounts/reset", `{"id":"`+id+`","program":"cedar_ember","grantId":"g_1"}`)
	if rec.Code != 200 || out["result"] != "already_used" || len(claims) != 1 || !strings.Contains(claims[0], `"grant_id":"g_1"`) {
		t.Fatalf("%d %v %v", rec.Code, out, claims)
	}
	for _, bad := range []string{
		`{"id":"` + id + `","program":"nope"}`,
		`{"id":"` + id + `","program":"cedar_ember"}`,
		`{"id":"` + id + `","program":"cedar_ember","grantId":"BAD ID"}`,
	} {
		if rec, _ := e.do("POST", "/api/claude-accounts/reset", bad); rec.Code != 400 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeAccountInvalid {
			t.Errorf("%s → %d", bad, rec.Code)
		}
	}
	if rec, _ := e.do("POST", "/api/claude-accounts/reset", `{"id":"nope","program":"juniper_tide"}`); rec.Code != 404 {
		t.Fatalf("%d", rec.Code)
	}
	if len(claims) != 1 {
		t.Fatalf("틀린 요청은 보내지 않는다: %v", claims)
	}
}
