package telegram

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-10·11·40~45·80 — 브리지 본체.
//
// Telegram 은 가짜 서버, dongminal 은 가짜 Host 다. 사건은 process 로 하나씩 동기
// 처리한다 — 실제 배선의 큐는 TestBridgeEnqueueNeverBlocks 가 본다.

const (
	me   = int64(42)
	tabA = "tool-A"
)

type apiCall struct {
	Method string
	Body   map[string]any
}

type fakeTG struct {
	mu    sync.Mutex
	calls []apiCall
}

func (f *fakeTG) handler(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	f.mu.Lock()
	f.calls = append(f.calls, apiCall{parts[len(parts)-1], body})
	id := len(f.calls)
	f.mu.Unlock()
	if parts[len(parts)-1] == "sendMessage" {
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":`+strconv.Itoa(id)+`}}`)
		return
	}
	_, _ = io.WriteString(w, `{"ok":true,"result":true}`)
}

// edited 는 버튼을 걷은 메시지 id 들이다.
func (f *fakeTG) edited() []float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []float64
	for _, c := range f.calls {
		if c.Method == "editMessageReplyMarkup" {
			out = append(out, c.Body["message_id"].(float64))
		}
	}
	return out
}

func (f *fakeTG) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Method
	}
	return out
}

func (f *fakeTG) last(method string) (map[string]any, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].Method == method {
			return f.calls[i].Body, true
		}
	}
	return nil, false
}

type fakeHost struct {
	lastIn  map[string]time.Time
	locs    map[string]Location
	attends []string // "tool|typed" 또는 "tool|seen"
}

func (h *fakeHost) Attend(tool string, typed bool) {
	if typed {
		h.attends = append(h.attends, tool+"|typed")
		return
	}
	h.attends = append(h.attends, tool+"|seen")
}

func (h *fakeHost) LastBrowserInput(tool string) time.Time { return h.lastIn[tool] }
func (h *fakeHost) Location(tool string) Location {
	if l, ok := h.locs[tool]; ok {
		return l
	}
	return Location{Device: "mac", Tab: tool}
}

type rig struct {
	b    *Bridge
	tg   *fakeTG
	host *fakeHost
	st   *Store
	now  time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	tg := &fakeTG{}
	srv := httptest.NewServer(http.HandlerFunc(tg.handler))
	t.Cleanup(srv.Close)
	st := OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	_ = st.SetToken(testToken, "office_bot")
	_ = st.SetUser(me)
	_ = st.SetEnabled(true)
	host := &fakeHost{lastIn: map[string]time.Time{},
		locs: map[string]Location{tabA: {Device: "macmini", Window: "dongminal", Tab: "API 리팩터"}}}
	r := &rig{tg: tg, host: host, st: st, now: time.Unix(10_000, 0)}
	r.b = NewBridge(st, host, srv.URL, func() time.Time { return r.now })
	return r
}

func (r *rig) act(ev Event) { r.b.process(item{ev: &ev}) }

func (r *rig) attn(tool, reason string) { r.b.process(item{attnTool: tool, attnReason: reason}) }

func (r *rig) clear(tool string) { r.b.process(item{clearTool: tool}) }

// locA 는 tabA 의 접힌 문단 머리다.
const locA = "<code>Server :</code> <b>macmini</b>\n<code>Window :</code> <b>dongminal</b>\n<code>Tab    :</code> <b>API 리팩터</b>"

func (r *rig) msg(from int64, text string) {
	r.b.handleUpdate(Update{Message: &Message{From: &User{ID: from}, Chat: Chat{ID: from, Type: "private"}, Text: text}})
}

func (r *rig) press(from int64, data string) { r.pressOn(from, data, 5) }

func (r *rig) pressOn(from int64, data string, msgID int64) {
	r.b.handleUpdate(Update{CallbackQuery: &CallbackQuery{ID: "cb", From: User{ID: from}, Data: data,
		Message: &Message{MessageID: msgID, Chat: Chat{ID: from}}}})
}

// readData 는 마지막 알림의 `[✓ 읽음]` 버튼 데이터다. 없으면 빈 글이다.
func (r *rig) readData(t *testing.T) string {
	t.Helper()
	body, _ := r.tg.last("sendMessage")
	raw, _ := json.Marshal(body["reply_markup"])
	var mk struct {
		Rows [][]struct {
			Text string `json:"text"`
			Data string `json:"callback_data"`
		} `json:"inline_keyboard"`
	}
	_ = json.Unmarshal(raw, &mk)
	if len(mk.Rows) != 1 || len(mk.Rows[0]) != 1 || mk.Rows[0][0].Text != "읽음" {
		return ""
	}
	return mk.Rows[0][0].Data
}

