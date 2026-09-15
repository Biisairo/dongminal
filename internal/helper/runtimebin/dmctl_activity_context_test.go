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

// activitySnapshot 은 지금까지 받은 활동 보고 본문이다. 잠금을 쥐고 복사한다 —
// 보고는 다른 고루틴에서 올 수 있다.
func (c *contextCapture) activitySnapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.activity...)
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

// V-CTX-2 (UX_BATCH6_SRS FR-CTX-1·3): 관측이 **실측 토큰과 모델**을 함께 싣고,
// 그러고도 본문은 새지 않는다.
//
// 카나리아를 assistant 줄의 본문 자리에 심는다 — usage 를 읽는 새 경로가 그 줄을
// 통째로 파싱하므로, 잠금장치가 지켜야 할 자리가 바로 거기다.
func TestReportContext_SendsMeasuredTokensAndModel(t *testing.T) {
	const canary = "CANARY-SECRET-DO-NOT-TRANSMIT"
	path := writeTranscript(t, `{"type":"user","message":{"content":"`+canary+`"}}`+"\n"+
		`{"type":"assistant","message":{"model":"claude-opus-5[1m]",`+
		`"content":[{"type":"text","text":"`+canary+`"}],`+
		`"usage":{"input_tokens":2,"cache_creation_input_tokens":100,`+
		`"cache_read_input_tokens":400000,"output_tokens":50}}}`+"\n")
	cap := startCapture(t, "tool-1")

	var out, errb strings.Builder
	if code := runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
		"session_id":      "s-1",
		"transcript_path": path,
	}), &out, &errb); code != 0 {
		t.Fatalf("훅은 항상 0 으로 끝난다, got %d", code)
	}

	cap.mu.Lock()
	all := strings.Join(append(append([]string{}, cap.activity...), cap.context...), "\n")
	cap.mu.Unlock()
	if strings.Contains(all, canary) {
		t.Fatalf("transcript 내용이 서버로 흘렀다 (NFR-4):\n%s", all)
	}

	got := cap.lastContext(t)
	if int64(got["tokens"].(float64)) != 2+100+400000 {
		t.Fatalf("실측 토큰이 실리지 않았다: %v", got["tokens"])
	}
	if got["model"] != "claude-opus-5[1m]" {
		t.Fatalf("모델이 실리지 않았다: %v", got["model"])
	}
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
	// **경로는 간다** (NFR-4 개정 2026-09-14, M9_SRS FR-M9-41). 서버가 올린 세션의
	// 기록을 읽을 이유가 생겼고, 서버가 로컬 파일을 여는 것과 훅이 내용을 보내는
	// 것은 다른 일이다. 잠금장치가 지키는 것은 **내용**이며 그것은 위에서 쟀다.
	if !strings.Contains(all, `"transcriptPath":`) {
		t.Fatalf("전사본 경로가 실리지 않았다 (FR-M9-41): %s", all)
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

// V-M9-37 (M9_SRS FR-M9-37 / M9-B19): **세션 신원은 세션이 시작될 때 잡힌다.**
//
// 종전에는 활동 훅(`PostToolUse`·`Notification`·`PreCompact`)만이 신원을 실었다.
// 그 훅들은 세션이 **무언가를 할 때** 나므로, 띄우고 턴을 돌리지 않은 세션은 영영
// 신원이 없었다 — 실측에서 사용자의 탭이 그 상태였고(`claude --resume …` 가 도는데
// 서버는 `no agent session`), 그래서 올리기 진입점이 서지 않았다.
//
// `SessionStart` 훅은 **무조건** 발화한다. 그것이 이 자리의 값이다.
func TestAgentContext_SessionStartCarriesIdentity(t *testing.T) {
	cap := startCapture(t, "tool-ctx")
	var out, errb strings.Builder
	tp := writeTranscript(t, `{"type":"user","message":{"content":"x"}}`+"\n")
	if code := runDmctlAgentContext([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "SessionStart",
		"session_id":      "s-start",
		"transcript_path": tp,
		"cwd":             "/tmp",
	}), &out, &errb); code != 0 {
		t.Fatalf("훅은 항상 0 으로 끝난다, got %d", code)
	}
	// 본래의 일(컨텍스트 주입)은 그대로다 — 신원 보고가 그것을 가리면 안 된다.
	if !strings.Contains(out.String(), "additionalContext") {
		t.Fatalf("주입 페이로드가 사라졌다: %s", out.String())
	}
	cap.mu.Lock()
	got := append([]string(nil), cap.context...)
	cap.mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("신원 보고가 한 번 가야 한다: %v", got)
	}
	for _, want := range []string{`"sessionId":"s-start"`, `"toolId":"tool-ctx"`, `"agent":"claude"`} {
		if !strings.Contains(got[0], want) {
			t.Fatalf("보고에 %s 가 없다: %s", want, got[0])
		}
	}
	// V-M9-41 (NFR-4 개정 2026-09-14, M9_SRS FR-M9-41): **경로는 싣고 내용은 싣지
	// 않는다.** 종전에는 경로조차 보내지 않았고 그 근거가 *"서버는 그 파일을 열
	// 이유가 없다"* 였다 — 이제 이유가 생겼다(올린 세션의 기록을 서버가 읽는다).
	// 바뀌지 않는 둘: **훅은 내용을 실어 보내지 않는다**, **`runs.json` 에 내용이
	// 적히지 않는다**.
	if !strings.Contains(got[0], `"transcriptPath":`) {
		t.Fatalf("전사본 경로가 실리지 않았다 (FR-M9-41): %s", got[0])
	}
	// 경로 밖의 것은 여전히 실리지 않는다 — cwd 는 이 보고의 것이 아니다.
	if strings.Contains(got[0], `"/tmp"`) {
		t.Fatalf("식별자·경로 밖의 것이 실렸다: %s", got[0])
	}
}

