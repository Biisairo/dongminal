package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/toolaccess"
)

// 이 파일은 MCP 폐지(SKILL_INJECTION_SRS 묶음 F)로 사라진
// internal/mcptool/tools 의 행위 계약을 서버 엔드포인트 쪽으로 이관한 것이다
// (FR-RM-6). 원본 테스트는 send_input / read_screen / read_output /
// send_agent_message 에 대한 것이었다.

type fakeToolIO struct {
	has      map[string]bool
	snap     map[string][]byte
	dropped  int64
	pasteErr error
	pastes   []fakePaste
}

type fakePaste struct {
	ToolID string
	Text   string
	Submit bool
}

func newFakeToolIO() *fakeToolIO {
	return &fakeToolIO{has: map[string]bool{}, snap: map[string][]byte{}}
}

func (f *fakeToolIO) List() []toolaccess.ToolInfo { return nil }
func (f *fakeToolIO) Has(id string) bool          { return f.has[id] }
func (f *fakeToolIO) Snapshot(id string) ([]byte, int64, bool) {
	d, ok := f.snap[id]
	return d, f.dropped, ok
}
func (f *fakeToolIO) SendPaste(id string, text []byte, submit bool) error {
	f.pastes = append(f.pastes, fakePaste{ToolID: id, Text: string(text), Submit: submit})
	return f.pasteErr
}
func (f *fakeToolIO) Size(string) string { return "80x24" }

type fakeWorkIndex struct {
	resolve map[string]string
	labels  map[string]string
	coords  map[string]string
	entries []toolaccess.WorkspaceEntry
}

func (f *fakeWorkIndex) Resolve(id string) (string, error) {
	if v, ok := f.resolve[id]; ok {
		return v, nil
	}
	return "", errors.New("not found: " + id)
}
func (f *fakeWorkIndex) Labels() map[string]string { return f.labels }
func (f *fakeWorkIndex) Entries() []toolaccess.WorkspaceEntry {
	return f.entries
}
func (f *fakeWorkIndex) CoordinateOf(id string) (string, error) {
	if v, ok := f.coords[id]; ok {
		return v, nil
	}
	return id, nil
}
func (f *fakeWorkIndex) IsKnownTabID(id string) bool {
	_, ok := f.coords[id]
	return ok
}

// toolIOServer wires a Server with the two toolaccess fakes and returns a live
// httptest endpoint plus the fakes for assertion.
func toolIOServer(t *testing.T) (*httptest.Server, *fakeToolIO, *fakeWorkIndex) {
	t.Helper()
	io := newFakeToolIO()
	io.has["p1"] = true
	wi := &fakeWorkIndex{
		resolve: map[string]string{
			"p1":                                   "p1",
			"p2":                                   "p2",
			"W1.P1.T1":                             "p1",
			"aaaaaaaa-1111-2222-3333-444444444444": "p1",
			"bbbbbbbb-1111-2222-3333-444444444444": "p2",
			"cccccccc-1111-2222-3333-444444444444": "p1",
			"dead-tool":                            "p9",
		},
		labels: map[string]string{"p1": "W1.P1.T1", "p2": "W1.P1.T2"},
		coords: map[string]string{},
	}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{ToolIO: io, WorkIndex: wi})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, io, wi
}

