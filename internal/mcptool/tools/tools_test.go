package tools

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/mcptool"
)

type fakePaneReader struct {
	panes    []mcptool.PaneInfo
	has      map[string]bool
	snap     map[string][]byte
	dropped  int64
	pasteErr error
	pastes   []string
}

func newFakePaneReader() *fakePaneReader {
	return &fakePaneReader{has: map[string]bool{}, snap: map[string][]byte{}}
}

func (f *fakePaneReader) List() []mcptool.PaneInfo { return f.panes }
func (f *fakePaneReader) Has(id string) bool       { return f.has[id] }
func (f *fakePaneReader) Snapshot(id string) ([]byte, int64, bool) {
	d, ok := f.snap[id]
	return d, f.dropped, ok
}
func (f *fakePaneReader) SendPaste(id string, text []byte, submit bool) error {
	f.pastes = append(f.pastes, string(text))
	return f.pasteErr
}
func (f *fakePaneReader) Size(string) string { return "80x24" }

type fakeWorkspaceReader struct {
	entries []mcptool.WorkspaceEntry
	labels  map[string]string
	resolve map[string]string
	coords  map[string]string
}

func (f *fakeWorkspaceReader) Resolve(id string) (string, error) {
	if v, ok := f.resolve[id]; ok {
		return v, nil
	}
	return "", errors.New("not found: " + id)
}
func (f *fakeWorkspaceReader) Labels() map[string]string         { return f.labels }
func (f *fakeWorkspaceReader) Entries() []mcptool.WorkspaceEntry { return f.entries }
func (f *fakeWorkspaceReader) CoordinateOf(id string) (string, error) {
	if v, ok := f.coords[id]; ok {
		return v, nil
	}
	return id, nil
}
func (f *fakeWorkspaceReader) IsKnownTabID(id string) bool {
	if id == "" {
		return false
	}
	_, ok := f.coords[id]
	return ok
}

// dispatch is a small helper that mirrors the production wiring: register the
// handler under a fresh registry and dispatch a JSON payload through it. This
// exercises the same path the real MCP server uses, while keeping per-test
// setup terse.
func dispatch[A any](t *testing.T, name string, spec map[string]any, h func(context.Context, A) (mcptool.Result, error), payload string) (mcptool.Result, error) {
	t.Helper()
	reg := mcptool.NewRegistry()
	mcptool.Register(reg, name, spec, h)
	var raw json.RawMessage
	if payload != "" {
		raw = json.RawMessage(payload)
	}
	return reg.Dispatch(context.Background(), name, raw)
}

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

func TestListPanes_Empty(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{}
	if ListPanesName != "list_panes" {
		t.Errorf("name=%q", ListPanesName)
	}
	if ListPanesSpec["name"] != "list_panes" {
		t.Errorf("spec name=%v", ListPanesSpec["name"])
	}
	res, err := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}), "")
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	body := resultText(res)
	if !strings.Contains(body, "(없음)") {
		t.Errorf("body=%q", body)
	}
}

func TestListPanes_Mixed(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{
		{ID: "1", Name: "Shell #1", ShellPID: 100},
		{ID: "2", Name: "Orphan", ShellPID: 200},
	}
	pr.has["1"] = true
	pr.has["2"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{
			{PaneID: "1", Label: "S1.P1.T1", SessionName: "Main", TabName: "Shell", IsActive: true},
		},
	}
	res, _ := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}), "")
	body := resultText(res)
	if !strings.Contains(body, "▶ label=S1.P1.T1") {
		t.Errorf("missing focus marker: %q", body)
	}
	if !strings.Contains(body, "[workspace 미등록]") || !strings.Contains(body, `paneId=2`) {
		t.Errorf("missing orphan section: %q", body)
	}
	if !strings.Contains(body, "shellPid=100") {
		t.Errorf("missing shell pid: %q", body)
	}
}

