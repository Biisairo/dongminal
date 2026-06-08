package runtimebin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

const whoAmIFakeJSON = `{
  "paneId":"12","shellPid":12345,
  "label":"S1.P1.T1","uuid":"550e8400-e29b-41d4-a716-446655440003","short":"550e8400",
  "sizeCols":80,"sizeRows":24,
  "session":"Main","tab":"Shell",
  "sessionUuid":"550e8400-e29b-41d4-a716-446655440001",
  "regionUuid":"550e8400-e29b-41d4-a716-446655440002",
  "focused":true
}`

// TC-DMC-WAI-1: 정상 응답 → paneline 한 줄, rc=0.
func TestRunDmctlWhoAmI_TextOutput(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/whoami" || r.Method != http.MethodGet {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, whoAmIFakeJSON)
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	want := "▶ label=S1.P1.T1  uuid=550e8400-e29b-41d4-a716-446655440003  short=550e8400  paneId=12  shellPid=12345  size=80x24  session=\"Main\"  tab=\"Shell\"  session_uuid=550e8400-e29b-41d4-a716-446655440001  region_uuid=550e8400-e29b-41d4-a716-446655440002\n"
	if stdout.String() != want {
		t.Errorf("stdout=%q\nwant   =%q", stdout.String(), want)
	}
}

// TC-DMC-WAI-2: --json → 서버 응답을 compact 한 줄로 그대로.
func TestRunDmctlWhoAmI_JSON(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, whoAmIFakeJSON)
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i", "--json"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	out := strings.TrimRight(stdout.String(), "\n")
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("json: %v stdout=%q", err, stdout.String())
	}
	if got["uuid"] != "550e8400-e29b-41d4-a716-446655440003" {
		t.Errorf("uuid=%v", got["uuid"])
	}
}

// TC-DMC-WAI-3: 서버 404 → stderr 에러 메시지 + rc=1.
func TestRunDmctlWhoAmI_NotFound(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		fmt.Fprint(w, `{"error":"clientPID=999 가 어느 pane 에도 속하지 않음"}`)
	})
	defer cleanup()

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i"}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if !strings.Contains(stderr.String(), "clientPID=999") {
		t.Errorf("stderr missing error: %q", stderr.String())
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout should be empty: %q", stdout.String())
	}
}

// TC-DMC-WAI-4: 서버 unreachable → rc=1 + stderr.
func TestRunDmctlWhoAmI_Unreachable(t *testing.T) {
	t.Setenv("DONGMINAL_HOST", "127.0.0.1")
	t.Setenv("DONGMINAL_PORT", "1") // unbound port

	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i"}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if stderr.Len() == 0 {
		t.Error("stderr empty")
	}
}

// TC-DMC-WAI-5: -h → help + rc=0.
func TestRunDmctlWhoAmI_Help(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i", "-h"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(stdout.String(), "who-am-i") {
		t.Errorf("help missing who-am-i: %q", stdout.String())
	}
}

// TC-DMC-WAI-6: 미지 플래그 → rc=2 + stderr.
func TestRunDmctlWhoAmI_UnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"who-am-i", "--bogus"}, &stdout, &stderr)
	if rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
	if !strings.Contains(stderr.String(), "--bogus") {
		t.Errorf("stderr=%q", stderr.String())
	}
}

// 최상위 도움말에 who-am-i 가 포함되는지 (FR-DMC-WAI-3).
func TestRunDmctlHelp_MentionsWhoAmI(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"-h"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(stdout.String(), "who-am-i") {
		t.Errorf("top help should mention who-am-i")
	}
}
