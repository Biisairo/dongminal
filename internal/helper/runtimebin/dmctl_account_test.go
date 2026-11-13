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
	method, path, query string
	body                map[string]any
}

func withAccountServer(t *testing.T, routes map[string]string) (*[]acctReq, func()) {
	t.Helper()
	calls := &[]acctReq{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		c := acctReq{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery}
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

// CLAUDE_ACCOUNTS_SRS TC-CAC-24 (2단계): dmctl account usage [<계정>] [--refresh] [--json].

const accountsUsageJSON = `{"activeId":"id-a","accounts":[
 {"id":"id-a","email":"a@x.com","alias":"work","color":"acct-1","active":true,"usage":{
   "status":"ok","fetchedAt":1794000000,"ageSeconds":30,
   "windows":{"fiveHour":{"pct":34.4,"resetsAt":1794007800,"resetsInSec":7800,"level":""},
     "sevenDay":{"pct":72,"resetsAt":1794368000,"resetsInSec":368000,"level":"warn"},
     "scoped":[{"name":"Opus","pct":95,"level":"critical"}],
     "spend":{"used":12.4,"limit":50,"pct":24.8,"currency":"USD"}},
   "pace":{"sevenDay":{"expectedPct":22,"aheadOfPace":true,"willLastToReset":false}},
   "loginExpiresAt":1796000000,"loginExpiringSoon":true}},
 {"id":"id-b","email":"b@x.com","color":"acct-2","active":false,"usage":{
   "status":"relogin_required","stale":true,"ageSeconds":420,
   "windows":{"fiveHour":{"pct":5,"level":""}},"pace":{}}},
 {"id":"id-c","email":"c@x.com","color":"acct-3","active":false,"usage":{"pace":{}}}]}`

func TestAccountSpan(t *testing.T) {
	for _, c := range []struct {
		sec  int64
		want string
	}{{368000, "4일 6시간"}, {7800, "2시간 10분"}, {2100, "35분"}, {0, "곧"}} {
		if got := accountSpan(c.sec); got != c.want {
			t.Errorf("accountSpan(%d)=%q want %q", c.sec, got, c.want)
		}
	}
}

func TestDmctlAccountUsageText(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsUsageJSON})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "usage")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	if len(*calls) != 1 {
		t.Fatalf("--refresh 없이는 조회만 한다: %+v", *calls)
	}
	for _, want := range []string{
		"* work <a@x.com>",
		"5시간", "34%", "2시간 10분 후 초기화",
		"주간", "72% (경고)", "4일 6시간 후 초기화",
		"예상 22%", "속도가 앞섬", "초기화 전 소진",
		"Opus", "95% (위험)",
		"추가 사용량 $12.40 / $50",
		"로그인 만료", "(7일 안)",
		"  b@x.com", "relogin_required", "7분 전",
		"  c@x.com", "아직 조회하지 않음",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("출력에 %q 가 없다:\n%s", want, out)
		}
	}
	if strings.Index(out, "work") > strings.Index(out, "b@x.com") || strings.Index(out, "b@x.com") > strings.Index(out, "c@x.com") {
		t.Fatalf("계정 순서대로다:\n%s", out)
	}
}

func TestDmctlAccountUsageOne(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsUsageJSON})
	defer cleanup()
	rc, out, _ := dmctlRun("account", "usage", "B@X.com")
	if rc != 0 || !strings.Contains(out, "b@x.com") || strings.Contains(out, "work") || strings.Contains(out, "c@x.com") {
		t.Fatalf("rc=%d 한 계정만:\n%s", rc, out)
	}
	rc, _, errOut := dmctlRun("account", "usage", "nobody")
	if rc != 1 || !strings.Contains(errOut, "nobody") {
		t.Fatalf("없는 계정 rc=%d %q", rc, errOut)
	}
	rc, _, _ = dmctlRun("account", "usage", "a", "b")
	if rc != 2 {
		t.Fatalf("계정은 하나까지다 rc=%d", rc)
	}
}