var reTag = regexp.MustCompile(`<[^>]*>`)

// checkTags 는 FR-TGB-52b 의 허용 목록이다. 블록 태그는 접힌 문단을 여러 상자로 끊으므로
// 어떤 알림에도 <b>·<code>·바깥 <blockquote expandable> 한 번 말고는 없어야 한다.
func checkTags(t *testing.T, text string) {
	t.Helper()
	allowed := map[string]bool{"<b>": true, "</b>": true, "<code>": true, "</code>": true,
		"<blockquote expandable>": true, "</blockquote>": true}
	for _, tag := range reTag.FindAllString(text, -1) {
		if !allowed[tag] {
			t.Fatalf("허용 목록 밖의 태그 %s: %s", tag, text)
		}
	}
	if n := strings.Count(text, "<blockquote"); n != 1 || strings.Count(text, "</blockquote>") != 1 || !strings.HasSuffix(text, "</blockquote>") {
		t.Fatalf("접힌 문단이 바깥에 정확히 한 번이 아니다(%d): %s", n, text)
	}
}

// sent 는 마지막 알림이다. 알림은 허용 계정의 1:1 대화방으로 간다 (FR-TGB-50).
func (r *rig) sent(t *testing.T) string {
	t.Helper()
	body, ok := r.tg.last("sendMessage")
	if !ok {
		t.Fatal("알림을 보내지 않았다")
	}
	if body["chat_id"] != float64(me) || body["parse_mode"] != "HTML" {
		t.Fatalf("보낸 곳·형식이 틀렸다: %v", body)
	}
	if _, has := body["message_thread_id"]; has {
		t.Fatalf("토픽으로 보냈다: %v", body)
	}
	text := body["text"].(string)
	checkTags(t, text)
	return text
}

func writeLines(t *testing.T, p string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, l := range lines {
		_, _ = f.WriteString(l + "\n")
	}
}

func replyLine(text string) string {
	b, _ := json.Marshal(text)
	return `{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":` + string(b) + `}]}}`
}

func wantHas(t *testing.T, text string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(text, p) {
			t.Fatalf("%q 가 없다:\n%s", p, text)
		}
	}
}

// folded 는 접힌 문단에서 구분선 아래의 내용이다. 없으면 빈 글이다.
func folded(text string) string {
	_, rest, ok := strings.Cut(text, "\n\n"+divider+"\n\n")
	if !ok {
		return ""
	}
	in, _, _ := strings.Cut(rest, "</blockquote>")
	return in
}

// ── 허용 계정 (TC-TGB-10·11) ──

func TestBridgeIgnoresStranger(t *testing.T) {
	r := newRig(t)
	r.msg(7, "/agents")
	r.msg(7, "hello")
	r.press(7, "r:"+tabA)
	if m := r.tg.methods(); len(m) != 0 {
		t.Fatalf("모르는 사람에게 답했다: %v", m)
	}
}

func TestBridgePairCommand(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetUser(0)
	code, _ := r.b.Pairing().Issue()
	r.msg(77, "/pair 000000")
	if r.st.Config().UserID != 0 {
		t.Fatal("틀린 코드로 등록됐다")
	}
	r.msg(77, "/pair "+code)
	if r.st.Config().UserID != 77 {
		t.Fatal("맞는 코드로 등록되지 않았다")
	}
}

// FR-TGB-14: 허용 계정의 다른 글에는 안내만 하고, 남은 버튼은 로딩으로 두지 않는다.
func TestBridgeOwnerGetsNoticeOnly(t *testing.T) {
	r := newRig(t)
	r.msg(me, "/agents")
	body, ok := r.tg.last("sendMessage")
	if !ok || !strings.Contains(body["text"].(string), "알림만") {
		t.Fatalf("안내가 없다: %v", body)
	}
	r.press(me, "c:1:2")
	ans, ok := r.tg.last("answerCallbackQuery")
	if !ok || ans["callback_query_id"] != "cb" || !strings.Contains(ans["text"].(string), "지원하지 않는") {
		t.Fatalf("버튼에 답하지 않았다: %v", ans)
	}
}