func postJSON(t *testing.T, url string, body any) (*http.Response, map[string]any) {
	t.Helper()
	blob, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func getJSON(t *testing.T, url string) (*http.Response, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// ── /api/tools/output (FR-API-1) ─────────────────────

func TestToolOutput_StripsANSI(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("\x1b[31mred\x1b[0m done")

	resp, body := getJSON(t, ts.URL+"/api/tools/output?id=p1&strip=1")
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if got := body["text"]; got != "red done" {
		t.Fatalf("text=%q want %q", got, "red done")
	}
}

func TestToolOutput_KeepsANSIWithoutStrip(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	raw := "\x1b[31mred\x1b[0m"
	io.snap["p1"] = []byte(raw)

	_, body := getJSON(t, ts.URL+"/api/tools/output?id=p1")
	if got := body["text"]; got != raw {
		t.Fatalf("text=%q want raw %q", got, raw)
	}
}

func TestToolOutput_BytesKeepsTail(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("abcdefghij")

	_, body := getJSON(t, ts.URL+"/api/tools/output?id=p1&bytes=4")
	if got := body["text"]; got != "ghij" {
		t.Fatalf("text=%q want tail %q", got, "ghij")
	}
}

// FR-API-1: bytes<=0 또는 미지정이면 잘라내지 않는다. 기본값 판단은 dmctl 몫이다.
func TestToolOutput_NoBytesReturnsWhole(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("abcdefghij")

	for _, q := range []string{"", "&bytes=0", "&bytes=-5"} {
		_, body := getJSON(t, ts.URL+"/api/tools/output?id=p1"+q)
		if got := body["text"]; got != "abcdefghij" {
			t.Fatalf("q=%q text=%q want whole buffer", q, got)
		}
	}
}

func TestToolOutput_ReportsDropped(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("tail")
	io.dropped = 4096

	_, body := getJSON(t, ts.URL+"/api/tools/output?id=p1")
	if got, ok := body["dropped"].(float64); !ok || int(got) != 4096 {
		t.Fatalf("dropped=%v want 4096", body["dropped"])
	}
}

func TestToolOutput_ResolvesUUIDAndLabel(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("hi")

	for _, id := range []string{"p1", "W1.P1.T1", "aaaaaaaa-1111-2222-3333-444444444444"} {
		resp, body := getJSON(t, ts.URL+"/api/tools/output?id="+id)
		if resp.StatusCode != 200 {
			t.Fatalf("id=%s status=%d want 200", id, resp.StatusCode)
		}
		if body["toolId"] != "p1" {
			t.Fatalf("id=%s toolId=%v want p1", id, body["toolId"])
		}
	}
}

func TestToolOutput_UnknownIdentifier(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	resp, body := getJSON(t, ts.URL+"/api/tools/output?id=nope")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
	if body["error"] == nil {
		t.Fatal("error 필드 없음")
	}
}

// 워크스페이스에는 있지만 도구가 죽은 경우 — MCP 시절 TestReadOutput_NoTool 계약.
func TestToolOutput_DeadTool(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	resp, _ := getJSON(t, ts.URL+"/api/tools/output?id=dead-tool")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestToolOutput_MissingID(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	resp, _ := getJSON(t, ts.URL+"/api/tools/output")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

func TestToolOutput_BadBytes(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	io.snap["p1"] = []byte("x")
	resp, _ := getJSON(t, ts.URL+"/api/tools/output?id=p1&bytes=abc")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

// ── /api/tools/input (FR-API-2) ──────────────────────

func TestToolInput_PastesWithoutSubmit(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	resp, body := postJSON(t, ts.URL+"/api/tools/input",
		map[string]any{"id": "W1.P1.T1", "text": "echo hi"})
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if len(io.pastes) != 1 {
		t.Fatalf("pastes=%d want 1", len(io.pastes))
	}
	got := io.pastes[0]
	if got.ToolID != "p1" || got.Text != "echo hi" || got.Submit {
		t.Fatalf("paste=%+v want {p1 'echo hi' false}", got)
	}
	if body["execute"] != false {
		t.Fatalf("execute=%v want false", body["execute"])
	}
}

func TestToolInput_ExecuteSubmits(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	postJSON(t, ts.URL+"/api/tools/input",
		map[string]any{"id": "p1", "text": "ls", "execute": true})
	if len(io.pastes) != 1 || !io.pastes[0].Submit {
		t.Fatalf("pastes=%+v want submit=true", io.pastes)
	}
}

func TestToolInput_UnknownIdentifier(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	resp, _ := postJSON(t, ts.URL+"/api/tools/input",
		map[string]any{"id": "nope", "text": "x"})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
	if len(io.pastes) != 0 {
		t.Fatal("해석 실패인데 paste 가 나갔다")
	}
}

func TestToolInput_DeadTool(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	resp, _ := postJSON(t, ts.URL+"/api/tools/input",
		map[string]any{"id": "dead-tool", "text": "x"})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
}

func TestToolInput_BadJSON(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	resp, err := http.Post(ts.URL+"/api/tools/input", "application/json",
		strings.NewReader("{not json"))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
}

// ── /api/tools/message (FR-API-3) ────────────────────

func TestToolMessage_WrapsInEnvelope(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	resp, body := postJSON(t, ts.URL+"/api/tools/message",
		map[string]any{"to": "p1", "from": "p2", "message": "리뷰 부탁"})
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if len(io.pastes) != 1 {
		t.Fatalf("pastes=%d want 1", len(io.pastes))
	}
	got := io.pastes[0]
	if !got.Submit {
		t.Fatal("에이전트 메시지는 항상 자동 엔터여야 한다")
	}
	if !strings.HasPrefix(got.Text, "[DONGMINAL-AGENT-MSG from=W1.P1.T2 to=W1.P1.T1 ts=") {
		t.Fatalf("envelope 헤더 불일치:\n%s", got.Text)
	}
	if !strings.HasSuffix(got.Text, "\n리뷰 부탁\n[/DONGMINAL-AGENT-MSG]") {
		t.Fatalf("envelope 본문/닫힘 불일치:\n%s", got.Text)
	}
	if body["from"] != "W1.P1.T2" || body["to"] != "W1.P1.T1" {
		t.Fatalf("응답 라벨=%v/%v want W1.P1.T2/W1.P1.T1", body["from"], body["to"])
	}
}

// FR-API-3: uuid 로 들어온 from/to 는 사람 가독성용 라벨로 정규화된다.
func TestToolMessage_NormalizesUUIDToLabel(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	postJSON(t, ts.URL+"/api/tools/message", map[string]any{
		"to":      "aaaaaaaa-1111-2222-3333-444444444444",
		"from":    "bbbbbbbb-1111-2222-3333-444444444444",
		"message": "x",
	})
	if len(io.pastes) != 1 {
		t.Fatalf("pastes=%d want 1", len(io.pastes))
	}
	if !strings.Contains(io.pastes[0].Text, "from=W1.P1.T2 to=W1.P1.T1") {
		t.Fatalf("uuid 가 라벨로 정규화되지 않았다:\n%s", io.pastes[0].Text)
	}
	if io.pastes[0].ToolID != "p1" {
		t.Fatalf("라우팅 toolId=%s want p1", io.pastes[0].ToolID)
	}
}

// 라벨이 없는 식별자는 그대로 통과한다 (MCP 시절 LabelFromPassThrough 계약).
func TestToolMessage_UnresolvableFromPassesThrough(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	postJSON(t, ts.URL+"/api/tools/message",
		map[string]any{"to": "p1", "from": "외부-에이전트", "message": "x"})
	if !strings.Contains(io.pastes[0].Text, "from=외부-에이전트") {
		t.Fatalf("from 이 보존되지 않았다:\n%s", io.pastes[0].Text)
	}
}

func TestToolMessage_EmptyFromBecomesUnknown(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	postJSON(t, ts.URL+"/api/tools/message",
		map[string]any{"to": "p1", "message": "x"})
	if !strings.Contains(io.pastes[0].Text, "from=unknown") {
		t.Fatalf("빈 from 이 unknown 이 아니다:\n%s", io.pastes[0].Text)
	}
}

func TestToolMessage_MissingTool(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	resp, _ := postJSON(t, ts.URL+"/api/tools/message",
		map[string]any{"to": "dead-tool", "from": "p1", "message": "x"})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status=%d want 404", resp.StatusCode)
	}
	if len(io.pastes) != 0 {
		t.Fatal("수신 도구가 없는데 paste 가 나갔다")
	}
}

func TestToolMessage_EmptyMessageRejected(t *testing.T) {
	ts, io, _ := toolIOServer(t)
	resp, _ := postJSON(t, ts.URL+"/api/tools/message",
		map[string]any{"to": "p1", "from": "p2", "message": ""})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
	if len(io.pastes) != 0 {
		t.Fatal("빈 메시지가 전송됐다")
	}
}

// ── 공통 (FR-API-5/6) ────────────────────────────────

func TestToolIO_MethodMismatch(t *testing.T) {
	ts, _, _ := toolIOServer(t)
	cases := []struct{ method, path string }{
		{http.MethodPost, "/api/tools/output"},
		{http.MethodGet, "/api/tools/input"},
		{http.MethodGet, "/api/tools/message"},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, ts.URL+c.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Fatalf("%s %s 가 200 — 메서드 게이트가 없다", c.method, c.path)
		}
	}
}

// FR-API-6 의 안전망: toolaccess 의존성이 주입되지 않은 wiring 은 nil 역참조가
// 아니라 503 이어야 한다.
func TestToolIO_UnavailableWithoutDeps(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, _ := getJSON(t, ts.URL+"/api/tools/output?id=p1")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("output status=%d want 503", resp.StatusCode)
	}
	resp2, _ := postJSON(t, ts.URL+"/api/tools/input", map[string]any{"id": "p1", "text": "x"})
	if resp2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("input status=%d want 503", resp2.StatusCode)
	}
	resp3, _ := postJSON(t, ts.URL+"/api/tools/message", map[string]any{"to": "p1", "message": "x"})
	if resp3.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("message status=%d want 503", resp3.StatusCode)
	}
}

// stripANSI 는 MCP tools 패키지에서 이관됐다 (FR-API-1 의 strip=1 경로).
func TestStripANSI(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"plain", []byte("hello"), "hello"},
		{"csi", []byte("\x1b[31mred\x1b[0m"), "red"},
		{"osc", []byte("\x1b]0;title\x07after"), "after"},
		{"strip CR", []byte("a\r\nb"), "a\nb"},
		{"strip control", []byte("a\x01b"), "ab"},
		{"keep tab", []byte("a\tb"), "a\tb"},
		{"strip DEL", []byte("a\x7fb"), "ab"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stripANSI(c.in); got != c.want {
				t.Errorf("stripANSI(%q)=%q want %q", c.in, got, c.want)
			}
		})
	}
}