// V-M9-41 / NFR-4 (개정) — **경로가 가도 내용은 가지 않는다.**
//
// 잠금장치의 자리가 옮겨진 것이 아니라 좁혀졌다. 카나리아를 전사본에 심고,
// `SessionStart` 훅이 서버로 보낸 **모든 바이트**에서 그것이 나오지 않음을 본다.
func TestAgentContext_SessionStartSendsPathNotContent(t *testing.T) {
	const canary = "CANARY-SECRET-DO-NOT-TRANSMIT"
	tp := writeTranscript(t, `{"type":"user","message":{"content":"`+canary+`"}}`+"\n")
	cap := startCapture(t, "tool-ctx")
	var out, errb strings.Builder
	runDmctlAgentContext([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "SessionStart",
		"session_id":      "s-start",
		"transcript_path": tp,
	}), &out, &errb)

	got := cap.lastContext(t)
	if got["transcriptPath"] != tp {
		t.Fatalf("경로가 그대로 가지 않았다: %v", got["transcriptPath"])
	}
	cap.mu.Lock()
	all := strings.Join(append(append([]string{}, cap.activity...), cap.context...), "\n")
	cap.mu.Unlock()
	if strings.Contains(all, canary) {
		t.Fatalf("transcript 내용이 서버로 흘렀다 (NFR-4):\n%s", all)
	}
}

// V-M9-37: **신원이 없으면 아무것도 보내지 않는다.** 빈 값을 보내면 받는 쪽이
// "신원이 빈 세션" 으로 읽고, 그것은 "모른다" 와 다르다 (FR-CBG-5).
func TestAgentContext_NoIdentityIsSilent(t *testing.T) {
	cap := startCapture(t, "tool-ctx")
	var out, errb strings.Builder
	runDmctlAgentContext([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "SessionStart",
	}), &out, &errb)
	cap.mu.Lock()
	n := len(cap.context)
	cap.mu.Unlock()
	if n != 0 {
		t.Fatalf("신원이 없는데 보고했다: %v", cap.context)
	}
	if !strings.Contains(out.String(), "additionalContext") {
		t.Fatalf("주입은 그대로여야 한다: %s", out.String())
	}
}

// V-M11-16 (M11_SRS FR-M11-7 / M11-B7): **세션 id 만으로도 관측이 나간다.**
//
// `SessionStart` 는 전사본이 아직 없는 자리다 — 그 파일은 첫 프롬프트에야 생긴다.
// 종전의 판정이 전사본과 압축만 보아서, 신원을 들고도 조용히 돌아섰고 올리기
// 진입점이 첫 프롬프트까지 서지 않았다 (사용자 확인 2026-09-15).
func TestReportContext_SessionStartCarriesIdentityWithoutTranscript(t *testing.T) {
	cap := startCapture(t, "tool-1")
	var out, errb strings.Builder
	runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "SessionStart",
		"session_id":      "sess-abc",
		"source":          "startup",
	}), &out, &errb)

	got := cap.lastContext(t)
	if got["sessionId"] != "sess-abc" {
		t.Fatalf("전사본이 없다고 신원을 버렸다 — 올리기가 첫 프롬프트까지 선다: %v", got)
	}
	if got["agent"] != "claude" {
		t.Fatalf("어댑터를 말하지 않으면 서버가 재개 명령을 고를 수 없다: %v", got)
	}
	// 없는 것은 그대로 없어야 한다 (FR-CBG-5).
	if _, ok := got["transcriptPath"]; ok {
		t.Fatalf("없는 경로를 지어냈다: %v", got)
	}
	if _, ok := got["bytes"]; ok {
		t.Fatalf("재지 못한 크기를 지어냈다: %v", got)
	}
}
