package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParseDmctlFlags(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    dmctlParsed
		wantErr bool
	}{
		{"empty", nil, dmctlParsed{}, false},
		{"location_long", []string{"--at", "1.2.3"}, dmctlParsed{location: "1.2.3"}, false},
		{"location_short_eq", []string{"-l=2.1"}, dmctlParsed{location: "2.1"}, false},
		{"location_long_eq", []string{"--at=S4.P1.T1"}, dmctlParsed{location: "S4.P1.T1"}, false},
		{"keep_focus", []string{"-n"}, dmctlParsed{keepFocus: true}, false},
		{"positional", []string{"3"}, dmctlParsed{positional: "3"}, false},
		{"mixed", []string{"--no-focus", "--at", "1.1.1", "5"}, dmctlParsed{location: "1.1.1", keepFocus: true, positional: "5"}, false},
		{"unknown_flag", []string{"--bogus"}, dmctlParsed{}, true},
		{"missing_value", []string{"--at"}, dmctlParsed{}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDmctlFlags(tc.args)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if got.location != tc.want.location || got.keepFocus != tc.want.keepFocus || got.positional != tc.want.positional {
				t.Errorf("got=%+v want=%+v", got, tc.want)
			}
		})
	}
}

func TestBuildArgs(t *testing.T) {
	count := 4
	p := dmctlParsed{location: "1.1.1", count: &count, keepFocus: true}
	args := p.buildArgs()
	if args["location"] != "1.1.1" || args["count"] != 4 || args["keepFocus"] != true {
		t.Errorf("unexpected args: %+v", args)
	}
	empty := dmctlParsed{}.buildArgs()
	if len(empty) != 0 {
		t.Errorf("empty buildArgs should be empty: %+v", empty)
	}
}

func withDmctlServer(t *testing.T, handler http.HandlerFunc) (cleanup func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	u, _ := url.Parse(srv.URL)
	t.Setenv("DONGMINAL_HOST", u.Hostname())
	t.Setenv("DONGMINAL_PORT", u.Port())
	return srv.Close
}

func TestRunDmctlSplitH(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"split-h", "3"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "splitH" {
		t.Errorf("action=%v want splitH", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["count"].(float64) != 3 {
		t.Errorf("count=%v want 3", args["count"])
	}
}

func TestRunDmctlSplitInvalidCount(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"split-h", "1"}, &stdout, &stderr)
	if rc != 2 {
		t.Errorf("rc=%d want 2", rc)
	}
	if !strings.Contains(stderr.String(), ">= 2") {
		t.Errorf("stderr=%s", stderr.String())
	}
}

func TestRunDmctlFocusRequiresLocation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"focus"}, &stdout, &stderr)
	if rc != 2 {
		t.Errorf("rc=%d want 2", rc)
	}
}

func TestRunDmctlSendRaw(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"send", "customAction", `{"foo":"bar"}`}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "customAction" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["foo"] != "bar" {
		t.Errorf("args=%v", args)
	}
}

func TestRunDmctlUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"bogus"}, &stdout, &stderr)
	if rc != 2 {
		t.Errorf("rc=%d want 2", rc)
	}
}

// UUID_IDENTITY_SRS: dmctl 이 uuid 를 location 인자로 받아 그대로 서버로
// POST 한다는 회귀. (서버 측의 좌표 변환은 commands_uuid_test 에서 검증)
func TestRunDmctlFocusAcceptsUUID(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"focus", uuid}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "focus" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["location"] != uuid {
		t.Errorf("location=%v want %q (dmctl should pass uuid through)", args["location"], uuid)
	}
}

func TestRunDmctlAtFlagAcceptsUUID(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"close-tab", "--at", uuid}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	args := got["args"].(map[string]any)
	if args["location"] != uuid {
		t.Errorf("location=%v want %q (--at should accept uuid)", args["location"], uuid)
	}
}

// TC-RST-8: dmctl new-session --name wf -n → args 에 name + keepFocus.
func TestRunDmctlNewSessionNameKeepFocus(t *testing.T) {
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"new-session", "--name", "wf-test", "-n"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "newSession" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["name"] != "wf-test" || args["keepFocus"] != true {
		t.Errorf("args=%v", args)
	}
}

