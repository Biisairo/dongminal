package runtimebin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func setTestServer(t *testing.T, srv *httptest.Server) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	t.Setenv("DONGMINAL_HOST", u.Hostname())
	t.Setenv("DONGMINAL_PORT", u.Port())
}

// FR-BG-2/6/7: detach 는 현재 도구를 백그라운드로 보내고 탭을 닫는다.
// 명령 이름으로 bg 를 쓰지 않는다 — zsh/bash 작업 제어 빌트인과 충돌한다.

func TestDetach_SendsCurrentToolToBackground(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := new(bytes.Buffer)
		b.ReadFrom(r.Body)
		gotPath, gotBody = r.URL.Path, b.String()
		w.Write([]byte(`{"delivered":1}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)
	t.Setenv("DONGMINAL_TOOL_ID", "42")

	var out, errOut bytes.Buffer
	if rc := runDetach(nil, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if gotPath != "/api/commands" {
		t.Errorf("경로 = %s, want /api/commands", gotPath)
	}
	if !strings.Contains(gotBody, "detachTab") {
		t.Errorf("바디에 detachTab 없음: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"42"`) {
		t.Errorf("바디에 도구 id 없음: %s", gotBody)
	}
}

func TestDetach_RequiresToolID(t *testing.T) {
	t.Setenv("DONGMINAL_TOOL_ID", "")
	var out, errOut bytes.Buffer
	if rc := runDetach(nil, &out, &errOut); rc == 0 {
		t.Error("DONGMINAL_TOOL_ID 없이 성공했음")
	}
	if !strings.Contains(errOut.String(), "DONGMINAL_TOOL_ID") {
		t.Errorf("안내 메시지 없음: %s", errOut.String())
	}
}

func TestDetach_ListPrintsBackgroundTools(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"background": []map[string]any{
			{"toolId": "7", "name": "Shell #7", "cwd": "/repo/web", "since": 1700000000000000000},
			{"toolId": "9", "name": "Shell #9", "cwd": "/repo/api", "since": 1700000001000000000},
		}})
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--list"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	got := out.String()
	for _, want := range []string{"toolId=7", "/repo/web", "toolId=9", "/repo/api"} {
		if !strings.Contains(got, want) {
			t.Errorf("출력에 %q 없음:\n%s", want, got)
		}
	}
}

func TestDetach_ListEmptyIsZeroExit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"background": []any{}})
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--list"}, &out, &errOut); rc != 0 {
		t.Errorf("빈 목록 rc=%d, want 0", rc)
	}
	if !strings.Contains(out.String(), "없") {
		t.Errorf("빈 목록 안내 없음: %s", out.String())
	}
}

func TestDetach_RestoreSendsCommand(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := new(bytes.Buffer)
		b.ReadFrom(r.Body)
		gotBody = b.String()
		w.Write([]byte(`{"delivered":1}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--restore", "7"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if !strings.Contains(gotBody, "restoreTool") || !strings.Contains(gotBody, `"7"`) {
		t.Errorf("복귀 명령 바디: %s", gotBody)
	}
}

func TestDetach_RestoreRequiresID(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--restore"}, &out, &errOut); rc == 0 {
		t.Error("--restore 인자 없이 성공했음")
	}
}

func TestDetach_UnknownFlag(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--nope"}, &out, &errOut); rc != 2 {
		t.Errorf("rc=%d, want 2", rc)
	}
}