func TestDmctlAccountUsageRefresh(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":          accountsUsageJSON,
		"POST /api/claude-accounts/refresh": `{"ok":true}`,
	})
	defer cleanup()
	rc, out, errOut := dmctlRun("account", "usage", "work", "--refresh")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, errOut)
	}
	got := []string{}
	for _, c := range *calls {
		got = append(got, c.method+" "+c.path)
	}
	want := []string{"GET /api/claude-accounts", "POST /api/claude-accounts/refresh", "GET /api/claude-accounts"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("새로 고친 뒤 다시 받는다: %v", got)
	}
	if (*calls)[1].body["id"] != "id-a" || !strings.Contains(out, "work") {
		t.Fatalf("%+v\n%s", (*calls)[1].body, out)
	}
}

func TestDmctlAccountUsageRefreshAllAndFailure(t *testing.T) {
	n := 0
	stop := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			io.WriteString(w, accountsUsageJSON)
			return
		}
		n++
		if n == 2 {
			w.Header().Set("X-Error-Code", "claude_too_soon")
			w.WriteHeader(409)
			io.WriteString(w, `{"code":"claude_too_soon","message":"1분 뒤에 다시 조회할 수 있습니다"}`)
			return
		}
		io.WriteString(w, `{"ok":true}`)
	})
	defer stop()
	rc, out, errOut := dmctlRun("account", "usage", "--refresh")
	if n != 3 {
		t.Fatalf("모든 계정을 새로 고친다: %d", n)
	}
	if rc != 1 || !strings.Contains(errOut, "1분 뒤에") || !strings.Contains(out, "c@x.com") {
		t.Fatalf("한 계정이 실패해도 나머지와 출력은 계속한다. rc=%d err=%q\n%s", rc, errOut, out)
	}
}

