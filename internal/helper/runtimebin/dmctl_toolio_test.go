package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// SKILL_INJECTION_SRS 묶음 A 검증 (V-A1~A4).

// captureAPI records the request the subcommand made and replies with resp.
func captureAPI(t *testing.T, resp string, got *map[string]any, gotPath, gotQuery *string) func() {
	t.Helper()
	return withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		if gotPath != nil {
			*gotPath = r.URL.Path
		}
		if gotQuery != nil {
			*gotQuery = r.URL.RawQuery
		}
		if got != nil {
			body, _ := io.ReadAll(r.Body)
			if len(body) > 0 {
				json.Unmarshal(body, got)
			}
		}
		w.Write([]byte(resp))
	})
}

// ── read-screen / read-output (FR-DMA-1/2/3) ─────────

func TestDmctlReadScreen_DefaultsAndStrip(t *testing.T) {
	var path, query string
	defer captureAPI(t, `{"text":"hello","dropped":0}`, nil, &path, &query)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	if rc := runDmctlRead("read-screen", nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc!=0 stderr=%s", stderr.String())
	}
	if path != "/api/tools/output" {
		t.Fatalf("path=%s", path)
	}
	for _, want := range []string{"id=p7", "bytes=16384", "strip=1"} {
		if !strings.Contains(query, want) {
			t.Fatalf("query=%q 에 %q 없음", query, want)
		}
	}
	if stdout.String() != "hello\n" {
		t.Fatalf("stdout=%q want \"hello\\n\"", stdout.String())
	}
}

func TestDmctlReadOutput_DefaultsNoStrip(t *testing.T) {
	var query string
	defer captureAPI(t, `{"text":"raw","dropped":0}`, nil, nil, &query)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	if rc := runDmctlRead("read-output", nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc!=0 stderr=%s", stderr.String())
	}
	if !strings.Contains(query, "bytes=8192") {
		t.Fatalf("query=%q want bytes=8192", query)
	}
	if strings.Contains(query, "strip=1") {
		t.Fatalf("read-output 은 strip 하지 않아야 한다: %q", query)
	}
}

func TestDmctlRead_AtAndBytesFlags(t *testing.T) {
	cases := [][]string{
		{"--at", "uuid-1", "--bytes", "64"},
		{"--at=uuid-1", "--bytes=64"},
		{"-l", "uuid-1", "--bytes", "64"},
	}
	for _, args := range cases {
		var query string
		cleanup := captureAPI(t, `{"text":"x","dropped":0}`, nil, nil, &query)
		var stdout, stderr bytes.Buffer
		rc := runDmctlRead("read-screen", args, &stdout, &stderr)
		cleanup()
		if rc != 0 {
			t.Fatalf("args=%v rc=%d stderr=%s", args, rc, stderr.String())
		}
		if !strings.Contains(query, "id=uuid-1") || !strings.Contains(query, "bytes=64") {
			t.Fatalf("args=%v query=%q", args, query)
		}
	}
}

