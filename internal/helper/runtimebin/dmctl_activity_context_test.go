package runtimebin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// contextCapture 는 dmctl 이 서버로 보낸 것을 **바이트 그대로** 붙든다.
// 디코드한 뒤에 보면 유실된 필드를 볼 수 없으므로 원문을 남긴다 — NFR-4 의
// 검사 대상은 "무엇을 보냈나"가 아니라 "무엇이 실려 갔나"다.
type contextCapture struct {
	mu       sync.Mutex
	activity []string
	context  []string
}

func (c *contextCapture) paths() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.activity), len(c.context)
}

func (c *contextCapture) lastContext(t *testing.T) map[string]any {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.context) == 0 {
		t.Fatal("컨텍스트 관측이 전송되지 않았다")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(c.context[len(c.context)-1]), &m); err != nil {
		t.Fatalf("관측 페이로드가 JSON 이 아니다: %v", err)
	}
	return m
}

// startCapture 는 activity 와 컨텍스트 관측 두 종단을 함께 받는 가짜 서버다.
func startCapture(t *testing.T, toolID string) *contextCapture {
	t.Helper()
	cap := &contextCapture{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		cap.mu.Lock()
		switch r.URL.Path {
		case contextObservePath:
			cap.context = append(cap.context, string(raw))
		default:
			cap.activity = append(cap.activity, string(raw))
		}
		cap.mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(ts.Close)
	pointDmctlAtServer(t, ts, toolID)
	return cap
}

func writeTranscript(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("transcript 생성 실패: %v", err)
	}
	return p
}

func hookJSON(t *testing.T, fields map[string]any) io.Reader {
	t.Helper()
	blob, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("훅 페이로드 생성 실패: %v", err)
	}
	return strings.NewReader(string(blob))
}

// V-CBG-11 / NFR-4 — **이 테스트가 이 워크스트림의 잠금장치다.**
//
// transcript 의 내용은 어떤 형태로도 서버에 도달해서는 안 된다. 크기와 줄
// 수만 간다. 카나리아 문자열을 파일에 심고, 서버가 받은 **모든** 바이트에서
// 그것이 나오지 않음을 확인한다.
func TestReportContext_NeverSendsTranscriptContent(t *testing.T) {
	const canary = "CANARY-SECRET-DO-NOT-TRANSMIT"
	path := writeTranscript(t, `{"role":"user","text":"`+canary+`"}`+"\n"+
		`{"role":"assistant","text":"`+canary+` again"}`+"\n")
	cap := startCapture(t, "tool-1")

	var out, errb strings.Builder
	code := runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "ls"},
		"session_id":      "s-1",
		"transcript_path": path,
	}), &out, &errb)
	if code != 0 {
		t.Fatalf("훅은 항상 0 으로 끝난다, got %d", code)
	}

	cap.mu.Lock()
	all := strings.Join(append(append([]string{}, cap.activity...), cap.context...), "\n")
	cap.mu.Unlock()
	if strings.Contains(all, canary) {
		t.Fatalf("transcript 내용이 서버로 흘렀다 (NFR-4). 전송된 것:\n%s", all)
	}
	// 경로 자체도 보낼 이유가 없다 — 서버는 그 파일을 열지 않는다.
	if strings.Contains(all, path) {
		t.Fatalf("transcript 경로가 서버로 흘렀다: %s", all)
	}

	got := cap.lastContext(t)
	if got["toolId"] != "tool-1" {
		t.Fatalf("관측이 발신 도구를 싣지 않았다: %v", got)
	}
	st, _ := os.Stat(path)
	if int64(got["bytes"].(float64)) != st.Size() {
		t.Fatalf("바이트 수가 파일과 다르다: %v vs %d", got["bytes"], st.Size())
	}
	if got["sessionId"] != "s-1" {
		t.Fatalf("세션 결속이 유실됐다: %v", got)
	}
	// 줄 수·턴 수 같은 파생값을 보내지 않는다 — 그것을 세려면 파일을 읽어야
	// 하고, 훅은 stat 1회로 끝나야 한다 (NFR-CBG-1).
	if _, ok := got["lines"]; ok {
		t.Fatalf("파일을 읽어야만 나오는 값이 실렸다: %v", got)
	}
	if _, ok := got["compacted"]; ok {
		t.Fatalf("압축하지 않았는데 압축 신호가 실렸다: %v", got)
	}
}

