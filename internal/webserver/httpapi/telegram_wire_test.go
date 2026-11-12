package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func (r *tgRec) OnAttentionClear(toolID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attn = append(r.attn, toolID+":clear")
}

func (r *tgRec) events() []telegram.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]telegram.Event(nil), r.evs...)
}

// tgServer 는 도구 p1(윈도우 "작업창", 탭 "작업탭")과 브리지 기록기를 가진 서버다.
func tgServer(t *testing.T, enabled bool) (*Server, *tgRec) {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	m.AdoptDetached("p1")
	io := newFakeToolIO()
	io.setHas("p1", true)
	wi := &fakeWorkIndex{entries: []toolaccess.WorkspaceEntry{{ToolID: "p1", WindowName: "작업창", TabName: "작업탭"}}}
	st := telegram.OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	if err := st.SetEnabled(enabled); err != nil {
		t.Fatal(err)
	}
	rec := &tgRec{}
	s := &Server{Deps: Deps{Tools: m, ToolIO: io, WorkIndex: wi}, limits: defaultLimits()}
	s.tg = newTelegramWire(st, rec)
	return s, rec
}

// FR-TGB-80·81: main 보고는 브리지 사건으로 옮겨진다. 서브에이전트 보고는 넘기지 않는다.
func TestTelegramWire_ForwardsMainReports(t *testing.T) {
	s, rec := tgServer(t, true)
	in := json.RawMessage(`{"command":"ls"}`)
	if code := s.applyActivityReport(agentrec.ActivityReport{
		ToolID: "p1", State: "waiting", Tool: "Bash", Detail: "ls", SessionID: "S1",
		Hook: "PermissionRequest", Input: in, InputOver: true, Transcript: "/t/x.jsonl",
	}); code != "" {
		t.Fatalf("code=%s", code)
	}
	evs := rec.events()
	if len(evs) != 1 || evs[0].ToolID != "p1" || evs[0].Hook != "PermissionRequest" || evs[0].Tool != "Bash" ||
		evs[0].Detail != "ls" || string(evs[0].Input) != string(in) || !evs[0].InputOver || evs[0].Transcript != "/t/x.jsonl" {
		t.Fatalf("evs=%+v", evs)
	}
	if code := s.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "working", AgentID: "a1", SessionID: "S1"}); code != "" {
		t.Fatalf("sub code=%s", code)
	}
	if got := rec.events(); len(got) != 1 {
		t.Fatalf("서브에이전트 보고가 넘어갔다: %+v", got)
	}
}

// FR-TGB-82 · NFR-TGB-1: 꺼져 있으면 넘기지 않는다.
func TestTelegramWire_OffForwardsNothing(t *testing.T) {
	s, rec := tgServer(t, false)
	s.applyActivityReport(agentrec.ActivityReport{ToolID: "p1", State: "working", SessionID: "S1"})
	if got := rec.events(); len(got) != 0 {
		t.Fatalf("꺼짐인데 넘겼다: %+v", got)
	}
}

// FR-TGB-56 · D-TGB-17 · TC-TGB-44·46: 위치는 페이지 제목 › 윈도우 › 탭 이다.
func TestTelegramHost(t *testing.T) {
	s, _ := tgServer(t, true)
	h := telegramHost{s}
	host, _ := os.Hostname()
	if got := h.Location("p1"); got != (telegram.Location{Device: host, Window: "작업창", Tab: "작업탭"}) {
		t.Fatalf("설정 없음 Location=%+v", got)
	}
	s.Settings = &fakeSettingsStore{blob: []byte(`{"pageTitle":"  office  "}`)}
	if got := h.Location("p1"); got.Device != "office" {
		t.Fatalf("페이지 제목을 쓰지 않았다: %+v", got)
	}
	s.Settings = &fakeSettingsStore{blob: []byte(`{"pageTitle":"  "}`)}
	if got := h.Location("p1"); got.Device != host {
		t.Fatalf("빈 페이지 제목인데 호스트 이름이 아니다: %+v", got)
	}
	if got := h.Location("zz"); got != (telegram.Location{Device: host, Tab: "zz"}) {
		t.Fatalf("모르는 도구 Location=%+v", got)
	}
	// FR-TGB-58a: 읽음은 포커스와 같은 해제다.
	s.attention().SignalAttention("p1", "bell")
	if !s.Tools.Get("p1").Attention() {
		t.Fatal("알람이 서지 않았다")
	}
	h.Attend("p1", false)
	if s.Tools.Get("p1").Attention() {
		t.Fatal("읽음으로 알람이 꺼지지 않았다")
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
	s.attention().Attend("p1", false)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.attn) != 2 || rec.attn[0] != "p1:bell" || rec.attn[1] != "p1:clear" {
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
