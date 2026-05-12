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
		name     string
		args     []string
		want     dmctlParsed
		wantErr  bool
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

func TestRunDmctlHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctl([]string{"-h"}, &stdout, &stderr)
	if rc != 0 || !strings.Contains(stdout.String(), "dmctl") {
		t.Errorf("rc=%d out=%s", rc, stdout.String())
	}
}