// TC-LPF-6: MCP session 필터 — 매칭 행만 + orphan 섹션 생략.
func TestListPanes_SessionFilter(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{
		{ID: "1", Name: "Shell #1", ShellPID: 100},
		{ID: "2", Name: "Orphan", ShellPID: 200},
	}
	pr.has["1"] = true
	pr.has["2"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{
			{PaneID: "1", Label: "S1.P1.T1", SessionName: "poem-critique", TabName: "writer"},
		},
	}
	res, _ := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}),
		`{"session":"POEM"}`)
	body := resultText(res)
	if !strings.Contains(body, `session="poem-critique"`) {
		t.Errorf("missing match: %q", body)
	}
	if strings.Contains(body, "[workspace 미등록]") {
		t.Errorf("orphan section should be omitted with filter: %q", body)
	}
}

// TC-LPF-7: MCP 필터 0건 → "(매칭 없음" 텍스트, 에러 아님.
func TestListPanes_FilterNoMatch(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{{ID: "1", Name: "Shell", ShellPID: 100}}
	pr.has["1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{
			{PaneID: "1", Label: "S1.P1.T1", SessionName: "Main", TabName: "Shell"},
		},
	}
	res, err := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}),
		`{"tab":"nomatch"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(resultText(res), "매칭 없음") {
		t.Errorf("body=%q", resultText(res))
	}
}

func TestListPanes_DropsStaleEntries(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{{ID: "1", Name: "Shell"}}
	pr.has["1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{
			{PaneID: "1", Label: "S1.P1.T1"},
			{PaneID: "ghost", Label: "S1.P1.T2"},
		},
	}
	res, _ := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}), "")
	body := resultText(res)
	if strings.Contains(body, "ghost") {
		t.Errorf("stale entry leaked: %q", body)
	}
}

func resultText(res mcptool.Result) string {
	content, _ := res["content"].([]map[string]any)
	var sb strings.Builder
	for _, c := range content {
		if c["type"] == "text" {
			if t, ok := c["text"].(string); ok {
				sb.WriteString(t)
			}
		}
	}
	return sb.String()
}

func TestSendInput_Resolves(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{resolve: map[string]string{"S1.P1.T1": "10"}}
	if SendInputName != "send_input" {
		t.Errorf("name=%q", SendInputName)
	}
	res, err := dispatch(t, SendInputName, SendInputSpec,
		SendInputHandler(SendInputDeps{PM: pr, WS: wr}),
		`{"id":"S1.P1.T1","text":"echo hi","execute":true}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !strings.Contains(resultText(res), "pane=10") {
		t.Errorf("body=%q", resultText(res))
	}
	if len(pr.pastes) != 1 || pr.pastes[0] != "echo hi" {
		t.Errorf("pastes=%v", pr.pastes)
	}
}

func TestSendInput_UnknownLabel(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{}
	if _, err := dispatch(t, SendInputName, SendInputSpec,
		SendInputHandler(SendInputDeps{PM: pr, WS: wr}),
		`{"id":"BAD","text":"x"}`); err == nil {
		t.Errorf("err=nil, expected resolve failure")
	}
}

func TestSendInput_MissingPane(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{resolve: map[string]string{"S1.P1.T1": "99"}}
	if _, err := dispatch(t, SendInputName, SendInputSpec,
		SendInputHandler(SendInputDeps{PM: pr, WS: wr}),
		`{"id":"S1.P1.T1","text":"x"}`); err == nil {
		t.Errorf("err=nil, expected pane missing")
	}
}

func TestReadPaneOutput_NoPane(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "1"}}
	if _, err := dispatch(t, ReadPaneOutputName, ReadPaneOutputSpec,
		ReadPaneOutputHandler(ReadPaneDeps{PM: pr, WS: wr}),
		`{"id":"x"}`); err == nil {
		t.Errorf("err=nil")
	}
}