// ── 알림 (TC-TGB-40~45) ──

func TestBridgeDoneCarriesLastReplyFolded(t *testing.T) {
	r := newRig(t)
	tp := filepath.Join(t.TempDir(), "s.jsonl")
	writeLines(t, tp, replyLine("앞 응답"), replyLine("```\nx\n```"), replyLine("모두 고쳤습니다. <b>태그</b> & 끝"))
	r.act(Event{ToolID: tabA, Hook: "UserPromptSubmit", Transcript: tp})
	r.act(Event{ToolID: tabA, Hook: "Stop", Transcript: tp})
	r.attn(tabA, "done")
	text := r.sent(t)
	head, _, _ := strings.Cut(text, divider)
	if head != "✅ <b>완료</b>\n<blockquote expandable>"+locA+"\n\n" {
		t.Fatalf("머리가 틀렸다: %q", head)
	}
	if got := folded(text); got != "모두 고쳤습니다. &lt;b&gt;태그&lt;/b&gt; &amp; 끝" {
		t.Fatalf("접힌 내용이 틀렸다: %q", got)
	}
}

func TestBridgeStopFailureIsError(t *testing.T) {
	r := newRig(t)
	r.act(Event{ToolID: tabA, Hook: "StopFailure", Detail: "rate_limit"})
	r.attn(tabA, "done")
	text := r.sent(t)
	wantHas(t, text, "❌", "<b>오류</b>")
	if folded(text) != "rate_limit" {
		t.Fatalf("오류 내용이 틀렸다: %s", text)
	}
	// 다음 턴이 정상으로 끝나면 다시 완료다.
	r.act(Event{ToolID: tabA, Hook: "UserPromptSubmit"})
	r.act(Event{ToolID: tabA, Hook: "Stop"})
	r.attn(tabA, "done")
	wantHas(t, r.sent(t), "✅")
}

func TestBridgeQuestionAlarm(t *testing.T) {
	r := newRig(t)
	in := json.RawMessage(`{"questions":[{"header":"색","question":"어느 색?","options":[{"label":"빨강","description":"따뜻함"},{"label":"파랑"}]}]}`)
	r.act(Event{ToolID: tabA, Hook: "PreToolUse", Tool: "AskUserQuestion", Input: in})
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: "AskUserQuestion"})
	r.attn(tabA, "waiting")
	text := r.sent(t)
	wantHas(t, text, "❓ <b>질문</b>\n<blockquote expandable>"+locA+"\n\n"+divider+"\n\n")
	if got := folded(text); got != "<b>[색] 어느 색?</b>\n1. 빨강 — 따뜻함\n2. 파랑" {
		t.Fatalf("질문 모양이 틀렸다: %q", got)
	}
}

func TestBridgePermissionAlarm(t *testing.T) {
	r := newRig(t)
	in := json.RawMessage(`{"command":"rm -rf build && make"}`)
	r.act(Event{ToolID: tabA, Hook: "PreToolUse", Tool: "Bash"})
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: "Bash", Input: in})
	r.attn(tabA, "waiting")
	text := r.sent(t)
	wantHas(t, text, "🔐 <b>권한 요청</b> · Bash\n")
	if folded(text) != "<code>rm -rf build &amp;&amp; make</code>" {
		t.Fatalf("권한 내용이 틀렸다: %s", text)
	}
	// 원문이 상한을 넘으면 Detail 로 보인다 (FR-TGB-81).
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: "Write", InputOver: true, Detail: "/src/big.go"})
	r.attn(tabA, "waiting")
	if folded(r.sent(t)) != "<code>/src/big.go</code>" {
		t.Fatal("상한을 넘은 요청의 요약이 없다")
	}
	// 여러 줄 명령은 줄마다 감싼다 (FR-TGB-52b).
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: "Bash", Input: json.RawMessage(`{"command":"cd x\n\nmake"}`)})
	r.attn(tabA, "waiting")
	if got := folded(r.sent(t)); got != "<code>cd x</code>\n\n<code>make</code>" {
		t.Fatalf("여러 줄 명령의 모양이 틀렸다: %q", got)
	}
}

