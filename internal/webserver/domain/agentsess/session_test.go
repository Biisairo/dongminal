package agentsess

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/toolhub"
)

// M8_UNIFIED_SRS D-C-2·3 — 서버 해석층. 바이트(절대 오프셋) → 줄 → Proto.Decode →
// 이벤트 로그(seq) → 활동 보고 · SSE. 어댑터는 가짜다 — 이 층은 에이전트를 모른다
// (FR-U-1, V-13).

// fakeProto 는 한 줄이 곧 이벤트 하나인 장난감 프로토콜이다.
//
//	{"k":"init","sid":"s1"}           → session
//	{"k":"req","id":"r1"}             → approval_open
//	{"k":"txt","t":"PONG"}            → text_delta
//	{"k":"end"}                       → turn_end
//	그 밖                              → 모르는 프레임
func fakeProto() *agentadapter.Proto {
	return &agentadapter.Proto{
		Launch: func(o agentadapter.LaunchOpts) []string { return []string{o.Bin} },
		Handshake: func(o agentadapter.LaunchOpts, st *agentadapter.ProtoState) [][]byte {
			if o.Resume != "" {
				return [][]byte{[]byte(`{"hs":1,"resume":"` + o.Resume + `"}`)}
			}
			return [][]byte{[]byte(`{"hs":1}`)}
		},
		Decode: func(line []byte, st *agentadapter.ProtoState) ([]agentadapter.Event, bool) {
			var fr struct{ K, Sid, ID, T string }
			if err := json.Unmarshal(line, &fr); err != nil {
				return nil, false
			}
			switch fr.K {
			case "init":
				st.SessionID = fr.Sid
				return []agentadapter.Event{{Kind: agentadapter.EvSession, SessionID: fr.Sid}}, true
			case "req":
				ar := agentadapter.ApprovalRequest{ID: fr.ID, Kind: agentadapter.ApprovalPermission, Tool: "Bash", Detail: "rm -rf x",
					Options: []agentadapter.ApprovalOption{{ID: "allow", Label: "allow"}, {ID: "deny", Label: "deny"}}}
				st.Open[fr.ID] = ar
				return []agentadapter.Event{{Kind: agentadapter.EvApprovalOpen, Tool: ar.Tool, Detail: ar.Detail, Approval: &ar}}, true
			case "txt":
				return []agentadapter.Event{{Kind: agentadapter.EvTextDelta, Text: fr.T}}, true
			case "start":
				return []agentadapter.Event{{Kind: agentadapter.EvTurnStart}}, true
			case "end":
				return []agentadapter.Event{{Kind: agentadapter.EvTurnEnd, Text: "completed"}}, true
			case "quiet":
				return nil, true
			}
			return nil, false
		},
		Prompt: func(text string, st *agentadapter.ProtoState) [][]byte {
			return [][]byte{[]byte(`{"prompt":"` + text + `"}`)}
		},
		Approve: func(req agentadapter.ApprovalRequest, d agentadapter.Decision, st *agentadapter.ProtoState) ([]byte, error) {
			if _, ok := st.Open[req.ID]; !ok {
				return nil, agentadapter.ErrNotOpen
			}
			delete(st.Open, req.ID)
			return []byte(`{"approve":"` + req.ID + `","choice":"` + d.Choice + `"}`), nil
		},
		Interrupt: func(st *agentadapter.ProtoState) []byte { return []byte(`{"interrupt":1}`) },
		Control: func(op agentadapter.ControlOp, st *agentadapter.ProtoState) ([]byte, error) {
			if op.Kind != "set_model" {
				return nil, agentadapter.ErrUnsupported
			}
			return []byte(`{"model":"` + op.Value + `"}`), nil
		},
		TUIResume: func(sid string) []string { return []string{"fake", "--resume", sid} },
	}
}

type fakeSink struct {
	mu       sync.Mutex
	events   []Logged
	activity []string
	writes   []string
	snap     []byte
	snapEnd  int64
}

func (f *fakeSink) Event(toolID string, le Logged) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, le)
}

func (f *fakeSink) Activity(toolID, state, tool, detail string, userPrompt bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := state
	if userPrompt {
		s += "+prompt"
	}
	if tool != "" {
		s += ":" + tool
	}
	f.activity = append(f.activity, s)
}

func (f *fakeSink) write(id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, strings.TrimRight(string(data), "\n"))
	return nil
}