func TestReadPaneScreen_StripsANSI(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["1"] = true
	pr.snap["1"] = []byte("\x1b[32mhello\x1b[0m world\n")
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "1"}}
	res, err := dispatch(t, ReadPaneScreenName, ReadPaneScreenSpec,
		ReadPaneScreenHandler(ReadPaneDeps{PM: pr, WS: wr}),
		`{"id":"x"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	body := resultText(res)
	if strings.Contains(body, "\x1b") {
		t.Errorf("ANSI escape leaked: %q", body)
	}
	if !strings.Contains(body, "hello world") {
		t.Errorf("expected hello world in: %q", body)
	}
}

func TestReadPaneOutput_KeepsANSI(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["1"] = true
	pr.snap["1"] = []byte("\x1b[32mraw\x1b[0m")
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "1"}}
	res, _ := dispatch(t, ReadPaneOutputName, ReadPaneOutputSpec,
		ReadPaneOutputHandler(ReadPaneDeps{PM: pr, WS: wr}),
		`{"id":"x"}`)
	body := resultText(res)
	if !strings.Contains(body, "\x1b[32m") {
		t.Errorf("expected raw ANSI preserved: %q", body)
	}
}

func TestReadPaneScreen_DroppedPrefix(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["1"] = true
	pr.snap["1"] = []byte("ok")
	pr.dropped = 42
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "1"}}
	res, _ := dispatch(t, ReadPaneScreenName, ReadPaneScreenSpec,
		ReadPaneScreenHandler(ReadPaneDeps{PM: pr, WS: wr}),
		`{"id":"x"}`)
	body := resultText(res)
	if !strings.HasPrefix(body, "dropped_bytes: 42") {
		t.Errorf("missing dropped prefix: %q", body)
	}
}

func TestReadPaneScreen_BytesTrim(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["1"] = true
	pr.snap["1"] = []byte("0123456789abcdef")
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "1"}}
	res, _ := dispatch(t, ReadPaneScreenName, ReadPaneScreenSpec,
		ReadPaneScreenHandler(ReadPaneDeps{PM: pr, WS: wr}),
		`{"id":"x","bytes":4}`)
	body := resultText(res)
	if body != "cdef" {
		t.Errorf("body=%q want cdef", body)
	}
}

func TestSendAgentMessage_Wraps(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{
		resolve: map[string]string{"S2.P1.T1": "10"},
		labels:  map[string]string{"10": "S2.P1.T1"},
	}
	if SendAgentMessageName != "send_agent_message" {
		t.Errorf("name=%q", SendAgentMessageName)
	}
	res, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"S2.P1.T1","from":"S1.P1.T1","message":"hello"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !strings.Contains(resultText(res), "S2.P1.T1") {
		t.Errorf("body=%q", resultText(res))
	}
	if len(pr.pastes) != 1 {
		t.Fatalf("pastes=%v", pr.pastes)
	}
	envelope := pr.pastes[0]
	if !strings.Contains(envelope, "[DONGMINAL-AGENT-MSG from=S1.P1.T1") {
		t.Errorf("envelope missing from: %q", envelope)
	}
	if !strings.Contains(envelope, "[/DONGMINAL-AGENT-MSG]") {
		t.Errorf("envelope missing close: %q", envelope)
	}
	if !strings.Contains(envelope, "hello") {
		t.Errorf("envelope missing message: %q", envelope)
	}
}

func TestSendAgentMessage_DefaultFrom(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "10"}}
	_, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"x","from":"","message":"m"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !strings.Contains(pr.pastes[0], "from=unknown") {
		t.Errorf("expected unknown default: %q", pr.pastes[0])
	}
}

func TestSendAgentMessage_MissingPane(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{resolve: map[string]string{"x": "99"}}
	if _, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"x","from":"a","message":"b"}`); err == nil {
		t.Errorf("err=nil")
	}
}

type fakeResolver struct {
	pid    string
	shell  int
	resErr error
}

func (f fakeResolver) ResolveClientPane(string) (string, int, error) {
	return f.pid, f.shell, f.resErr
}

func TestWhoAmI_NoRemoteAddr(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{}})
	if _, err := h(context.Background(), WhoAmIArgs{}); err == nil {
		t.Errorf("err=nil, expected SSE missing")
	}
}

func TestWhoAmI_WithEntry(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{
			{PaneID: "1", Label: "S1.P1.T1", SessionName: "Main", TabName: "Shell"},
		},
	}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{pid: "1", shell: 100}})
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:1234")
	res, err := h(ctx, WhoAmIArgs{})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	body := resultText(res)
	if !strings.Contains(body, "S1.P1.T1") || !strings.Contains(body, "shellPid=100") {
		t.Errorf("body=%q", body)
	}
}

func TestWhoAmI_NoEntry(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{pid: "1", shell: 100}})
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:1234")
	res, _ := h(ctx, WhoAmIArgs{})
	body := resultText(res)
	if !strings.Contains(body, "workspace 미등록") {
		t.Errorf("body=%q", body)
	}
}

