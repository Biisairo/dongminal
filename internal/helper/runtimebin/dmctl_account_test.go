package runtimebin

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-24 (1단계): dmctl account list · add · switch.

const accountsFakeJSON = `{"activeId":"id-b","accounts":[
 {"id":"id-a","email":"a@x.com","organizationName":"Org A","alias":"work","color":"acct-1","disabled":false,"priority":0},
 {"id":"id-b","email":"b@x.com","organizationName":"Org B","color":"acct-2","disabled":true,"priority":3}]}`

type acctReq struct {
	method, path string
	body         map[string]any
}

func withAccountServer(t *testing.T, routes map[string]string) (*[]acctReq, func()) {
	t.Helper()
	calls := &[]acctReq{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		c := acctReq{method: r.Method, path: r.URL.Path}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &c.body)
		*calls = append(*calls, c)
		resp, ok := routes[r.Method+" "+r.URL.Path]
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(404)
			io.WriteString(w, `{"code":"claude_account_not_found","message":"없음"}`)
			return
		}
		io.WriteString(w, resp)
	})
	return calls, cleanup
}

func TestDmctlAccountListText(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsFakeJSON})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "list")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("%q", out)
	}
	if !strings.HasPrefix(lines[0], "  ") || !strings.Contains(lines[0], "work") || !strings.Contains(lines[0], "a@x.com") || !strings.Contains(lines[0], "id-a") {
		t.Fatalf("line0 %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "* ") || !strings.Contains(lines[1], "disabled") {
		t.Fatalf("active marker and disabled: %q", lines[1])
	}
}

func TestDmctlAccountListJSON(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsFakeJSON})
	defer cleanup()
	rc, out, _ := dmctlRun("account", "list", "--json")
	if rc != 0 {
		t.Fatal(rc)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("%v %q", err, out)
	}
	if v["schemaVersion"] != float64(1) || v["activeId"] != "id-b" {
		t.Fatalf("%v", v)
	}
}

func TestDmctlAccountAdd(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"POST /api/claude-accounts/add": `{"created":true,"account":{"id":"id-c","email":"c@x.com"}}`,
	})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "add")
	if rc != 0 || (*calls)[0].path != "/api/claude-accounts/add" {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	if !strings.Contains(out, "c@x.com") || !strings.Contains(out, "id-c") {
		t.Fatalf("%q", out)
	}
}

func TestDmctlAccountSwitchResolvesRef(t *testing.T) {
	for _, ref := range []string{"id-a", "work", "a@x.com"} {
		calls, cleanup := withAccountServer(t, map[string]string{
			"GET /api/claude-accounts":         accountsFakeJSON,
			"POST /api/claude-accounts/switch": `{"from":"id-b","to":"id-a"}`,
		})
		rc, out, errOut := dmctlRun("account", "switch", ref)
		cleanup()
		if rc != 0 {
			t.Fatalf("%s: rc=%d %s", ref, rc, errOut)
		}
		last := (*calls)[len(*calls)-1]
		if last.path != "/api/claude-accounts/switch" || last.body["id"] != "id-a" {
			t.Fatalf("%s: %+v", ref, last)
		}
		if !strings.Contains(out, "a@x.com") {
			t.Fatalf("%s: %q", ref, out)
		}
	}
}

func TestDmctlAccountSwitchStrategy(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":         accountsFakeJSON,
		"POST /api/claude-accounts/switch": `{"from":"id-b","to":"id-a"}`,
	})
	defer cleanup()
	rc, _, errOut := dmctlRun("account", "switch", "--strategy", "next")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	var sw acctReq
	for _, c := range *calls {
		if c.path == "/api/claude-accounts/switch" {
			sw = c
		}
	}
	if sw.body["strategy"] != "next" {
		t.Fatalf("%+v", sw)
	}
}

func TestDmctlAccountErrors(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsFakeJSON})
	defer cleanup()
	if rc, _, errOut := dmctlRun("account", "switch", "nobody"); rc != 1 || !strings.Contains(errOut, "nobody") {
		t.Fatalf("unknown ref: rc=%d %s", rc, errOut)
	}
	if rc, _, _ := dmctlRun("account", "switch"); rc != 2 {
		t.Fatalf("missing ref rc=%d", rc)
	}
	if rc, _, _ := dmctlRun("account", "bogus"); rc != 2 {
		t.Fatalf("unknown sub rc=%d", rc)
	}
	if rc, out, _ := dmctlRun("account", "--help"); rc != 0 || !strings.Contains(out, "dmctl account") {
		t.Fatalf("help rc=%d", rc)
	}
}