// TC-RST-9: dmctl new-tab --name worker --at <uuid> -n → name/location/keepFocus 모두.
func TestRunDmctlNewTabNameAtKeepFocus(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"new-tab", "--name", "worker", "--at", uuid, "-n"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	args := got["args"].(map[string]any)
	if args["name"] != "worker" || args["location"] != uuid || args["keepFocus"] != true {
		t.Errorf("args=%v", args)
	}
}

// TC-RNS-6: dmctl rename-tab --at <uuid> <name> (positional name).
func TestRunDmctlRenameTab(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"rename-tab", "--at", uuid, "writer"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "renameTab" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["location"] != uuid || args["name"] != "writer" {
		t.Errorf("args=%v", args)
	}
}

// TC-RNS-7: rename-session 은 --name 플래그 경로도 동등.
func TestRunDmctlRenameSessionNameFlag(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	var got map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"rename-session", "--at", uuid, "--name", "poem run 2"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "renameSession" {
		t.Errorf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["name"] != "poem run 2" || args["location"] != uuid {
		t.Errorf("args=%v", args)
	}
}

// TC-RNS-8: 인자 누락 → usage + rc=2.
func TestRunDmctlRenameTabMissingArgs(t *testing.T) {
	for _, args := range [][]string{
		{"rename-tab", "writer"},     // --at 누락
		{"rename-tab", "--at", "u1"}, // name 누락
		{"rename-session"},           // 둘 다 누락
	} {
		var stdout, stderr bytes.Buffer
		rc := runDmctl(args, &stdout, &stderr)
		if rc != 2 {
			t.Errorf("args=%v rc=%d want 2 (stderr=%s)", args, rc, stderr.String())
		}
		if stderr.Len() == 0 {
			t.Errorf("args=%v stderr empty", args)
		}
	}
}

// --name=값 형식도 지원.
func TestParseDmctlFlags_NameEq(t *testing.T) {
	got, err := parseDmctlFlags([]string{"--name=wf"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if got.name != "wf" {
		t.Errorf("name=%q", got.name)
	}
}

func TestRunDmctlHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"-h"}, &stdout, &stderr)
	if rc != 0 || !strings.Contains(stdout.String(), "dmctl") {
		t.Errorf("rc=%d out=%s", rc, stdout.String())
	}
}

// TC-DMC-10: -h 출력에 list-panes 안내 포함.
func TestRunDmctlHelp_MentionsListPanes(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"-h"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(stdout.String(), "list-panes") {
		t.Errorf("help should mention list-panes, got:\n%s", stdout.String())
	}
}

// fake /api/state payload — 두 세션, 각각 단일 region·tab. 세션 B 가 active.
const listPanesFakeState = `{
  "panes":[
    {"id":"10","name":"Shell A","pid":11111},
    {"id":"20","name":"Shell B","pid":22222}
  ],
  "workspace":{
    "activeSession":"sb",
    "sessions":[
      {"id":"sa","name":"Main","focusedRegion":"ra","layout":{"type":"region","id":"ra","activeTab":"taba","tabs":[{"id":"550e8400-e29b-41d4-a716-446655440aaa","name":"shell-a","paneId":"10"}]}},
      {"id":"sb","name":"Work","focusedRegion":"rb","layout":{"type":"region","id":"rb","activeTab":"550e8400-e29b-41d4-a716-446655440bbb","tabs":[{"id":"550e8400-e29b-41d4-a716-446655440bbb","name":"shell-b","paneId":"20"}]}}
    ]
  }
}`

// TC-DMC-1: list-panes 가 각 tab 의 label/uuid/short/paneId/shellPid 를 줄당 1개로
// 사람 가독성 텍스트로 출력. 포커스된 pane 에만 ▶.
func TestRunDmctlListPanes_TextOutput(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/state" || r.Method != http.MethodGet {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	out := stdout.String()

	// 첫 pane (포커스 없음): 두 칸 공백 prefix. size 미노출(panes[]에 sizeCols/Rows 없음) → 컬럼 생략.
	if !strings.Contains(out, "  label=S1.P1.T1  uuid=550e8400-e29b-41d4-a716-446655440aaa  short=550e8400  paneId=10  shellPid=11111  session=\"Main\"  tab=\"shell-a\"  session_uuid=sa  region_uuid=ra") {
		t.Errorf("missing/wrong non-focus line:\n%s", out)
	}
	// 두 번째 pane (포커스): ▶ prefix.
	if !strings.Contains(out, "▶ label=S2.P1.T1  uuid=550e8400-e29b-41d4-a716-446655440bbb  short=550e8400  paneId=20  shellPid=22222  session=\"Work\"  tab=\"shell-b\"  session_uuid=sb  region_uuid=rb") {
		t.Errorf("missing/wrong focus line:\n%s", out)
	}
}

