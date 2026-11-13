package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/claudeacct"
)

// TC-CAC-29: 계정을 실은 statusLine 보고의 저장·판단 연결·목록 응답 (FR-CAC-78·93).

func slBody(account string, pct float64) string {
	acc := ""
	if account != "" {
		acc = fmt.Sprintf(`,"account":{"email":%q,"organizationUuid":"org-%s"}`, account, account[:1])
	}
	return fmt.Sprintf(`{"toolId":"p1","usage":{"rateLimits":{"five_hour":{"usedPct":%g,"resetsAt":4000000000}}}%s}`, pct, acc)
}

func TestClaudeStatusLinePerAccount(t *testing.T) {
	e, idA, _ := twoCAAccounts(t)
	if code := postUsage(t, e.srv, slBody("a@x.com", 42)); code != http.StatusOK {
		t.Fatal(code)
	}
	if code := postUsage(t, e.srv, slBody("zed@y.com", 7)); code != http.StatusOK {
		t.Fatal(code)
	}
	rec, out := e.do("GET", "/api/claude-accounts", "")
	var a map[string]any
	for _, x := range out["accounts"].([]any) {
		if m := x.(map[string]any); m["id"] == idA {
			a = m
		}
	}
	sl, ok := a["statusLine"].(map[string]any)
	if !ok {
		t.Fatalf("account statusLine: %s", rec.Body)
	}
	five := sl["windows"].(map[string]any)["fiveHour"].(map[string]any)
	if five["pct"] != float64(42) || sl["observedAt"] == nil {
		t.Fatalf("%v", sl)
	}
	others := out["otherStatusLines"].([]any)
	if len(others) != 1 || others[0].(map[string]any)["name"] != "ze***@" {
		t.Fatalf("unregistered: %v", others)
	}
	if strings.Contains(rec.Body.String(), "zed@y.com") {
		t.Fatal("unregistered email is masked")
	}
	// 계정을 실은 보고는 에이전트 단위 값(기존 한 줄)에 들어가지 않는다.
	if got := e.srv.rateLimits.view(time.Now()); len(got) != 0 {
		t.Fatalf("agent-level: %+v", got)
	}
	if code := postUsage(t, e.srv, slBody("", 9)); code != http.StatusOK {
		t.Fatal(code)
	}
	if got := e.srv.rateLimits.view(time.Now()); len(got) != 1 {
		t.Fatalf("no-account report keeps the old path: %+v", got)
	}
	// 판단 연결: 엔진이 그 계정의 statusLine 값을 본다.
	u, at, ok := e.srv.ca.eng.StatusLine(claudeacct.Account{Email: "a@x.com", OrgUUID: "org-a"})
	if !ok || u.FiveHour == nil || u.FiveHour.Pct != 42 || u.FiveHour.ResetsAt != 4000000000 || at == 0 {
		t.Fatalf("%+v %v %v", u, at, ok)
	}
}
