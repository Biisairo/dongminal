package telegram

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-10·20·22·30·32·40·60·80 — 브리지 본체.
//
// Telegram 은 가짜 서버, dongminal 은 가짜 Host 다. 사건은 process 로 하나씩 동기
// 처리한다 — 실제 배선의 큐는 TestBridgeEnqueueNeverBlocks 가 본다.

const (
	me   = int64(42)
	tabA = "tool-A"
	tabB = "tool-B"
	sess = "sess-1"
)

type apiCall struct {
	Method string
	Body   map[string]any
}

type fakeTG struct {
	mu      sync.Mutex
	calls   []apiCall
	nextID  int64
	failFor map[string]string // method → description (한 번)
}

func (f *fakeTG) handler(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	m := parts[len(parts)-1]
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	f.mu.Lock()
	f.calls = append(f.calls, apiCall{m, body})
	f.nextID++
	id := f.nextID
	desc, fail := f.failFor[m]
	if fail {
		delete(f.failFor, m)
	}
	f.mu.Unlock()
	if fail {
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":400,"description":"`+desc+`"}`)
		return
	}
	switch m {
	case "createForumTopic":
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_thread_id":`+itoa(1000+id)+`,"name":"x"}}`)
	case "sendMessage":
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":`+itoa(id)+`,"chat":{"id":42}}}`)
	default:
		_, _ = io.WriteString(w, `{"ok":true,"result":true}`)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

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

func (f *fakeTG) reset() { f.mu.Lock(); f.calls = nil; f.mu.Unlock() }

type fakeHost struct {
	mu      sync.Mutex
	pastes  []string // "tool|text"
	keys    []string // "tool|bytes"
	attends []string // "tool|typed"
	lastIn  map[string]time.Time
	names   map[string]string
	screen  string
	agents  []AgentInfo
}

func (h *fakeHost) Paste(tool, text string) error {
	h.mu.Lock()
	h.pastes = append(h.pastes, tool+"|"+text)
	h.mu.Unlock()
	return nil
}
func (h *fakeHost) Keys(tool string, b []byte) error {
	h.mu.Lock()
	h.keys = append(h.keys, tool+"|"+string(b))
	h.mu.Unlock()
	return nil
}
func (h *fakeHost) Attend(tool string, typed bool) {
	h.mu.Lock()
	if typed {
		h.attends = append(h.attends, tool+"|typed")
	} else {
		h.attends = append(h.attends, tool+"|seen")
	}
	h.mu.Unlock()
}
func (h *fakeHost) LastBrowserInput(tool string) time.Time { return h.lastIn[tool] }
func (h *fakeHost) ToolName(tool string) string {
	if n, ok := h.names[tool]; ok {
		return n
	}
	return tool
}
func (h *fakeHost) Screen(string) string { return h.screen }
func (h *fakeHost) Agents() []AgentInfo  { return h.agents }

type rig struct {
	b    *Bridge
	tg   *fakeTG
	host *fakeHost
	st   *Store
	now  time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	tg := &fakeTG{failFor: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(tg.handler))
	t.Cleanup(srv.Close)
	st := OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	_ = st.SetToken(testToken, "office_bot")
	_ = st.SetUser(me)
	_ = st.SetEnabled(true)
	host := &fakeHost{lastIn: map[string]time.Time{}, names: map[string]string{tabA: "API 리팩터", tabB: "새 탭"}}
	r := &rig{tg: tg, host: host, st: st, now: time.Unix(10_000, 0)}
	r.b = NewBridge(st, host, srv.URL, func() time.Time { return r.now })
	return r
}

func (r *rig) act(ev Event) { r.b.process(item{ev: &ev}) }

func (r *rig) attn(tool, reason string) { r.b.process(item{attnTool: tool, attnReason: reason}) }

func (r *rig) msg(from int64, thread int64, text string) {
	r.b.handleUpdate(Update{Message: &Message{From: &User{ID: from}, Chat: Chat{ID: from, Type: "private"}, ThreadID: thread, Text: text}})
}

func (r *rig) press(from int64, thread int64, data string) {
	r.b.handleUpdate(Update{CallbackQuery: &CallbackQuery{ID: "cb", From: User{ID: from}, Data: data,
		Message: &Message{MessageID: 1, Chat: Chat{ID: from}, ThreadID: thread}}})
}

func (r *rig) start(tool string) {
	r.act(Event{ToolID: tool, SessionID: sess, State: "idle", Hook: "SessionStart", Source: "startup"})
}

func (r *rig) thread(t *testing.T) int64 {
	t.Helper()
	tp, ok := r.st.Topic(sess)
	if !ok {
		t.Fatal("토픽이 없다")
	}
	return tp.ThreadID
}

// 버튼 데이터를 마지막 sendMessage 의 reply_markup 에서 글자로 찾는다.
func (r *rig) button(t *testing.T, label string) string {
	t.Helper()
	r.tg.mu.Lock()
	defer r.tg.mu.Unlock()
	for i := len(r.tg.calls) - 1; i >= 0; i-- {
		raw, _ := json.Marshal(r.tg.calls[i].Body["reply_markup"])
		var mk struct {
			Rows [][]struct {
				Text string `json:"text"`
				Data string `json:"callback_data"`
			} `json:"inline_keyboard"`
		}
		_ = json.Unmarshal(raw, &mk)
		for _, row := range mk.Rows {
			for _, b := range row {
				if strings.Contains(b.Text, label) {
					return b.Data
				}
			}
		}
	}
	t.Fatalf("버튼 %q 가 없다", label)
	return ""
}

// ── 허용 계정 (TC-TGB-10) ──

func TestBridgeIgnoresStranger(t *testing.T) {
	r := newRig(t)
	r.msg(7, 0, "/agents")
	r.msg(7, 0, "hello")
	if m := r.tg.methods(); len(m) != 0 {
		t.Fatalf("모르는 사람에게 답했다: %v", m)
	}
}

func TestBridgePairCommand(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetUser(0)
	code, _ := r.b.Pairing().Issue()
	r.msg(77, 0, "/pair 000000")
	if r.st.Config().UserID != 0 {
		t.Fatal("틀린 코드로 등록됐다")
	}
	r.msg(77, 0, "/pair "+code)
	if r.st.Config().UserID != 77 {
		t.Fatal("맞는 코드로 등록되지 않았다")
	}
}

// ── 대화와 토픽 (TC-TGB-20·22) ──

func TestBridgeStartDoesNotOpenTopic(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	if _, ok := r.st.Topic(sess); ok {
		t.Fatal("시작만 했는데 토픽이 생겼다 (FR-TGB-22)")
	}
}

func TestBridgeDoneAlarmOpensTopic(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.act(Event{ToolID: tabA, SessionID: sess, State: "done", Hook: "Stop"})
	r.attn(tabA, "done")
	th := r.thread(t)
	body, ok := r.tg.last("sendMessage")
	if !ok || body["message_thread_id"].(float64) != float64(th) {
		t.Fatalf("알림이 토픽으로 가지 않았다: %v", body)
	}
	_ = r.button(t, "읽음")
	cr, _ := r.tg.last("createForumTopic")
	if !strings.Contains(cr["name"].(string), "API 리팩터") {
		t.Fatalf("토픽 이름에 탭 이름이 없다: %v", cr["name"])
	}
}

func TestBridgeResumeReusesTopicAndFollowsTab(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	th := r.thread(t)
	r.act(Event{ToolID: tabA, SessionID: sess, State: "ended", Hook: "SessionEnd"})
	r.act(Event{ToolID: tabB, SessionID: sess, State: "idle", Hook: "SessionStart", Source: "resume"})
	if got := r.thread(t); got != th {
		t.Fatalf("이어 하기인데 토픽이 바뀌었다: %d → %d", th, got)
	}
	r.msg(me, th, "계속해")
	if len(r.host.pastes) != 1 || r.host.pastes[0] != tabB+"|계속해" {
		t.Fatalf("현재 탭(B)으로 가지 않았다: %v", r.host.pastes)
	}
}

func TestBridgeEndedTopicRefusesInput(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	th := r.thread(t)
	r.tg.reset()
	r.act(Event{ToolID: tabA, SessionID: sess, State: "ended", Hook: "SessionEnd"})
	r.b.flushNames()
	if body, ok := r.tg.last("editForumTopic"); !ok || !strings.HasPrefix(body["name"].(string), "⏹") {
		t.Fatalf("끝난 대화가 ⏹ 가 되지 않았다: %v", body)
	}
	r.msg(me, th, "hello")
	if len(r.host.pastes) != 0 {
		t.Fatal("실행 중이 아닌 대화에 넣었다 (FR-TGB-26)")
	}
}

func TestBridgeCloseDeletesTopicOnly(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	th := r.thread(t)
	r.msg(me, th, "/close")
	if _, ok := r.tg.last("deleteForumTopic"); !ok {
		t.Fatal("토픽을 지우지 않았다")
	}
	if _, ok := r.st.Topic(sess); ok {
		t.Fatal("대응표에 남았다")
	}
	if len(r.host.keys)+len(r.host.pastes) != 0 {
		t.Fatal("토픽을 지우면서 에이전트를 건드렸다")
	}
}

func TestBridgeCleanupDeletesEndedOnly(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	r.act(Event{ToolID: tabB, SessionID: "sess-2", State: "idle", Hook: "SessionStart", Source: "startup"})
	r.attn(tabB, "done")
	r.act(Event{ToolID: tabA, SessionID: sess, State: "ended", Hook: "SessionEnd"})
	r.msg(me, 0, "/cleanup")
	if _, ok := r.st.Topic(sess); ok {
		t.Fatal("끝난 토픽이 남았다")
	}
	if _, ok := r.st.Topic("sess-2"); !ok {
		t.Fatal("살아 있는 토픽을 지웠다")
	}
}

// 지워진 토픽에 보내다 실패하면 다시 만든다 (FR-TGB-28).
func TestBridgeRecreatesDeletedTopic(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	old := r.thread(t)
	r.tg.mu.Lock()
	r.tg.failFor["sendMessage"] = "Bad Request: message thread not found"
	r.tg.mu.Unlock()
	r.attn(tabA, "done")
	if got := r.thread(t); got == old {
		t.Fatal("토픽을 다시 만들지 않았다")
	}
}

func TestBridgeAgentsPickOpensTopic(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.host.agents = []AgentInfo{{SessionID: sess, ToolID: tabA, Name: "API 리팩터", State: "working"}}
	r.msg(me, 0, "/agents")
	data := r.button(t, "API 리팩터")
	r.press(me, 0, data)
	if _, ok := r.st.Topic(sess); !ok {
		t.Fatal("목록에서 골랐는데 토픽이 없다")
	}
}

// ── 입력·버튼 (TC-TGB-30·32·60) ──

func TestBridgeTextPastesAndAttends(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	r.msg(me, r.thread(t), "테스트 돌려")
	if len(r.host.pastes) != 1 || r.host.pastes[0] != tabA+"|테스트 돌려" {
		t.Fatalf("붙여넣기: %v", r.host.pastes)
	}
	if len(r.host.attends) != 1 || r.host.attends[0] != tabA+"|typed" {
		t.Fatalf("알람 해제: %v", r.host.attends)
	}
}

func TestBridgePermissionButtonsSendRawKeys(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.act(Event{ToolID: tabA, SessionID: sess, State: "working", Hook: "PreToolUse", Tool: "Bash", ToolUseID: "tu1"})
	r.act(Event{ToolID: tabA, SessionID: sess, State: "waiting", Hook: "PermissionRequest", Tool: "Bash",
		Input: json.RawMessage(`{"command":"rm -rf build"}`)})
	body, _ := r.tg.last("sendMessage")
	if !strings.Contains(body["text"].(string), "rm -rf build") {
		t.Fatalf("요청 메시지에 명령이 없다: %v", body["text"])
	}
	r.press(me, r.thread(t), r.button(t, "허용"))
	if len(r.host.keys) != 1 || r.host.keys[0] != tabA+"|1" {
		t.Fatalf("원시 키: %v", r.host.keys)
	}
	if _, ok := r.tg.last("answerCallbackQuery"); !ok {
		t.Fatal("answerCallbackQuery 가 없다 (FR-TGB-34)")
	}
	if len(r.host.attends) == 0 || r.host.attends[len(r.host.attends)-1] != tabA+"|typed" {
		t.Fatalf("알람 해제: %v", r.host.attends)
	}
}

// PC 에서 먼저 답하면 휴대폰 버튼은 키를 넣지 않는다 (FR-TGB-43).
func TestBridgeStaleButtonDoesNothing(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.act(Event{ToolID: tabA, SessionID: sess, State: "working", Hook: "PreToolUse", Tool: "Bash", ToolUseID: "tu1"})
	r.act(Event{ToolID: tabA, SessionID: sess, State: "waiting", Hook: "PermissionRequest", Tool: "Bash",
		Input: json.RawMessage(`{"command":"ls"}`)})
	data := r.button(t, "허용")
	r.act(Event{ToolID: tabA, SessionID: sess, State: "working", Hook: "PostToolUse", Tool: "Bash", ToolUseID: "tu1"})
	r.press(me, r.thread(t), data)
	if len(r.host.keys) != 0 {
		t.Fatalf("끝난 요청에 키를 넣었다: %v", r.host.keys)
	}
}

func TestBridgeQuestionButtons(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	in := `{"questions":[{"question":"어떤 색?","header":"색","multiSelect":false,"options":[{"label":"red","description":"빨강"},{"label":"blue","description":"파랑"}]}]}`
	r.act(Event{ToolID: tabA, SessionID: sess, State: "working", Hook: "PreToolUse", Tool: "AskUserQuestion", ToolUseID: "tu2", Input: json.RawMessage(in)})
	r.act(Event{ToolID: tabA, SessionID: sess, State: "waiting", Hook: "PermissionRequest", Tool: "AskUserQuestion", Input: json.RawMessage(in)})
	n := 0
	for _, m := range r.tg.methods() {
		if m == "sendMessage" {
			n++
		}
	}
	r.press(me, r.thread(t), r.button(t, "blue"))
	if len(r.host.keys) != 1 || r.host.keys[0] != tabA+"|2" {
		t.Fatalf("원시 키: %v", r.host.keys)
	}
	// 질문 하나에 메시지는 하나다. 상태 메시지 + 질문 = 2.
	if n != 2 {
		t.Fatalf("sendMessage %d번, 기대 2 (질문이 겹쳐 갔다)", n)
	}
}

func TestBridgeReadButtonAttendsSeen(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	r.press(me, r.thread(t), r.button(t, "읽음"))
	if len(r.host.attends) != 1 || r.host.attends[0] != tabA+"|seen" {
		t.Fatalf("읽음 해제: %v", r.host.attends)
	}
}

func TestBridgeEscButton(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
	r.attn(tabA, "done")
	r.press(me, r.thread(t), r.button(t, "Esc"))
	if len(r.host.keys) != 1 || r.host.keys[0] != tabA+"|\x1b" {
		t.Fatalf("Esc: %q", r.host.keys)
	}
}

// ── 알림 (TC-TGB-40) ──

func TestBridgeSilenceAfterPCInput(t *testing.T) {
	r := newRig(t)
	r.start(tabA)
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
}

// ── 꺼짐 (TC-TGB-80) ──

func TestBridgeDisabledIsSilent(t *testing.T) {
	r := newRig(t)
	_ = r.st.SetEnabled(false)
	r.start(tabA)
	r.attn(tabA, "done")
	r.msg(me, 0, "/agents")
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
			r.b.OnActivity(Event{ToolID: tabA, SessionID: sess, State: "working"})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("OnActivity 가 막혔다")
	}
}