// TC-DMC-2: --json 시 JSON 배열 반환. 각 원소가 uuid/label/paneId 등 키 포함.
func TestRunDmctlListPanes_JSON(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes", "--json"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	var arr []map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &arr); err != nil {
		t.Fatalf("json: %v out=%s", err, stdout.String())
	}
	if len(arr) != 2 {
		t.Fatalf("len=%d want 2", len(arr))
	}
	if arr[0]["label"] != "S1.P1.T1" || arr[0]["uuid"] != "550e8400-e29b-41d4-a716-446655440aaa" {
		t.Errorf("arr[0]=%+v", arr[0])
	}
	if arr[0]["focused"] != false || arr[1]["focused"] != true {
		t.Errorf("focused flags wrong: %+v %+v", arr[0], arr[1])
	}
	if arr[1]["paneId"] != "20" {
		t.Errorf("arr[1].paneId=%v", arr[1]["paneId"])
	}
	if shellPid, _ := arr[1]["shellPid"].(float64); shellPid != 22222 {
		t.Errorf("arr[1].shellPid=%v", arr[1]["shellPid"])
	}
}

// TC-DMC-3: 빈 워크스페이스 → "(no panes)" 류 + rc=0.
func TestRunDmctlListPanes_Empty(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"panes":[],"workspace":null}`))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "(no panes)") {
		t.Errorf("expected empty marker, got:\n%s", stdout.String())
	}

	// --json 빈 워크스페이스는 빈 배열.
	stdout.Reset()
	stderr.Reset()
	rc = runDmctl([]string{"list-panes", "--json"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("--json rc=%d", rc)
	}
	if strings.TrimSpace(stdout.String()) != "[]" {
		t.Errorf("expected [], got %q", stdout.String())
	}
}

// TC-LPF-1/2: --session 필터 — 부분 일치 + 대소문자 무시.
func TestRunDmctlListPanes_SessionFilter(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes", "--session", "WoRk"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, `session="Work"`) {
		t.Errorf("expected Work row, got:\n%s", out)
	}
	if strings.Contains(out, `session="Main"`) {
		t.Errorf("Main row should be filtered out:\n%s", out)
	}
}

// TC-LPF-3: 매칭 0건 → stderr "(no match)" + rc=1.
func TestRunDmctlListPanes_FilterNoMatch(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes", "--session", "nomatch"}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if !strings.Contains(stderr.String(), "no match") {
		t.Errorf("stderr=%q", stderr.String())
	}
}

// TC-LPF-4: --json + 0건 → stdout "[]" + rc=1.
func TestRunDmctlListPanes_FilterNoMatchJSON(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes", "--session", "nomatch", "--json"}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if strings.TrimSpace(stdout.String()) != "[]" {
		t.Errorf("stdout=%q", stdout.String())
	}
}

// TC-LPF-5: --session + --tab AND 매칭.
func TestRunDmctlListPanes_SessionAndTabFilter(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(listPanesFakeState))
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	// session=Work + tab=shell-a → 0건 (Work 의 tab 은 shell-b)
	rc := runDmctl([]string{"list-panes", "--session", "Work", "--tab", "shell-a"}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("AND mismatch rc=%d want 1", rc)
	}
	stdout.Reset()
	stderr.Reset()
	rc = runDmctl([]string{"list-panes", "--session", "Work", "--tab", "shell-b"}, &stdout, &stderr)
	if rc != 0 || !strings.Contains(stdout.String(), `tab="shell-b"`) {
		t.Errorf("AND match rc=%d out=%q", rc, stdout.String())
	}
}

// TC-DMC-4: /api/state 5xx → stderr 명확한 오류 + rc=1.
func TestRunDmctlListPanes_ServerError(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", 500)
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"list-panes"}, &stdout, &stderr)
	if rc != 1 {
		t.Errorf("rc=%d want 1", rc)
	}
	if stderr.Len() == 0 {
		t.Errorf("stderr empty")
	}
}