// FR-DMA-3: dropped 접두와 빈 출력 표시는 MCP 구현과 같아야 한다.
func TestDmctlReadScreen_DroppedPrefix(t *testing.T) {
	defer captureAPI(t, `{"text":"tail","dropped":4096}`, nil, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	runDmctlRead("read-screen", nil, &stdout, &stderr)
	if !strings.HasPrefix(stdout.String(), "dropped_bytes: 4096\n") {
		t.Fatalf("stdout=%q want dropped_bytes 접두", stdout.String())
	}
	if !strings.Contains(stdout.String(), "tail") {
		t.Fatalf("본문 누락: %q", stdout.String())
	}
}

func TestDmctlReadScreen_EmptyOutput(t *testing.T) {
	defer captureAPI(t, `{"text":"","dropped":0}`, nil, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	runDmctlRead("read-screen", nil, &stdout, &stderr)
	if !strings.Contains(stdout.String(), "(출력 없음)") {
		t.Fatalf("stdout=%q want (출력 없음)", stdout.String())
	}
}

// read-output 은 빈 출력에 자리표시자를 넣지 않는다 (raw 바이트 계약).
func TestDmctlReadOutput_EmptyStaysEmpty(t *testing.T) {
	defer captureAPI(t, `{"text":"","dropped":0}`, nil, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	runDmctlRead("read-output", nil, &stdout, &stderr)
	if stdout.String() != "" {
		t.Fatalf("stdout=%q want empty", stdout.String())
	}
}

func TestDmctlRead_NoTargetWithoutEnv(t *testing.T) {
	t.Setenv("DONGMINAL_TOOL_ID", "")
	var stdout, stderr bytes.Buffer
	if rc := runDmctlRead("read-screen", nil, &stdout, &stderr); rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
	if !strings.Contains(stderr.String(), "--at") {
		t.Fatalf("stderr 가 --at 를 안내하지 않는다: %q", stderr.String())
	}
}

func TestDmctlRead_BadFlags(t *testing.T) {
	cases := [][]string{
		{"--bytes", "abc"},
		{"--bytes", "-3"},
		{"--bogus"},
		{"--at"},
	}
	for _, args := range cases {
		var stdout, stderr bytes.Buffer
		if rc := runDmctlRead("read-screen", args, &stdout, &stderr); rc != 2 {
			t.Fatalf("args=%v rc=%d want 2", args, rc)
		}
	}
}

func TestDmctlRead_ServerErrorSurfacesMessage(t *testing.T) {
	defer withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"tool 없음: p9"}`))
	})()

	var stdout, stderr bytes.Buffer
	if rc := runDmctlRead("read-screen", []string{"--at", "x"}, &stdout, &stderr); rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if !strings.Contains(stderr.String(), "tool 없음: p9") {
		t.Fatalf("stderr=%q want 서버 error 메시지", stderr.String())
	}
}

// ── send-input (FR-DMA-4) ────────────────────────────

func TestDmctlSendInput_PositionalText(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t, `{"toolId":"p1","len":7}`, &got, &path, nil)()

	var stdout, stderr bytes.Buffer
	rc := runDmctlSendInput([]string{"--at", "u1", "echo", "hi"},
		strings.NewReader(""), &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if path != "/api/tools/input" {
		t.Fatalf("path=%s", path)
	}
	if got["id"] != "u1" || got["text"] != "echo hi" {
		t.Fatalf("body=%+v", got)
	}
	if got["execute"] != false {
		t.Fatalf("execute=%v want false (기본은 엔터 없음)", got["execute"])
	}
}

func TestDmctlSendInput_ExecuteFlag(t *testing.T) {
	for _, flag := range []string{"--execute", "-x"} {
		var got map[string]any
		cleanup := captureAPI(t, `{"toolId":"p1","len":2}`, &got, nil, nil)
		var stdout, stderr bytes.Buffer
		rc := runDmctlSendInput([]string{"--at", "u1", flag, "ls"},
			strings.NewReader(""), &stdout, &stderr)
		cleanup()
		if rc != 0 {
			t.Fatalf("flag=%s rc=%d stderr=%s", flag, rc, stderr.String())
		}
		if got["execute"] != true {
			t.Fatalf("flag=%s execute=%v want true", flag, got["execute"])
		}
	}
}

// FR-DMA-4: 위치 인자가 없거나 "-" 이면 stdin 이 본문이다.
func TestDmctlSendInput_StdinBody(t *testing.T) {
	for _, args := range [][]string{{"--at", "u1"}, {"--at", "u1", "-"}} {
		var got map[string]any
		cleanup := captureAPI(t, `{"toolId":"p1","len":9}`, &got, nil, nil)
		var stdout, stderr bytes.Buffer
		rc := runDmctlSendInput(args, strings.NewReader("line1\nline2"), &stdout, &stderr)
		cleanup()
		if rc != 0 {
			t.Fatalf("args=%v rc=%d stderr=%s", args, rc, stderr.String())
		}
		if got["text"] != "line1\nline2" {
			t.Fatalf("args=%v text=%q want stdin 본문", args, got["text"])
		}
	}
}

func TestDmctlSendInput_UsesSelfWhenNoAt(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"toolId":"p7","len":1}`, &got, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	if rc := runDmctlSendInput([]string{"x"}, strings.NewReader(""), &stdout, &stderr); rc != 0 {
		t.Fatalf("rc!=0 stderr=%s", stderr.String())
	}
	if got["id"] != "p7" {
		t.Fatalf("id=%v want p7 (DONGMINAL_TOOL_ID)", got["id"])
	}
}

func TestDmctlSendInput_EmptyBodyRejected(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := runDmctlSendInput([]string{"--at", "u1"}, strings.NewReader(""), &stdout, &stderr)
	if rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
	if !strings.Contains(stderr.String(), "본문이 비었다") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestDmctlSendInput_UnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runDmctlSendInput([]string{"--nope", "x"}, strings.NewReader(""), &stdout, &stderr); rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
}

func TestDmctlSendInput_NoTargetWithoutEnv(t *testing.T) {
	t.Setenv("DONGMINAL_TOOL_ID", "")
	var stdout, stderr bytes.Buffer
	if rc := runDmctlSendInput([]string{"x"}, strings.NewReader(""), &stdout, &stderr); rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
}

// ── msg (FR-DMA-5) ──────────────────────────────────

func TestDmctlMsg_SendsToAndFrom(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t,
		`{"toolId":"p1","from":"W1.P1.T2","to":"W1.P1.T1","len":6}`, &got, &path, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "self-uuid")

	var stdout, stderr bytes.Buffer
	rc := runDmctlMsg([]string{"--to", "u1", "리뷰 부탁"}, strings.NewReader(""), &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if path != "/api/tools/message" {
		t.Fatalf("path=%s", path)
	}
	if got["to"] != "u1" || got["message"] != "리뷰 부탁" {
		t.Fatalf("body=%+v", got)
	}
	// FR-DMA-5: --from 생략 시 자기 도구를 쓴다 — who-am-i 를 먼저 부를 필요가 없다.
	if got["from"] != "self-uuid" {
		t.Fatalf("from=%v want self-uuid", got["from"])
	}
	if !strings.Contains(stdout.String(), "W1.P1.T2") || !strings.Contains(stdout.String(), "W1.P1.T1") {
		t.Fatalf("stdout 이 정규화된 라벨을 보고하지 않는다: %q", stdout.String())
	}
}

func TestDmctlMsg_ExplicitFromWins(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"toolId":"p1","from":"a","to":"b","len":1}`, &got, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "self-uuid")

	var stdout, stderr bytes.Buffer
	runDmctlMsg([]string{"--to=u1", "--from=other-uuid", "x"}, strings.NewReader(""), &stdout, &stderr)
	if got["from"] != "other-uuid" {
		t.Fatalf("from=%v want other-uuid", got["from"])
	}
}

func TestDmctlMsg_StdinBody(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"toolId":"p1","from":"a","to":"b","len":11}`, &got, nil, nil)()

	var stdout, stderr bytes.Buffer
	rc := runDmctlMsg([]string{"--to", "u1"}, strings.NewReader("여러 줄\n지시문"), &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["message"] != "여러 줄\n지시문" {
		t.Fatalf("message=%q", got["message"])
	}
}

func TestDmctlMsg_RequiresTo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runDmctlMsg([]string{"본문"}, strings.NewReader(""), &stdout, &stderr); rc != 2 {
		t.Fatalf("rc=%d want 2", rc)
	}
	if !strings.Contains(stderr.String(), "--to") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestDmctlMsg_ServerErrorSurfacesMessage(t *testing.T) {
	defer withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"tool 없음: p9"}`))
	})()

	var stdout, stderr bytes.Buffer
	rc := runDmctlMsg([]string{"--to", "u1", "x"}, strings.NewReader(""), &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if !strings.Contains(stderr.String(), "tool 없음: p9") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

// ── open-editor (FR-DMA-6) ──────────────────────────

func TestDmctlOpenEditor_SendsAction(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"ok":true}`, &got, nil, nil)()

	var stdout, stderr bytes.Buffer
	rc := runDmctlOpenEditor([]string{"--at", "u1", "--name", "설계", "/tmp/a.md"}, &stdout, &stderr)
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "openEditorTab" {
		t.Fatalf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["location"] != "u1" || args["filePath"] != "/tmp/a.md" || args["name"] != "설계" {
		t.Fatalf("args=%+v", args)
	}
}