func TestWhoAmI_ResolveError(t *testing.T) {
	pr := newFakePaneReader()
	wr := &fakeWorkspaceReader{}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{resErr: errors.New("boom")}})
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:1234")
	if _, err := h(ctx, WhoAmIArgs{}); err == nil {
		t.Errorf("err=nil")
	}
}

type fakeBroadcaster struct {
	allowed       map[string]bool
	published     [][]byte
	delivered     int
	awaitResult   mcptool.CmdResult
	awaitTimedOut bool
}

func (f *fakeBroadcaster) AllowedAction(a string) bool { return f.allowed[a] }
func (f *fakeBroadcaster) Broadcast(p []byte) int {
	f.published = append(f.published, append([]byte(nil), p...))
	return f.delivered
}

func (f *fakeBroadcaster) IsCreatingAction(a string) bool {
	return a == "splitH" || a == "splitV" || a == "newTab" || a == "newSession"
}
func (f *fakeBroadcaster) NewReqId() string { return "test-req" }
func (f *fakeBroadcaster) BroadcastAndAwait(p []byte, reqId string) (mcptool.CmdResult, int, bool) {
	f.published = append(f.published, append([]byte(nil), p...))
	return f.awaitResult, f.delivered, f.awaitTimedOut
}

func TestWorkspaceCommand_BroadcastsPayload(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"splitH": true}, delivered: 2}
	res, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"splitH","count":3,"keepFocus":true}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if len(b.published) != 1 {
		t.Fatalf("publishes=%d", len(b.published))
	}
	if !strings.Contains(string(b.published[0]), `"action":"splitH"`) {
		t.Errorf("payload=%s", b.published[0])
	}
	body := resultText(res)
	if !strings.Contains(body, "delivered=2") || !strings.Contains(body, "count=3") || !strings.Contains(body, "keepFocus=true") {
		t.Errorf("body=%q", body)
	}
}

// TC-RCR-7: 생성명령(newSession) 결과를 텍스트에 부착.
func TestWorkspaceCommand_CreatingAttachesNewIds(t *testing.T) {
	b := &fakeBroadcaster{
		allowed:   map[string]bool{"newSession": true},
		delivered: 1,
		awaitResult: mcptool.CmdResult{
			NewSessions: []string{"s5"},
			NewRegions:  []string{"r9"},
			NewTabs:     []mcptool.TabRef{{UUID: "t9", PaneID: "409"}},
		},
	}
	res, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"newSession","name":"wf"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	body := resultText(res)
	if !strings.Contains(body, "newSessions=[s5]") || !strings.Contains(body, "newTabs=[t9(409)]") {
		t.Errorf("body=%q", body)
	}
	// payload 에 reqId 포함.
	if !strings.Contains(string(b.published[0]), `"reqId":"test-req"`) {
		t.Errorf("payload missing reqId: %s", b.published[0])
	}
}

// TC-RCR-8: 비생성(focus)은 기존 텍스트 — newTabs 부착 없음.
func TestWorkspaceCommand_NonCreatingNoNewIds(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"focus": true}, delivered: 1}
	ws := &fakeWorkspaceReader{coords: map[string]string{"u1": "S1.P1.T1"}}
	res, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: ws}),
		`{"action":"focus","location":"u1"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if strings.Contains(resultText(res), "newTabs") {
		t.Errorf("non-creating should not attach newTabs: %q", resultText(res))
	}
}

// timedOut 이면 미수신 표시.
func TestWorkspaceCommand_CreatingTimedOut(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"splitV": true}, delivered: 1, awaitTimedOut: true}
	res, _ := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"splitV"}`)
	if !strings.Contains(resultText(res), "timedOut") {
		t.Errorf("body=%q", resultText(res))
	}
}

func TestWorkspaceCommand_FocusRequiresLocation(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"focus": true}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"focus"}`); err == nil {
		t.Errorf("err=nil, expected location required")
	}
}

func TestWorkspaceCommand_OpenMdTabRequiresFilePath(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"openMdTab": true}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"openMdTab"}`); err == nil {
		t.Errorf("err=nil")
	}
}

func TestWorkspaceCommand_UnknownAction(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"reboot"}`); err == nil {
		t.Errorf("err=nil")
	}
}

func TestWorkspaceCommand_MissingAction(t *testing.T) {
	b := &fakeBroadcaster{}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{}`); err == nil {
		t.Errorf("err=nil")
	}
}