func TestDmctlAccountUsageJSON(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsUsageJSON})
	defer cleanup()
	rc, out, _ := dmctlRun("account", "usage", "work", "--json")
	if rc != 0 {
		t.Fatal(rc)
	}
	var v struct {
		SchemaVersion int              `json:"schemaVersion"`
		Accounts      []map[string]any `json:"accounts"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("%v %q", err, out)
	}
	if v.SchemaVersion != 1 || len(v.Accounts) != 1 || v.Accounts[0]["id"] != "id-a" || v.Accounts[0]["usage"] == nil {
		t.Fatalf("%+v", v)
	}
}

// CLAUDE_ACCOUNTS_SRS TC-CAC-24 (3단계): dmctl account reset 과 usage 의 초기화 줄 (FR-CAC-62·63·65).

const accountsResetsJSON = `{"activeId":"id-a","accounts":[
 {"id":"id-a","email":"a@x.com","alias":"work","active":true,"usage":{"status":"ok",
   "windows":{"fiveHour":{"pct":100,"level":"critical"}},"pace":{},
   "resets":{"fetchedAt":1794000000,
     "juniperTide":{"eligible":true,"available":false,"nextAvailableAt":1794100000},
     "cedarEmber":{"eligible":true,"atLimit":true,"exhausted":[],"grants":[
       {"id":"g_1","label":"Fable reset","resetsTotal":3,"resetsLeft":2,"endsAt":1796000000,"clears":["five_hour","seven_day"],
        "paused":false,"usableNow":true,"useRequiresLimit":true,"blocking":[],"givesBackWeekly":true},
       {"id":"g_0","label":"Used up","resetsTotal":1,"resetsLeft":0,"clears":[],"paused":false,"usableNow":false,"useRequiresLimit":true,"blocking":[],"givesBackWeekly":false}]}}}}]}`

func runAccountStdin(in string, args ...string) (int, string, string) {
	var so, se strings.Builder
	rc := runDmctlAccountStdin(strings.NewReader(in), args, &so, &se)
	return rc, so.String(), se.String()
}

func TestDmctlAccountUsageShowsResets(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsResetsJSON})
	defer cleanup()
	rc, out, _ := dmctlRun("account", "usage")
	if rc != 0 {
		t.Fatal(rc)
	}
	for _, want := range []string{"주간 5시간 초기화", "다음 가능", "초기화 티켓 Fable reset", "2/3회 남음", "쓸 수 있음"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q 가 없다:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Used up") {
		t.Fatalf("남은 횟수가 0 인 티켓은 보이지 않는다:\n%s", out)
	}
}

func TestDmctlAccountResetConfirm(t *testing.T) {
	calls, cleanup := withAccountServer(t, map[string]string{
		"GET /api/claude-accounts":        accountsResetsJSON,
		"POST /api/claude-accounts/reset": `{"result":"reset","resetsLeft":1,"cleared":["five_hour"]}`,
	})
	defer cleanup()
	rc, out, _ := runAccountStdin("n\n", "reset", "work", "--program", "cedar_ember", "--grant", "g_1")
	if rc != 1 || len(*calls) != 1 {
		t.Fatalf("y 가 아니면 보내지 않는다 rc=%d %+v", rc, *calls)
	}
	for _, want := range []string{"Fable reset", "채우는 것", "5시간", "주간", "남은 횟수 2/3", "기한", "주간 한도를 돌려받습니다", "[y/N]"} {
		if !strings.Contains(out, want) {
			t.Errorf("확인 질문에 %q 가 없다:\n%s", want, out)
		}
	}
	rc, out, errOut := runAccountStdin("y\n", "reset", "work", "--program", "cedar_ember", "--grant", "g_1")
	if rc != 0 || !strings.Contains(out, "초기화했습니다") {
		t.Fatalf("rc=%d %s %s", rc, out, errOut)
	}
	last := (*calls)[len(*calls)-1]
	if last.path != "/api/claude-accounts/reset" || last.body["id"] != "id-a" || last.body["program"] != "cedar_ember" || last.body["grantId"] != "g_1" {
		t.Fatalf("%+v", last)
	}
}

func TestDmctlAccountResetYesAndResults(t *testing.T) {
	for _, c := range []struct {
		body string
		rc   int
		want string
	}{
		{`{"result":"already_used"}`, 1, "이미 썼습니다"},
		{`{"result":"unconfirmed"}`, 1, "확인하지 못했습니다"},
		{`{"result":"reset","nextAvailableAt":1794200000}`, 0, "초기화했습니다"},
	} {
		calls, cleanup := withAccountServer(t, map[string]string{
			"GET /api/claude-accounts":        accountsResetsJSON,
			"POST /api/claude-accounts/reset": c.body,
		})
		rc, out, _ := runAccountStdin("", "reset", "work", "--program", "juniper_tide", "--yes")
		cleanup()
		if rc != c.rc || !strings.Contains(out, c.want) || strings.Contains(out, "[y/N]") {
			t.Errorf("%s: rc=%d %q", c.body, rc, out)
		}
		if (*calls)[len(*calls)-1].body["grantId"] != nil {
			t.Errorf("주간 5시간 초기화에는 티켓이 없다: %+v", (*calls)[len(*calls)-1].body)
		}
	}
}

func TestDmctlAccountResetArgs(t *testing.T) {
	_, cleanup := withAccountServer(t, map[string]string{"GET /api/claude-accounts": accountsResetsJSON})
	defer cleanup()
	for _, args := range [][]string{
		{"reset", "work"},
		{"reset", "work", "--program", "nope"},
		{"reset", "work", "--program", "cedar_ember"},
		{"reset", "work", "--program", "juniper_tide", "--grant", "g_1"},
		{"reset", "--program", "juniper_tide"},
	} {
		if rc, _, _ := runAccountStdin("", args...); rc != 2 {
			t.Errorf("%v → rc=%d", args, rc)
		}
	}
	if rc, _, errOut := runAccountStdin("", "reset", "nobody", "--program", "juniper_tide", "--yes"); rc != 1 || !strings.Contains(errOut, "nobody") {
		t.Fatalf("rc=%d %q", rc, errOut)
	}
}