func TestDmctlOpenEditor_DefaultsNameToBasename(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"ok":true}`, &got, nil, nil)()

	var stdout, stderr bytes.Buffer
	if rc := runDmctlOpenEditor([]string{"--at", "u1", "/tmp/dir/spec.md"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	args := got["args"].(map[string]any)
	if args["name"] != "spec.md" {
		t.Fatalf("name=%v want spec.md", args["name"])
	}
}

func TestDmctlOpenEditor_RequiresAtAndPath(t *testing.T) {
	cases := [][]string{
		{"/tmp/a.md"},
		{"--at", "u1"},
	}
	for _, args := range cases {
		var stdout, stderr bytes.Buffer
		if rc := runDmctlOpenEditor(args, &stdout, &stderr); rc != 2 {
			t.Fatalf("args=%v rc=%d want 2", args, rc)
		}
	}
}

// ── agent-context (FR-DMA-7, FR-CTX-1) ──────────────

func TestDmctlAgentContext_EmitsSessionStartJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runDmctlAgentContext(nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d want 0", rc)
	}
	var payload struct {
		Hook struct {
			Event   string `json:"hookEventName"`
			Context string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatalf("출력이 유효한 JSON 이 아니다: %v\n%s", err, stdout.String())
	}
	if payload.Hook.Event != "SessionStart" {
		t.Fatalf("hookEventName=%q want SessionStart", payload.Hook.Event)
	}
	// FR-CTX-1: 규약의 핵심 4가지가 본문에 있어야 한다.
	for _, want := range []string{
		"DONGMINAL-AGENT-MSG",
		"dmctl who-am-i",
		"dmctl msg --to",
		"/dongminal:team",
	} {
		if !strings.Contains(payload.Hook.Context, want) {
			t.Errorf("컨텍스트에 %q 없음", want)
		}
	}
}

// FR-DMA-7: 훅으로 돌기 때문에 서버가 없어도 세션 시작을 막지 않는다.
func TestDmctlAgentContext_AlwaysZeroWithoutServer(t *testing.T) {
	t.Setenv("DONGMINAL_PORT", "1")
	var stdout, stderr bytes.Buffer
	if rc := runDmctlAgentContext(nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d want 0", rc)
	}
}

// ── 디스패치·도움말 (FR-DMA-9) ───────────────────────

func TestDmctlHelp_ListsNewSubcommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runDmctl(nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	for _, want := range []string{
		"read-screen", "read-output", "send-input", "msg", "open-editor", "agent-context",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("최상위 도움말에 %q 없음", want)
		}
	}
}

func TestDmctlSubcommandHelp(t *testing.T) {
	cases := []struct {
		name string
		run  func(args []string, stdout, stderr io.Writer) int
	}{
		{"read-screen", func(a []string, o, e io.Writer) int { return runDmctlRead("read-screen", a, o, e) }},
		{"send-input", func(a []string, o, e io.Writer) int {
			return runDmctlSendInput(a, strings.NewReader(""), o, e)
		}},
		{"msg", func(a []string, o, e io.Writer) int { return runDmctlMsg(a, strings.NewReader(""), o, e) }},
		{"open-editor", runDmctlOpenEditor},
		{"agent-context", runDmctlAgentContext},
	}
	for _, c := range cases {
		var stdout, stderr bytes.Buffer
		if rc := c.run([]string{"--help"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s --help rc=%d", c.name, rc)
		}
		if stdout.Len() == 0 {
			t.Fatalf("%s --help 가 아무것도 출력하지 않는다", c.name)
		}
	}
}

// runDmctl 이 신규 서브커맨드를 실제로 라우팅하는지 (unknown command 로 떨어지지 않는지).
func TestDmctlDispatch_RoutesNewSubcommands(t *testing.T) {
	defer captureAPI(t, `{"text":"x","dropped":0}`, nil, nil, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "p7")

	var stdout, stderr bytes.Buffer
	if rc := runDmctl([]string{"read-screen"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("read-screen 이 라우팅되지 않았다: %q", stderr.String())
	}
}