// FR-CBG-1 / V-CBG-2: PreCompact 는 transcript 가 없어도 그 자체로 신호다.
func TestReportContext_PreCompactTravelsWithoutTranscript(t *testing.T) {
	cap := startCapture(t, "tool-1")
	var out, errb strings.Builder
	runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "PreCompact",
	}), &out, &errb)

	got := cap.lastContext(t)
	if got["compacted"] != true {
		t.Fatalf("압축 신호가 전달되지 않았다: %v", got)
	}
	// 재지 못한 것을 0 으로 채우지 않는다 (FR-CBG-5).
	if _, ok := got["bytes"]; ok {
		t.Fatalf("측정하지 못한 크기를 지어냈다: %v", got)
	}
}

// FR-CBG-5 / O-2: 신호가 없는 훅은 관측을 아예 보내지 않는다. codex 처럼
// transcript 를 주지 않는 에이전트가 unknown 으로 남는 경로다.
func TestReportContext_SilentWhenThereIsNoSignal(t *testing.T) {
	cap := startCapture(t, "tool-1")
	var out, errb strings.Builder
	runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "Stop",
	}), &out, &errb)
	runDmctlActivity([]string{"codex"}, strings.NewReader(`{"type":"agent-turn-complete"}`), &out, &errb)

	acts, ctxs := cap.paths()
	if ctxs != 0 {
		t.Fatalf("신호 없는 훅이 관측을 보냈다: %d 건", ctxs)
	}
	if acts != 2 {
		t.Fatalf("활동 보고는 그대로 가야 한다: %d 건", acts)
	}
}

// V-CBG-9 / NFR-CBG-2: transcript 접근이 실패해도 **활동 보고는 정상**이다.
// 관측 층의 오류가 activity·attention 을 막으면 안 된다.
func TestReportContext_StatFailureDoesNotBreakActivity(t *testing.T) {
	cap := startCapture(t, "tool-1")
	var out, errb strings.Builder
	code := runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"transcript_path": filepath.Join(t.TempDir(), "없는파일.jsonl"),
	}), &out, &errb)
	if code != 0 {
		t.Fatalf("stat 실패가 훅을 실패시켰다: rc=%d", code)
	}
	acts, _ := cap.paths()
	if acts != 1 {
		t.Fatalf("활동 보고가 관측 실패에 삼켜졌다: %d 건", acts)
	}
	// 못 잰 것은 보내지 않는다 — 그러나 훅 자체는 조용히 성공한다.
	got := cap.lastContext(t)
	if _, ok := got["bytes"]; ok {
		t.Fatalf("재지 못한 크기가 실렸다: %v", got)
	}
}

// NFR-CBG-1: 측정은 stat 1회다. 크기는 파일과 일치해야 하고, 열 수 없는 것은
// 모른다고 말해야 한다.
func TestTranscriptSize_StatsOnly(t *testing.T) {
	body := strings.Repeat("x", 4096)
	size, ok := transcriptSize(writeTranscript(t, body))
	if !ok || size != int64(len(body)) {
		t.Fatalf("크기 %d, 기대 %d (ok=%v)", size, len(body), ok)
	}
	if _, ok := transcriptSize(""); ok {
		t.Fatal("빈 경로를 측정했다고 했다")
	}
	if _, ok := transcriptSize(t.TempDir()); ok {
		t.Fatal("디렉터리를 transcript 로 쟀다")
	}
	if _, ok := transcriptSize(filepath.Join(t.TempDir(), "없는파일.jsonl")); ok {
		t.Fatal("없는 파일을 측정했다고 했다")
	}
}