// TC-TGB-43: 처리된 요청은 다음 기다림의 종류가 되지 않는다.
func TestBridgeClosedRequestIsPlainWaiting(t *testing.T) {
	r := newRig(t)
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`)})
	r.act(Event{ToolID: tabA, Hook: "PostToolUse", Tool: "Bash"})
	r.act(Event{ToolID: tabA, Hook: "Notification", Detail: "Claude needs your input"})
	r.attn(tabA, "waiting")
	text := r.sent(t)
	wantHas(t, text, "⏳", "<b>입력 대기</b>")
	if strings.Contains(text, "🔐") || folded(text) != "Claude needs your input" {
		t.Fatalf("닫힌 권한 요청이 남았다: %s", text)
	}
}

// FR-TGB-59: hook 이 없는 에이전트는 내용 없이 간다. 모르는 사유는 🔔 다.
func TestBridgeNoHookAgent(t *testing.T) {
	r := newRig(t)
	r.attn("codex-tab", "done")
	text := r.sent(t)
	if text != "✅ <b>완료</b>\n<blockquote expandable><code>Server :</code> <b>mac</b>\n<code>Tab    :</code> <b>codex-tab</b></blockquote>" {
		t.Fatalf("모르는 윈도우 줄이 있거나 내용이 있다: %q", text)
	}
	r.attn("codex-tab", "waiting")
	wantHas(t, r.sent(t), "⏳")
	r.attn("codex-tab", "bell")
	wantHas(t, r.sent(t), "🔔")
}

// TC-TGB-42: 3500자를 넘으면 앞부분만 남긴다.
func TestBridgeLongContentCut(t *testing.T) {
	r := newRig(t)
	tp := filepath.Join(t.TempDir(), "s.jsonl")
	writeLines(t, tp, replyLine(strings.Repeat("가", 5000)))
	r.act(Event{ToolID: tabA, Hook: "Stop", Transcript: tp})
	r.attn(tabA, "done")
	text := r.sent(t)
	got := folded(text)
	if !strings.HasSuffix(got, "…(PC 에서 보기)") || utf8.RuneCountInString(strings.TrimSuffix(got, "…(PC 에서 보기)")) != contentMax {
		t.Fatalf("자르지 않았다: %d글자", utf8.RuneCountInString(got))
	}
	if utf8.RuneCountInString(text) > 4096 {
		t.Fatalf("메시지 한도를 넘었다: %d글자", utf8.RuneCountInString(text))
	}
}

// TC-TGB-44: 위치는 굵게 한 줄씩이고, 윈도우를 모르면 그 줄을 뺀다.
func TestLocationLines(t *testing.T) {
	if got := locationLines(Location{Device: "d", Window: "w", Tab: "t"}); got != "<code>Server :</code> <b>d</b>\n<code>Window :</code> <b>w</b>\n<code>Tab    :</code> <b>t</b>" {
		t.Fatalf("%q", got)
	}
	if got := locationLines(Location{Device: "<d>", Tab: "t&"}); got != "<code>Server :</code> <b>&lt;d&gt;</b>\n<code>Tab    :</code> <b>t&amp;</b>" {
		t.Fatalf("%q", got)
	}
}

// TC-TGB-48: 읽음 버튼은 PC 의 포커스와 같은 해제다.
func TestBridgeReadButton(t *testing.T) {
	r := newRig(t)
	r.attn(tabA, "done")
	data := r.readData(t)
	if data != "r:"+tabA {
		t.Fatalf("읽음 버튼 데이터=%q", data)
	}
	r.press(7, data)
	if len(r.host.attends) != 0 {
		t.Fatalf("남이 누른 버튼으로 알람을 껐다: %v", r.host.attends)
	}
	r.press(me, data)
	if len(r.host.attends) != 1 || r.host.attends[0] != tabA+"|seen" {
		t.Fatalf("attends=%v", r.host.attends)
	}
	ans, _ := r.tg.last("answerCallbackQuery")
	if ans["text"] != "읽음" {
		t.Fatalf("답=%v", ans)
	}
	ed, ok := r.tg.last("editMessageReplyMarkup")
	if !ok || ed["message_id"] != float64(5) || ed["chat_id"] != float64(me) {
		t.Fatalf("버튼을 걷지 않았다: %v", ed)
	}
	long := strings.Repeat("x", 63)
	r.attn(long, "done")
	if r.readData(t) != "" {
		t.Fatal("64바이트를 넘는 데이터로 버튼을 달았다")
	}
}

// TC-TGB-49: PC 에서 알람이 꺼지면 그 탭의 남은 버튼을 걷는다 (FR-TGB-58b).
func TestBridgeClearRemovesButtons(t *testing.T) {
	r := newRig(t)
	r.attn(tabA, "done")
	r.attn(tabA, "waiting")
	r.attn("tool-B", "done")
	r.clear(tabA)
	got := r.tg.edited()
	if len(got) != 2 || !slices.Contains(got, 1) || !slices.Contains(got, 2) {
		t.Fatalf("tabA 의 두 알림 버튼을 걷지 않았다: %v", got)
	}
	r.clear(tabA)
	if len(r.tg.edited()) != 2 {
		t.Fatalf("이미 걷은 버튼을 다시 걷었다: %v", r.tg.edited())
	}
	// 읽음으로 걷은 메시지는 해제 때 다시 걷지 않는다. tool-B 의 첫 알림은 3번이다.
	r.pressOn(me, "r:tool-B", 3)
	r.clear("tool-B")
	if got := r.tg.edited(); len(got) != 3 || got[2] != 3 {
		t.Fatalf("읽음으로 걷은 버튼을 해제 때 다시 걷었다: %v", got)
	}
}

// TC-TGB-47: Markdown 옮기기 (FR-TGB-52a).
func TestMarkdownToHTML(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"제목", "## 바뀐 <것>", "<b>바뀐 &lt;것&gt;</b>"},
		{"목록", "- 하나\n  * 둘", "• 하나\n  • 둘"},
		{"굵게·코드", "**굵게** 와 `a**b**` & c", "<b>굵게</b> 와 <code>a**b**</code> &amp; c"},
		{"울타리", "앞\n```go\nx := 1 < 2\n\n  y()\n```\n뒤", "앞\n<code>x := 1 &lt; 2</code>\n\n<code>  y()</code>\n뒤"},
		{"닫히지 않은 울타리", "```\nfoo", "<code>foo</code>"},
		{"표", "| 이름 | 값 |\n|---|:--:|\n| a | **b** |", "<b>이름 · 값</b>\n• a · <b>b</b>"},
		{"인용", "> 주의", "주의"},
		{"가로줄·빈 줄", "a\n---\n\n\n\nb", "a\n\nb"},
	}
	for _, tc := range cases {
		got := mdToHTML(tc.in)
		if got != tc.want {
			t.Errorf("%s: %q, 기대 %q", tc.name, got, tc.want)
		}
		checkTags(t, alarmText(kindDone, Location{Device: "d", Tab: "t"}, got))
	}
}

