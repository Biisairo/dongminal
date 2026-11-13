package runtimebin

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-24 (4단계): switch 전략 셋·by, auto, history.

const autoFakeJSON = `{"settings":{"enabled":true,"threshold":90,"weeklyThreshold":null,"intervalSeconds":60,"cooldownSeconds":300,
 "hysteresisPct":10,"strategy":"best","unhealthyTicks":3,"models":null},
 "state":{"status":"on","lastSwitch":{"at":1800000000,"from":"id-b","to":"id-a","trigger":"proactive","leftHeadroom":8},"quarantined":[]}}`

func switchCall(calls []acctReq) acctReq {
	for _, c := range calls {
		if c.path == "/api/claude-accounts/switch" {
			return c
		}
	}
	return acctReq{}
}

func TestDmctlAccountSwitchSendsByDmctl(t *testing.T) {
	for _, args := range [][]string{{"account", "switch", "work"}, {"account", "switch", "--strategy", "next-available"}} {
		calls, cleanup := withAccountServer(t, map[string]string{
			"GET /api/claude-accounts":         accountsFakeJSON,
			"POST /api/claude-accounts/switch": `{"from":"id-b","to":"id-a"}`,
		})
		rc, _, errOut := dmctlRun(args...)
		cleanup()
		if rc != 0 {
			t.Fatalf("%v: rc=%d %s", args, rc, errOut)
		}
		if sw := switchCall(*calls); sw.body["by"] != "dmctl" {
			t.Fatalf("%v: %+v", args, sw)
		}
	}
}

func TestDmctlAccountSwitchBestStays(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":         accountsFakeJSON,
		"POST /api/claude-accounts/switch": `{"from":"id-b","to":"id-b","noop":true,"reason":"current-unavailable"}`,
	})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "switch", "--strategy", "best")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	if !strings.Contains(out, "전환하지 않았습니다") || !strings.Contains(out, "활성 계정의 사용량을 모릅니다") {
		t.Fatalf("%q", out)
	}
}

func TestDmctlAccountSwitchBadStrategy(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsFakeJSON})
	defer cleanup()
	if rc, _, errOut := dmctlRun("account", "switch", "--strategy", "random"); rc != 2 || !strings.Contains(errOut, "next-available") {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
}

func TestDmctlAccountAutoOnOff(t *testing.T) {
	for _, c := range []struct {
		arg  string
		want bool
	}{{"on", true}, {"off", false}} {
		calls, cleanup := withAccountServer(t, map[string]string{"PUT /api/claude-accounts/autoswitch": autoFakeJSON})
		rc, out, errOut := dmctlRun("account", "auto", c.arg)
		cleanup()
		if rc != 0 {
			t.Fatalf("%s: rc=%d %s", c.arg, rc, errOut)
		}
		last := (*calls)[len(*calls)-1]
		if last.method != "PUT" || last.path != "/api/claude-accounts/autoswitch" || last.body["enabled"] != c.want || len(last.body) != 1 {
			t.Fatalf("%s: %+v", c.arg, last)
		}
		if !strings.Contains(out, "자동 전환") {
			t.Fatalf("%q", out)
		}
	}
}

func TestDmctlAccountAutoStatus(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":            accountsFakeJSON,
		"GET /api/claude-accounts/autoswitch": autoFakeJSON,
	})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "auto", "status")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	for _, w := range []string{"켜짐", "90", "best", "proactive", "work"} {
		if !strings.Contains(out, w) {
			t.Fatalf("lacks %q: %q", w, out)
		}
	}
	rc, out, _ = dmctlRun("account", "auto", "status", "--json")
	var v map[string]any
	if rc != 0 || json.Unmarshal([]byte(out), &v) != nil || v["schemaVersion"] != float64(1) || v["settings"] == nil || v["state"] == nil {
		t.Fatalf("rc=%d %q", rc, out)
	}
}

func TestDmctlAccountAutoErrors(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"code":"claude_cswap_running","message":"cswap 자동 전환이 돌고 있습니다"}`))
	})
	defer cleanup()
	if rc, _, errOut := dmctlRun("account", "auto", "on"); rc != 1 || !strings.Contains(errOut, "cswap") {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	if rc, _, _ := dmctlRun("account", "auto", "maybe"); rc != 2 {
		t.Fatalf("bad arg rc=%d", rc)
	}
	if rc, _, _ := dmctlRun("account", "auto"); rc != 2 {
		t.Fatalf("missing arg rc=%d", rc)
	}
}

func TestDmctlAccountHistory(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts": accountsFakeJSON,
		"GET /api/claude-accounts/history": `{"entries":[
		  {"at":1800000000,"from":"id-b","to":"id-a","trigger":"proactive","headroomFrom":8,"headroomTo":70,"by":"auto"},
		  {"at":1799990000,"from":"id-gone","to":"id-b","trigger":"manual","headroomFrom":null,"headroomTo":null,"by":"dmctl"}]}`,
	})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "history", "--limit", "5")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	if q := (*calls)[len(*calls)-1].query; q != "limit=5" {
		t.Fatalf("query %q", q)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "b@x.com → work") || !strings.Contains(lines[0], "proactive") || !strings.Contains(lines[0], "auto") {
		t.Fatalf("%q", out)
	}
	if !strings.Contains(lines[1], "삭제된 계정") || !strings.Contains(lines[1], "dmctl") {
		t.Fatalf("%q", lines[1])
	}
	if rc, _, _ := dmctlRun("account", "history", "--limit", "0"); rc != 2 {
		t.Fatalf("bad limit rc=%d", rc)
	}
}
