package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/telegram"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/seam/toolaccess"
)

// tgRec 는 브리지 자리에 꽂는 기록기다.
type tgRec struct {
	mu   sync.Mutex
	evs  []telegram.Event
	attn []string
}

func (r *tgRec) OnActivity(ev telegram.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, ev)
}

func (r *tgRec) OnAttention(toolID, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attn = append(r.attn, toolID+":"+reason)
}

func (r *tgRec) events() []telegram.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]telegram.Event(nil), r.evs...)
}

// tgServer 는 도구 p1(탭 이름 "작업탭")과 브리지 기록기를 가진 서버다.
func tgServer(t *testing.T, enabled bool) (*Server, *fakeToolIO, *tgRec) {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	m.AdoptDetached("p1")
	io := newFakeToolIO()
	io.setHas("p1", true)
	wi := &fakeWorkIndex{entries: []toolaccess.WorkspaceEntry{{ToolID: "p1", TabName: "작업탭"}}}
	st := telegram.OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	if err := st.SetEnabled(enabled); err != nil {
		t.Fatal(err)
	}
	rec := &tgRec{}
	s := &Server{Deps: Deps{Tools: m, ToolIO: io, WorkIndex: wi}, limits: defaultLimits()}
	s.tg = newTelegramWire(st, rec)
	return s, io, rec
}

// FR-TGB-80·81: main 보고는 브리지 사건으로 옮겨진다. 서브에이전트 보고는 넘기지 않는다.
func TestTelegramWire_ForwardsMainReports(t *testing.T) {
	s, _, rec := tgServer(t, true)
	in := json.RawMessage(`{"command":"ls"}`)
	if code := s.applyActivityReport(agentrec.ActivityReport{
		ToolID: "p1", State: "waiting", Tool: "Bash", Detail: "ls", SessionID: "S1",
		Hook: "PermissionRequest", ToolUseID: "u1", Source: "startup", Input: in, InputOver: false,
		Transcript: "/t/x.jsonl",
	}); code != "" {
		t.Fatalf("code=%s", code)
	}
	evs := rec.events()
	want := telegram.Event{ToolID: "p1", SessionID: "S1", State: "waiting", Hook: "PermissionRequest",
		ToolUseID: "u1", Source: "startup", Tool: "Bash", Detail: "ls", Input: in, Transcript: "/t/x.jsonl"}
	if len(evs) != 1 || evs[0].ToolID != want.ToolID || evs[0].SessionID != want.SessionID ||
		evs[0].State != want.State || evs[0].Hook != want.Hook || evs[0].ToolUseID != want.ToolUseID ||
		evs[0].Source != want.Source || evs[0].Tool != want.Tool || evs[0].Detail != want.Detail ||
		string(evs[0].Input) != string(want.Input) || evs[0].Transcript != want.Transcript {
		t.Fatalf("evs=%+v", evs)
	}
	if code := s.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "working", AgentID: "a1", SessionID: "S1"}); code != "" {
		t.Fatalf("sub code=%s", code)
	}
	if got := rec.events(); len(got) != 1 {
		t.Fatalf("서브에이전트 보고가 넘어갔다: %+v", got)
	}
}

// FR-TGB-82 · NFR-TGB-1: 꺼져 있으면 넘기지도, session_id 를 기억하지도 않는다.
func TestTelegramWire_OffForwardsAndStoresNothing(t *testing.T) {
	s, _, rec := tgServer(t, false)
	s.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "working", SessionID: "S1"})
	if got := rec.events(); len(got) != 0 {
		t.Fatalf("꺼짐인데 넘겼다: %+v", got)
	}
	for _, a := range (telegramHost{s}).Agents() {
		if a.SessionID != "" {
			t.Fatalf("꺼짐인데 session_id 를 기억했다: %+v", a)
		}
	}
}

// FR-TGB-30·31·32·23: Host 는 서버의 기존 문을 지난다.
func TestTelegramHost(t *testing.T) {
	s, io, _ := tgServer(t, true)
	h := telegramHost{s}
	if err := h.Paste("p1", "안녕"); err != nil {
		t.Fatal(err)
	}
	if len(io.pastes) != 1 || io.pastes[0] != (fakePaste{ToolID: "p1", Text: "안녕", Submit: true}) {
		t.Fatalf("pastes=%+v", io.pastes)
	}
	if err := h.Keys("p1", []byte{0x1b}); err != nil {
		t.Fatal(err)
	}
	if len(io.writes) != 1 || io.writes[0] != "p1:\x1b" {
		t.Fatalf("writes=%q", io.writes)
	}
	if got := h.ToolName("p1"); got != "작업탭" {
		t.Fatalf("ToolName=%q", got)
	}
	if got := h.ToolName("zz"); got != "zz" {
		t.Fatalf("모르는 도구 ToolName=%q", got)
	}
	io.snap["p1"] = []byte("\x1b[31mred\x1b[0m\r\n")
	if got := h.Screen("p1"); got != "red\n" {
		t.Fatalf("Screen=%q", got)
	}
	io.snap["p1"] = []byte(strings.Repeat("a", 3*telegramScreenTail))
	if got := h.Screen("p1"); len(got) != telegramScreenTail {
		t.Fatalf("Screen 길이=%d", len(got))
	}
	if got := h.Screen("zz"); got != "" {
		t.Fatalf("없는 도구 Screen=%q", got)
	}

	s.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "waiting", SessionID: "S1"})
	ag := h.Agents()
	if len(ag) != 1 || ag[0] != (telegram.AgentInfo{SessionID: "S1", ToolID: "p1", Name: "작업탭", State: "waiting"}) {
		t.Fatalf("Agents=%+v", ag)
	}
	before := time.Now()
	s.browserIn.mark("p1")
	if got := h.LastBrowserInput("p1"); got.Before(before) {
		t.Fatalf("LastBrowserInput=%v", got)
	}
}

// FR-TGB-50: 알람 판정은 브리지에도 간다 (직접 모드의 실제 콜백 경로).
func TestTelegramWire_AttentionObserver(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	cmd := hub.NewCommandHub()
	hub.WireAttention(m, cmd)
	m.AdoptDetached("p1")
	st := telegram.OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	_ = st.SetEnabled(true)
	rec := &tgRec{}
	s := &Server{Deps: Deps{Tools: m, Commands: cmd}, limits: defaultLimits()}
	s.tg = newTelegramWire(st, rec)
	s.wireTelegramAttention()
	s.attention().SignalAttention("p1", "bell")
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.attn) != 1 || rec.attn[0] != "p1:bell" {
		t.Fatalf("attn=%v", rec.attn)
	}
}

// NFR-TGB-1 · TC-TGB-80: 꺼져 있으면(기본값) 서버를 띄우고 보고·알람이 와도 Telegram
// 요청이 0건이다.
func TestTelegramWire_OffSendsNoRequests(t *testing.T) {
	var hits atomic.Int64
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true,"result":[]}`))
	}))
	defer fake.Close()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	m.AdoptDetached("p1")
	srv, err := New(Config{DataDir: t.TempDir(), TelegramAPI: fake.URL}, Deps{Tools: m})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartTelegram(stop)
	srv.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "waiting", SessionID: "S1", Hook: "Stop"})
	srv.tg.sink.OnAttention("p1", "done")
	time.Sleep(300 * time.Millisecond)
	close(stop)
	<-done
	if n := hits.Load(); n != 0 {
		t.Fatalf("꺼짐인데 Telegram 요청 %d건", n)
	}
}
