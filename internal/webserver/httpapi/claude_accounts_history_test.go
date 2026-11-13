package httpapi

import (
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// TC-CAC-25·26: 전환의 by·전략 셋과 기록 API (FR-CAC-31a·110a·120).

func twoCAAccounts(t *testing.T) (*caEnv, string, string) {
	t.Helper()
	e := newCAEnv(t)
	e.login("a@x.com", "org-a", "SECRET-A", "RT-A")
	_, out := e.do("POST", "/api/claude-accounts/add", "{}")
	idA := out["account"].(map[string]any)["id"].(string)
	e.login("b@x.com", "org-b", "SECRET-B", "RT-B")
	_, out = e.do("POST", "/api/claude-accounts/add", "{}")
	idB := out["account"].(map[string]any)["id"].(string)
	return e, idA, idB
}

func TestClaudeAccountsSwitchByAndHistory(t *testing.T) {
	e, idA, idB := twoCAAccounts(t)
	rec, _ := e.do("POST", "/api/claude-accounts/switch", `{"id":"`+idA+`","by":"auto"}`)
	if rec.Code != 400 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeAccountInvalid {
		t.Fatalf("auto from API: %d", rec.Code)
	}
	if rec, _ := e.do("POST", "/api/claude-accounts/switch", `{"id":"`+idA+`","by":"dmctl"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec, _ := e.do("POST", "/api/claude-accounts/switch", `{"strategy":"next"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	rec, out := e.do("GET", "/api/claude-accounts/history", "")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	ents := out["entries"].([]any)
	if len(ents) != 2 {
		t.Fatalf("%s", rec.Body)
	}
	last := ents[0].(map[string]any)
	first := ents[1].(map[string]any)
	if last["trigger"] != "next" || last["by"] != "ui" || last["to"] != idB {
		t.Fatalf("newest first: %v", last)
	}
	if first["trigger"] != "manual" || first["by"] != "dmctl" || first["to"] != idA || first["headroomFrom"] != nil {
		t.Fatalf("%v", first)
	}
	if strings.Contains(rec.Body.String(), "a@x.com") || strings.Contains(rec.Body.String(), "SECRET") {
		t.Fatal("history carries ids only")
	}
	rec, out = e.do("GET", "/api/claude-accounts/history?limit=1", "")
	if rec.Code != 200 || len(out["entries"].([]any)) != 1 {
		t.Fatalf("limit: %s", rec.Body)
	}
	for _, q := range []string{"0", "1001", "x"} {
		if rec, _ := e.do("GET", "/api/claude-accounts/history?limit="+q, ""); rec.Code != 400 {
			t.Fatalf("limit %s: %d", q, rec.Code)
		}
	}
}

func TestClaudeAccountsSmartStrategies(t *testing.T) {
	e, _, _ := twoCAAccounts(t)
	// 사용량 엔드포인트가 닿지 않는다 → 값을 모른다.
	rec, out := e.do("POST", "/api/claude-accounts/switch", `{"strategy":"best"}`)
	if rec.Code != 200 || out["noop"] != true || out["reason"] != "current-unavailable" {
		t.Fatalf("best: %d %s", rec.Code, rec.Body)
	}
	rec, _ = e.do("POST", "/api/claude-accounts/switch", `{"strategy":"next-available"}`)
	if rec.Code != 409 || rec.Header().Get(apierr.CodeHeader) != apierr.CodeClaudeNoCandidate {
		t.Fatalf("next-available: %d %s", rec.Code, rec.Body)
	}
}