func TestWorkspaceCommand_CountInvalid(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"splitH": true}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"splitH","count":1}`); err == nil {
		t.Errorf("err=nil for count=1")
	}
}

func TestWorkspaceCommand_CountForbiddenOnNonSplit(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"closeTab": true}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"closeTab","count":3}`); err == nil {
		t.Errorf("err=nil for count on closeTab")
	}
}

func TestWorkspaceCommand_KeepFocusForbidden(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"sessionNext": true}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"sessionNext","keepFocus":true}`); err == nil {
		t.Errorf("err=nil")
	}
}

// FR-RST-2/4: newSession/newTab 이 keepFocus 를 허용하고 payload 에 그대로 전달.
func TestWorkspaceCommand_NewSessionKeepFocusName(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"newSession": true}, delivered: 1}
	_, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"newSession","keepFocus":true,"name":"wf-test"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	payload := string(b.published[0])
	if !strings.Contains(payload, `"keepFocus":true`) || !strings.Contains(payload, `"name":"wf-test"`) {
		t.Errorf("payload=%s", payload)
	}
}

func TestWorkspaceCommand_NewTabKeepFocusName(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"newTab": true}, delivered: 1}
	_, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"newTab","keepFocus":true,"name":"worker"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	payload := string(b.published[0])
	if !strings.Contains(payload, `"keepFocus":true`) || !strings.Contains(payload, `"name":"worker"`) {
		t.Errorf("payload=%s", payload)
	}
}

// TC-RNS-4: renameTab/renameSession 은 location + name 둘 다 필수.
func TestWorkspaceCommand_RenameRequiresLocationAndName(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"renameTab": true, "renameSession": true}}
	ws := &fakeWorkspaceReader{coords: map[string]string{"u1": "S1.P1.T1"}}
	h := WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: ws})
	for _, payload := range []string{
		`{"action":"renameTab","name":"writer"}`,                  // location 누락
		`{"action":"renameTab","location":"u1"}`,                  // name 누락
		`{"action":"renameSession","name":"x"}`,                   // location 누락
		`{"action":"renameSession","location":"u1"}`,              // name 누락
	} {
		if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec, h, payload); err == nil {
			t.Errorf("err=nil for %s", payload)
		}
	}
}

// renameTab 해피패스 — payload 에 location(좌표 변환)/name.
func TestWorkspaceCommand_RenameTabHappy(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"renameTab": true}, delivered: 1}
	ws := &fakeWorkspaceReader{coords: map[string]string{"u1": "S1.P1.T1"}}
	_, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: ws}),
		`{"action":"renameTab","location":"u1","name":"writer"}`)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	payload := string(b.published[0])
	if !strings.Contains(payload, `"name":"writer"`) || !strings.Contains(payload, `"location":"S1.P1.T1"`) {
		t.Errorf("payload=%s", payload)
	}
}

// TC-RNS-5: rename 액션에 keepFocus 지정 시 에러.
func TestWorkspaceCommand_RenameKeepFocusForbidden(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"renameTab": true}}
	ws := &fakeWorkspaceReader{coords: map[string]string{"u1": "S1.P1.T1"}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: ws}),
		`{"action":"renameTab","location":"u1","name":"x","keepFocus":true}`); err == nil {
		t.Errorf("err=nil")
	}
}

// TC-RST-7: name 은 newSession/newTab/openMdTab 외 action 에서 거부.
func TestWorkspaceCommand_NameForbiddenOnFocus(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"focus": true}}
	ws := &fakeWorkspaceReader{coords: map[string]string{"u1": "S1.P1.T1"}}
	if _, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: ws}),
		`{"action":"focus","location":"u1","name":"x"}`); err == nil {
		t.Errorf("err=nil, name should be rejected on focus")
	}
}

func TestWorkspaceCommand_Delivered0Warning(t *testing.T) {
	b := &fakeBroadcaster{allowed: map[string]bool{"newSession": true}, delivered: 0}
	res, _ := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b}),
		`{"action":"newSession"}`)
	if !strings.Contains(resultText(res), "구독 중인 브라우저 없음") {
		t.Errorf("missing warning: %q", resultText(res))
	}
}