func (f *fakeSink) snapshot(id string) (toolhub.ToolSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return toolhub.ToolSnapshot{Data: f.snap, End: f.snapEnd}, nil
}

func newMgr(t *testing.T) (*Manager, *fakeSink) {
	t.Helper()
	f := &fakeSink{}
	m := New(Deps{Sink: f, Write: f.write, Snapshot: f.snapshot, LogCap: 8})
	return m, f
}

func openFake(t *testing.T, m *Manager) *Session {
	t.Helper()
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	s, err := m.Open("tool-1", ad, agentadapter.LaunchOpts{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func feed(m *Manager, s string, end int64) bool {
	return m.Feed("tool-1", []byte(s), end)
}

func kindsOf(evs []Logged) string {
	var out []string
	for _, e := range evs {
		out = append(out, string(e.Ev.Kind))
	}
	return strings.Join(out, ",")
}

// D-C-2: 열면 핸드셰이크가 나가고, 프레임은 줄 단위로 해석되며, 활동이 파생된다.
func TestSession_HandshakeLinesActivity(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	if len(f.writes) != 1 || f.writes[0] != `{"hs":1}` {
		t.Fatalf("핸드셰이크: %v", f.writes)
	}
	// 줄이 청크 경계와 무관하다 — 한 줄이 두 청크에 걸친다.
	line := `{"k":"init","sid":"s1"}` + "\n"
	if !feed(m, line[:7], 7) || !feed(m, line[7:], int64(len(line))) {
		t.Fatal("에이전트 도구의 바이트는 해석층이 받는다")
	}
	if kindsOf(f.events) != "session" || f.events[0].Ev.SessionID != "s1" {
		t.Fatalf("session: %s", kindsOf(f.events))
	}
	if strings.Join(f.activity, " ") != "idle" {
		t.Fatalf("session → idle 활동 보고: %v", f.activity)
	}
	if m.Get("tool-1").SessionID() != "s1" {
		t.Fatal("세션 신원")
	}
	// 모르는 도구의 바이트는 받지 않는다 — 호출자가 터미널 경로로 넘긴다.
	if m.Feed("tool-x", []byte("x"), 1) {
		t.Fatal("모르는 도구를 받았다")
	}
}

// FR-APS-8: 모르는 프레임은 원문으로 남고(raw), 아는 조용한 프레임은 이벤트가 없다.
func TestSession_UnknownIsRaw(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	off := int64(0)
	push := func(s string) {
		off += int64(len(s))
		feed(m, s, off)
	}
	push(`{"k":"quiet"}` + "\n")
	push(`{"weird":true}` + "\n")
	push("not json\n")
	if kindsOf(f.events) != "raw,raw" {
		t.Fatalf("%s", kindsOf(f.events))
	}
	if string(f.events[0].Ev.Raw) != `{"weird":true}` || f.events[1].Ev.Text != "not json" {
		t.Fatalf("원문: %s / %q", f.events[0].Ev.Raw, f.events[1].Ev.Text)
	}
	if len(f.activity) != 0 {
		t.Fatalf("모르는 프레임은 활동을 말하지 않는다: %v", f.activity)
	}
}

// FR-APS-5·6 · FR-AAL-3·4: 열린 요청은 세션에 남고, 알람은 waiting + Detail 로 선다.
// 답은 프레임 하나이고 approval_closed 가 로그에 남는다.
func TestSession_Approval(t *testing.T) {
	m, f := newMgr(t)
	s := openFake(t, m)
	off := int64(0)
	push := func(str string) { off += int64(len(str)); feed(m, str, off) }
	push(`{"k":"init","sid":"s1"}` + "\n")
	s.Prompt("do it")
	push(`{"k":"start"}` + "\n")
	push(`{"k":"req","id":"r1"}` + "\n")
	if kindsOf(f.events) != "session,user,turn_start,approval_open" {
		t.Fatalf("%s", kindsOf(f.events))
	}
	if got := strings.Join(f.activity, " "); got != "idle working+prompt working waiting:Bash" {
		t.Fatalf("활동 보고: %q", got)
	}
	open := s.Open()
	if len(open) != 1 || open[0].ID != "r1" || open[0].Detail != "rm -rf x" {
		t.Fatalf("열린 요청: %+v", open)
	}
	// 서버는 대신 답하지 않는다 — 답이 오기 전에는 그대로 열려 있다 (FR-APS-6).
	if err := s.Approve("nope", agentadapter.Decision{Choice: "allow"}); !errors.Is(err, agentadapter.ErrNotOpen) {
		t.Fatalf("모르는 요청: %v", err)
	}
	if err := s.Approve("r1", agentadapter.Decision{Choice: "allow"}); err != nil {
		t.Fatal(err)
	}
	if f.writes[len(f.writes)-1] != `{"approve":"r1","choice":"allow"}` {
		t.Fatalf("응답 프레임: %v", f.writes)
	}
	if len(s.Open()) != 0 {
		t.Fatal("답한 요청이 남았다")
	}
	last := f.events[len(f.events)-1]
	if last.Ev.Kind != agentadapter.EvApprovalClosed || last.Ev.Approval == nil || last.Ev.Approval.ID != "r1" || last.Ev.Text != "allow" {
		t.Fatalf("approval_closed: %+v", last.Ev)
	}
	if f.activity[len(f.activity)-1] != "working" {
		t.Fatalf("답한 뒤는 working: %v", f.activity)
	}
	push(`{"k":"end"}` + "\n")
	if f.activity[len(f.activity)-1] != "done" {
		t.Fatalf("turn_end → done: %v", f.activity)
	}
}

// D-C-3 · NFR-C-2: 이벤트 로그는 seq 로 재생되고, 상한을 넘으면 앞이 잘리며 그 사실을 말한다.
func TestSession_ReplayAndCap(t *testing.T) {
	m, f := newMgr(t)
	s := openFake(t, m)
	off := int64(0)
	for i := 0; i < 12; i++ {
		str := `{"k":"txt","t":"` + strings.Repeat("x", i+1) + `"}` + "\n"
		off += int64(len(str))
		feed(m, str, off)
	}
	all, trunc := s.Events(0)
	if !trunc || len(all) != 8 || all[0].Seq != 5 || all[7].Seq != 12 {
		t.Fatalf("상한 8: n=%d trunc=%v first=%d", len(all), trunc, all[0].Seq)
	}
	tail, trunc := s.Events(10)
	if trunc || len(tail) != 2 || tail[0].Seq != 11 {
		t.Fatalf("since=10: n=%d trunc=%v", len(tail), trunc)
	}
	// since=4 는 "4 까지 보았다" — 다음 5 가 있으므로 빠진 것이 없다.
	if _, trunc := s.Events(4); trunc {
		t.Fatal("빠진 것이 없는데 truncated 다")
	}
	if _, trunc := s.Events(3); !trunc {
		t.Fatal("잘린 앞을 가리키는 since 는 truncated 다")
	}
	if len(f.events) != 12 || f.events[11].Seq != 12 {
		t.Fatalf("싱크는 전부 받았다: %d", len(f.events))
	}
}

// D-C-2 "틈": 청크 사이가 비면 스냅샷으로 되메운다 — **비동기로** (P5: 이 자리는 데몬 모드의
// readLoop 안이라 동기 RPC 를 걸 수 없다). 그 청크는 버리고 스냅샷이 대신 가져온다. 겹치면 겹친
// 만큼 버린다.
func TestSession_GapAndOverlap(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	a := `{"k":"txt","t":"a"}` + "\n"
	b := `{"k":"txt","t":"b"}` + "\n"
	c := `{"k":"txt","t":"c"}` + "\n"
	f.mu.Lock()
	f.snap, f.snapEnd = []byte(a+b+c), int64(len(a+b+c))
	f.mu.Unlock()
	feed(m, a, int64(len(a)))
	// b 를 건너뛰고 c 가 온다 → 스냅샷에서 b·c 를 채운다 (c 청크 자체는 버려진다).
	feed(m, c, int64(len(a+b+c)))
	waitFor(t, "되메움", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.events) == 3 })
	// 겹침: a 가 다시 온다 → 버린다.
	feed(m, a, int64(len(a)))
	var texts []string
	f.mu.Lock()
	for _, e := range f.events {
		texts = append(texts, e.Ev.Text)
	}
	f.mu.Unlock()
	if strings.Join(texts, "") != "abc" {
		t.Fatalf("순서·중복: %v", texts)
	}
}

// 열 때 스냅샷을 먼저 읽는다 — 세션이 붙기 전에 나온 첫 프레임(init)을 놓치지 않는다.
func TestSession_OpenResyncsFromSnapshot(t *testing.T) {
	m, f := newMgr(t)
	f.snap = []byte(`{"k":"init","sid":"early"}` + "\n")
	f.snapEnd = int64(len(f.snap))
	s := openFake(t, m)
	if s.SessionID() != "early" || kindsOf(f.events) != "session" {
		t.Fatalf("스냅샷 되메움: sid=%q %s", s.SessionID(), kindsOf(f.events))
	}
}

// FR-ABG-20: 프로세스가 끝나면 exit 이벤트와 ended 활동. 세션은 **남는다** — 오류 상태다
// (P5 D-C-11; P3 는 여기서 세션을 지웠다). 신원이 없으면 재개할 길도 없다.
func TestSession_Exit(t *testing.T) {
	m, f := newMgr(t)
	openFake(t, m)
	m.Exit("tool-1", toolhub.ExitInfo{})
	if kindsOf(f.events) != "exit" || f.activity[len(f.activity)-1] != "ended" {
		t.Fatalf("%s %v", kindsOf(f.events), f.activity)
	}
	s := m.Get("tool-1")
	if s == nil {
		t.Fatal("끝난 세션이 사라졌다")
	}
	if st := s.State(); st.Dormant != DormantError || st.Resumable {
		t.Fatalf("신원 없는 죽음: %+v", st)
	}
	if !m.Feed("tool-1", []byte("x"), 1) {
		t.Fatal("끝난 세션의 바이트가 터미널 경로로 샜다")
	}
}

// FR-AGT-11 · FR-AGT-4a: 제어와 인터럽트는 어댑터 프레임으로 나간다; 없는 제어는 오류다.
func TestSession_ControlInterrupt(t *testing.T) {
	m, f := newMgr(t)
	s := openFake(t, m)
	if err := s.Control(agentadapter.ControlOp{Kind: "set_model", Value: "z"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Control(agentadapter.ControlOp{Kind: "login"}); !errors.Is(err, agentadapter.ErrUnsupported) {
		t.Fatalf("없는 제어: %v", err)
	}
	if err := s.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.writes, " "); !strings.Contains(got, `{"model":"z"}`) || !strings.Contains(got, `{"interrupt":1}`) {
		t.Fatalf("프레임: %v", f.writes)
	}
	if strings.Join(s.TUIResume(), " ") != "fake --resume " {
		t.Fatalf("TUIResume 은 세션 신원을 싣는다: %v", s.TUIResume())
	}
}

// 상태 스냅샷: 모델·권한 모드·사용량·활동은 마지막 값으로 합쳐진다.
func TestSession_StateMerges(t *testing.T) {
	m, _ := newMgr(t)
	ad := agentadapter.Adapter{ID: "fake", Proto: fakeProto()}
	ad.Proto.Decode = func(line []byte, st *agentadapter.ProtoState) ([]agentadapter.Event, bool) {
		switch strings.TrimSpace(string(line)) {
		case "m":
			return []agentadapter.Event{{Kind: agentadapter.EvStatus, Status: &agentadapter.ProtoStatus{Model: "m1", Models: []agentadapter.ModelChoice{{Value: "m1"}}}}}, true
		case "p":
			return []agentadapter.Event{{Kind: agentadapter.EvStatus, Status: &agentadapter.ProtoStatus{PermissionMode: "plan"}}}, true
		case "u":
			return []agentadapter.Event{{Kind: agentadapter.EvUsage, Usage: &agentadapter.ProtoUsage{Tokens: 10, Model: "m1"}}}, true
		case "u2":
			return []agentadapter.Event{{Kind: agentadapter.EvUsage, Usage: &agentadapter.ProtoUsage{Tokens: 20, ContextWindow: 100, CostUSD: 0.5}}}, true
		}
		return nil, false
	}
	s, err := m.Open("tool-1", ad, agentadapter.LaunchOpts{})
	if err != nil {
		t.Fatal(err)
	}
	off := int64(0)
	for _, l := range []string{"m\n", "p\n", "u\n", "u2\n"} {
		off += int64(len(l))
		feed(m, l, off)
	}
	st := s.State()
	if st.Status.Model != "m1" || st.Status.PermissionMode != "plan" || len(st.Status.Models) != 1 {
		t.Fatalf("status 합침: %+v", st.Status)
	}
	if st.Usage.Tokens != 20 || st.Usage.ContextWindow != 100 || st.Usage.CostUSD != 0.5 || st.Usage.Model != "m1" {
		t.Fatalf("usage 합침 — 채워진 것만 덮는다: %+v", st.Usage)
	}
	if st.Agent != "fake" || len(st.PermissionModes) != 0 {
		t.Fatalf("어댑터 정보: %+v", st)
	}
}