// TC-TGB-45
func TestBridgeSilenceAfterPCInput(t *testing.T) {
	r := newRig(t)
	r.host.lastIn[tabA] = r.now.Add(-2 * time.Minute)
	r.attn(tabA, "done")
	body, _ := r.tg.last("sendMessage")
	if body["disable_notification"] != true {
		t.Fatalf("PC 입력 2분 뒤인데 소리가 난다: %v", body)
	}
	r.host.lastIn[tabA] = r.now.Add(-6 * time.Minute)
	r.attn(tabA, "done")
	body, _ = r.tg.last("sendMessage")
	if body["disable_notification"] == true {
		t.Fatal("PC 입력 6분 뒤인데 소리가 나지 않는다")
	}
	_ = r.st.SetSilence(0)
	r.host.lastIn[tabA] = r.now
	r.attn(tabA, "done")
	body, _ = r.tg.last("sendMessage")
	if body["disable_notification"] == true {
		t.Fatal("무음 시간 0 인데 소리가 나지 않는다")
	}
}

// ── 꺼짐 (TC-TGB-80) ──

func TestBridgeDisabledIsSilent(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetEnabled(false)
	r.act(Event{ToolID: tabA, Hook: "Stop"})
	r.attn(tabA, "done")
	r.msg(me, "hello")
	if m := r.tg.methods(); len(m) != 0 {
		t.Fatalf("꺼져 있는데 Telegram 을 불렀다: %v", m)
	}
}

// 사건 넣기는 막지 않는다 (NFR-TGB-2). 큐가 차면 버린다.
func TestBridgeEnqueueNeverBlocks(t *testing.T) {
	r := newRig(t)
	done := make(chan struct{})
	go func() {
		for i := 0; i < queueSize*3; i++ {
			r.b.OnActivity(Event{ToolID: tabA, Hook: "PreToolUse"})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("OnActivity 가 막혔다")
	}
}
