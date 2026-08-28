package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/seam/toolaccess"
)

// 묶음 H — 헤드리스 멤버 (ORCHESTRATION_V2_SRS §3.2, V-HLM-1~8).
//
// 여기서 고정하는 것은 둘이다. 하나는 **고아 방지** — 도구를 만들고 멤버 등록에
// 실패하면 그 도구가 남지 않는다. 다른 하나는 **부착·분리가 상태를 바꾸지 않는
// 것** (FR-HLM-8) — 관찰 행위가 관찰 대상을 바꾸지 않는다.

// ── 백그라운드를 아는 도구 허브 ──────────────────────
//
// fakePaneHub 는 SetBackground 가 언제나 false 다. 헤드리스는 백그라운드 등록이
// 생성의 일부이므로(FR-HLM-2) 그 fake 로는 이 묶음을 검증할 수 없다.

type headlessHub struct {
	mu        sync.Mutex
	tools     map[string]*toolhub.Tool
	bg        map[string]int64
	created   []string
	deleted   []string
	lastCwd   string
	lastCols  uint16
	lastRows  uint16
	nextID    int
	createErr error

	// io 는 생성·삭제를 liveness 에도 반영한다. toolLive 는 ToolIO.Has 를 보므로
	// 둘을 따로 두면 "죽은 도구가 살아 있다고 보고되는" 테스트만의 상태가 된다.
	io *fakeToolIO
}

func newHeadlessHub(io *fakeToolIO) *headlessHub {
	return &headlessHub{tools: map[string]*toolhub.Tool{}, bg: map[string]int64{}, io: io}
}

func (h *headlessHub) seed(id string) {
	h.mu.Lock()
	h.tools[id] = &toolhub.Tool{ID: id}
	h.mu.Unlock()
	h.io.setHas(id, true)
}

func (h *headlessHub) Create(cwd string, cols, rows uint16) (*toolhub.Tool, error) {
	h.mu.Lock()
	if h.createErr != nil {
		err := h.createErr
		h.mu.Unlock()
		return nil, err
	}
	h.nextID++
	id := "headless-" + itoa(h.nextID)
	tool := &toolhub.Tool{ID: id}
	h.tools[id] = tool
	h.created = append(h.created, id)
	h.lastCwd, h.lastCols, h.lastRows = cwd, cols, rows
	h.mu.Unlock()
	h.io.setHas(id, true)
	return tool, nil
}

func (h *headlessHub) Delete(id string) {
	h.mu.Lock()
	delete(h.tools, id)
	delete(h.bg, id) // 실물 ToolManager.Delete 와 같다 — background 에서도 뺀다
	h.deleted = append(h.deleted, id)
	h.mu.Unlock()
	h.io.setHas(id, false)
}

func (h *headlessHub) SetBackground(id string, bg bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.tools[id] == nil {
		return false
	}
	if bg {
		h.bg[id] = time.Now().UnixNano()
	} else {
		delete(h.bg, id)
	}
	return true
}

func (h *headlessHub) BackgroundList() []toolhub.BackgroundEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []toolhub.BackgroundEntry{}
	for id, since := range h.bg {
		out = append(out, toolhub.BackgroundEntry{ToolID: id, Since: since})
	}
	return out
}

func (h *headlessHub) counts() (created, deleted, background int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.created), len(h.deleted), len(h.bg)
}

func (h *headlessHub) List() []map[string]interface{} { return nil }
func (h *headlessHub) Get(id string) *toolhub.Tool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tools[id]
}

func (h *headlessHub) Cwd(string) string                   { return "" }
func (h *headlessHub) Busy(string) bool                    { return false }
func (h *headlessHub) Write(string, []byte) error          { return nil }
func (h *headlessHub) Resize(string, uint16, uint16) error { return nil }
func (h *headlessHub) IsDaemon() bool                      { return false }
func (h *headlessHub) IsLive(id string) bool               { return h.io.Has(id) }
func (h *headlessHub) SnapshotTool(string) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}

// ── 잠금이 있는 워크스페이스 색인 ─────────────────────
//
// fakeWorkIndex 는 잠금이 없다. 부착·분리는 **핸들러 goroutine 이 색인을 폴링하는
// 동안 테스트가 그것을 움직이는** 모양이므로(브라우저가 늦게 탭을 만드는 것을
// 흉내 낸다) 감싸지 않으면 race detector 가 테스트를 실패시킨다. fakeToolIO 의
// setHas 와 같은 이유다.

type syncWorkIndex struct {
	mu      sync.Mutex
	resolve map[string]string
	entries []toolaccess.WorkspaceEntry
}

func newSyncWorkIndex() *syncWorkIndex {
	return &syncWorkIndex{resolve: map[string]string{}}
}

func (w *syncWorkIndex) setResolve(id, toolID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.resolve[id] = toolID
}

// bind 는 브라우저가 탭을 만든 것처럼 색인을 움직인다.
func (w *syncWorkIndex) bind(toolID, tabID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.entries = append(w.entries, toolaccess.WorkspaceEntry{ToolID: toolID, TabUUID: tabID})
	w.resolve[tabID] = toolID
}

func (w *syncWorkIndex) unbind(toolID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	kept := make([]toolaccess.WorkspaceEntry, 0, len(w.entries))
	for _, e := range w.entries {
		if e.ToolID != toolID {
			kept = append(kept, e)
		}
	}
	w.entries = kept
}

func (w *syncWorkIndex) tabCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.entries)
}

func (w *syncWorkIndex) Resolve(id string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if v, ok := w.resolve[id]; ok {
		return v, nil
	}
	return "", errors.New("not found: " + id)
}

// ResolveStrict 는 실물과 같이 살아있는 toolId·엔터티 uuid 만 본다 (FR-IDU-1).
func (w *syncWorkIndex) ResolveStrict(id string) (string, error) { return w.Resolve(id) }

func (w *syncWorkIndex) Labels() map[string]string { return map[string]string{} }

func (w *syncWorkIndex) Entries() []toolaccess.WorkspaceEntry {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]toolaccess.WorkspaceEntry(nil), w.entries...)
}

func (w *syncWorkIndex) CoordinateOf(id string) (string, error) { return id, nil }

func (w *syncWorkIndex) IsKnownTabID(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range w.entries {
		if e.TabUUID == id {
			return true
		}
	}
	return false
}

// ── 배선 ────────────────────────────────────────────

type headlessFixture struct {
	s     *Server
	hub   *headlessHub
	io    *fakeToolIO
	wi    *syncWorkIndex
	store *run.Store
	cmds  *hub.CommandHub
	sub   *hub.CmdSub
	// seen 은 브라우저에 배달된 명령이다. 부착·분리가 **어느 명령**을 썼는지가
	// 검증 대상이다 — 기존 백그라운드 복귀와 같은 경로여야 한다.
	seenMu sync.Mutex
	seen   []map[string]any
}

func newHeadlessFixture(t *testing.T) *headlessFixture {
	t.Helper()
	io := newFakeToolIO()
	h := newHeadlessHub(io)
	wi := newSyncWorkIndex()
	h.seed("tool-a")
	wi.setResolve("tool-a", "tool-a")
	wi.bind("tool-a", "tab-a")

	store := run.NewStore(t.TempDir(), "epoch-headless")
	if err := store.Load(); err != nil {
		t.Fatalf("store load: %v", err)
	}
	cmds := hub.NewCommandHub()
	f := &headlessFixture{
		s: &Server{
			Tools: h, ToolIO: io, WorkIndex: wi, Runs: store,
			Commands: cmds, WhoAmI: &fakeWhoAmI{toolID: "tool-a"},
		},
		hub: h, io: io, wi: wi, store: store, cmds: cmds,
	}
	// 구독자가 없으면 Broadcast 가 0 을 돌려주고 부착·분리는 503 이다. 실제
	// 브라우저 한 대를 흉내 낸다.
	f.sub = cmds.Add()
	go func() {
		for msg := range f.sub.Messages() {
			var got map[string]any
			_ = json.Unmarshal(msg, &got)
			f.seenMu.Lock()
			f.seen = append(f.seen, got)
			f.seenMu.Unlock()
		}
	}()
	t.Cleanup(func() { cmds.Remove(f.sub) })
	return f
}

// actions 는 지금까지 배달된 명령 이름들이다.
func (f *headlessFixture) actions() []string {
	f.seenMu.Lock()
	defer f.seenMu.Unlock()
	out := make([]string, 0, len(f.seen))
	for _, c := range f.seen {
		name, _ := c["action"].(string)
		out = append(out, name)
	}
	return out
}

func (f *headlessFixture) startRun(t *testing.T) string {
	t.Helper()
	code, out := postRun(t, f.s, "/api/runs", `{"objective":"팬아웃","projection":"inline","isolation":"none"}`)
	if code != http.StatusOK {
		t.Fatalf("run start want 200, got %d (%+v)", code, out)
	}
	id, _ := out["id"].(string)
	return id
}

// addHeadless 는 헤드리스 멤버 하나를 등록하고 그 뷰를 돌려준다.
func (f *headlessFixture) addHeadless(t *testing.T, runID, role string) map[string]any {
	t.Helper()
	code, out := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"`+role+`","agent":"claude","headless":true,"cwd":"/repo"}`)
	if code != http.StatusOK {
		t.Fatalf("헤드리스 멤버 등록 want 200, got %d (%+v)", code, out)
	}
	return out
}

// ── FR-HLM-1: --at 과 --headless 는 배타이며 정확히 하나 (V-HLM-8) ──

func TestHeadlessMember_AtAndHeadlessAreExclusive(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)

	// 둘 다 지정.
	code, out := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"w","agent":"claude","id":"tab-a","headless":true}`)
	if code != http.StatusBadRequest || out["error"] != "invalid_argument" {
		t.Fatalf("--at + --headless want 400/invalid_argument, got %d (%+v)", code, out)
	}
	// 안내가 무엇을 줘야 하는지 말해야 한다 (FR-HLM-1).
	if detail, _ := out["detail"].(string); detail == "" ||
		!containsAll(detail, "--at", "--headless") {
		t.Fatalf("거부가 무엇을 줘야 하는지 안내하지 않는다: %+v", out)
	}

	// 둘 다 없음.
	code, out = postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"w","agent":"claude"}`)
	if code != http.StatusBadRequest || out["error"] != "invalid_argument" {
		t.Fatalf("--at·--headless 둘 다 없음 want 400/invalid_argument, got %d (%+v)", code, out)
	}
}

// ── FR-HLM-2: 서버가 도구를 만들고 백그라운드에 등록한다 (V-HLM-1) ──

func TestHeadlessMember_CreatesBackgroundToolWithoutTab(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)

	m := f.addHeadless(t, runID, "writer")
	if m["tabId"] != nil && m["tabId"] != "" {
		t.Fatalf("헤드리스 멤버에 탭이 붙었다: %+v", m)
	}
	if m["headless"] != true {
		t.Fatalf("headless 필드가 서지 않았다: %+v", m)
	}
	toolID, _ := m["toolId"].(string)
	if toolID == "" {
		t.Fatalf("도구가 만들어지지 않았다: %+v", m)
	}
	created, _, bg := f.hub.counts()
	if created != 1 || bg != 1 {
		t.Fatalf("created=%d background=%d, want 1/1", created, bg)
	}
	// 화면이 없으므로 크기는 고정값이다 (FR-HLM-2).
	f.hub.mu.Lock()
	cols, rows, cwd := f.hub.lastCols, f.hub.lastRows, f.hub.lastCwd
	f.hub.mu.Unlock()
	if cols != headlessCols || rows != headlessRows {
		t.Fatalf("크기 = %dx%d, want %dx%d", cols, rows, headlessCols, headlessRows)
	}
	// cwd 는 서버가 확정한다 — 조정자의 cwd 다 (비격리 Run).
	if cwd != "/repo" {
		t.Fatalf("cwd = %q, want /repo", cwd)
	}
	// V-HLM-1: 워크스페이스 탭 수가 변하지 않는다.
	if f.wi.tabCount() != 1 {
		t.Fatalf("탭 수가 변했다: %d", f.wi.tabCount())
	}
}

// ── 고아 방지: 등록이 실패하면 방금 만든 도구를 되돌린다 ──
//
// FR-HLM-5 의 고아(Run 이 끝난 뒤 남은 도구)와 **다른 것**이다. 이쪽은 애초에
// 만들지 않은 것과 같게 되돌리는 보상 삭제다.

func TestHeadlessMember_RollsBackToolWhenRegistrationFails(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)

	// 알 수 없는 에이전트 id 는 AddMember 가 거부한다 (FR-ADP-3) — 도구를 만든
	// **뒤에** 실패하는 경로다.
	code, out := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"w","agent":"no-such-agent","headless":true,"cwd":"/repo"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("알 수 없는 에이전트 want 400, got %d (%+v)", code, out)
	}
	created, deleted, bg := f.hub.counts()
	if created != 1 {
		t.Fatalf("도구가 만들어지지 않아 보상 삭제를 검증할 수 없다 (created=%d)", created)
	}
	if deleted != 1 {
		t.Fatalf("보상 삭제가 일어나지 않았다 — 고아가 남는다 (deleted=%d)", deleted)
	}
	if bg != 0 {
		t.Fatalf("백그라운드에 고아가 남았다 (background=%d)", bg)
	}
	// 기록에도 남지 않는다.
	rec, _ := f.store.Get(runID)
	if len(rec.Members) != 0 {
		t.Fatalf("실패한 등록이 멤버를 남겼다: %+v", rec.Members)
	}
}

func TestHeadlessMember_ToolCreateFailureLeavesNothing(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	f.hub.mu.Lock()
	f.hub.createErr = errors.New("pty 없음")
	f.hub.mu.Unlock()

	code, _ := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"w","agent":"claude","headless":true,"cwd":"/repo"}`)
	if code != http.StatusInternalServerError {
		t.Fatalf("도구 생성 실패 want 500, got %d", code)
	}
	rec, _ := f.store.Get(runID)
	if len(rec.Members) != 0 {
		t.Fatalf("도구 없는 멤버가 기록에 남았다: %+v", rec.Members)
	}
}

// ── FR-HLM-6/7/8: 부착·분리 (V-HLM-5) ──

func TestRunAttachDetach_DoesNotChangeMemberState(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	toolID, _ := m["toolId"].(string)

	before := memberSnapshot(t, f, memberID)

	// 부착 — 브라우저가 탭을 만드는 것을 흉내 낸다.
	go func() {
		time.Sleep(20 * time.Millisecond)
		f.wi.bind(toolID, "tab-new")
	}()
	code, out := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`)
	if code != http.StatusOK {
		t.Fatalf("attach want 200, got %d (%+v)", code, out)
	}
	if out["tabId"] != "tab-new" {
		t.Fatalf("부착 후 tabId 가 채워지지 않았다: %+v", out)
	}
	if out["headless"] != nil && out["headless"] != false {
		t.Fatalf("부착 후에도 headless 가 참이다: %+v", out)
	}
	// 기존 백그라운드 복귀와 **같은 경로**여야 한다 (FR-HLM-9).
	if acts := f.actions(); len(acts) != 1 || acts[0] != "restoreTool" {
		t.Fatalf("부착이 쓴 명령 = %v, want [restoreTool]", acts)
	}

	afterAttach := memberSnapshot(t, f, memberID)
	assertObservationUnchanged(t, "attach", before, afterAttach)

	// 분리 — 브라우저가 탭을 닫는 것을 흉내 낸다.
	go func() {
		time.Sleep(20 * time.Millisecond)
		f.wi.unbind(toolID)
	}()
	code, out = postRun(t, f.s, "/api/runs/detach", `{"memberId":"`+memberID+`"}`)
	if code != http.StatusOK {
		t.Fatalf("detach want 200, got %d (%+v)", code, out)
	}
	if tab, _ := out["tabId"].(string); tab != "" {
		t.Fatalf("분리 후에도 tabId 가 남았다: %+v", out)
	}
	if out["headless"] != true {
		t.Fatalf("분리 후 headless 가 서지 않았다: %+v", out)
	}
	if acts := f.actions(); len(acts) != 2 || acts[1] != "detachTab" {
		t.Fatalf("분리가 쓴 명령 = %v, want [.. detachTab]", acts)
	}
	// 에이전트 프로세스는 죽지 않는다 (FR-HLM-7).
	if _, deleted, _ := f.hub.counts(); deleted != 0 {
		t.Fatalf("분리가 도구를 죽였다 (deleted=%d)", deleted)
	}

	assertObservationUnchanged(t, "detach", before, memberSnapshot(t, f, memberID))
}

// memberObservation 은 부착·분리가 건드려서는 안 되는 것 전부다 (FR-HLM-8).
type memberObservation struct {
	state        string
	outcome      string
	summary      string
	reportedAt   float64
	contextLevel string
	contextRatio float64
	compactCount float64
	toolID       string
	role         string
}

func memberSnapshot(t *testing.T, f *headlessFixture, memberID string) memberObservation {
	t.Helper()
	code, out := getRun(t, f.s, "/api/runs?id="+runIDOfMember(t, f, memberID))
	if code != http.StatusOK {
		t.Fatalf("run 조회 실패: %d", code)
	}
	members, _ := out["members"].([]any)
	for _, mv := range members {
		m, _ := mv.(map[string]any)
		if m == nil || m["id"] != memberID {
			continue
		}
		str := func(k string) string { v, _ := m[k].(string); return v }
		num := func(k string) float64 { v, _ := m[k].(float64); return v }
		return memberObservation{
			state: str("state"), outcome: str("outcome"), summary: str("summary"),
			reportedAt: num("reportedAt"), contextLevel: str("contextLevel"),
			contextRatio: num("contextRatio"), compactCount: num("compactCount"),
			toolID: str("toolId"), role: str("role"),
		}
	}
	t.Fatalf("멤버 %s 를 찾지 못했다", memberID)
	return memberObservation{}
}

func runIDOfMember(t *testing.T, f *headlessFixture, memberID string) string {
	t.Helper()
	rec, _, ok := f.store.FindMember(memberID)
	if !ok {
		t.Fatalf("멤버 %s 가 기록에 없다", memberID)
	}
	return rec.ID
}

func assertObservationUnchanged(t *testing.T, verb string, before, after memberObservation) {
	t.Helper()
	if before != after {
		t.Fatalf("%s 가 멤버 관측을 바꿨다 (FR-HLM-8)\n  전: %+v\n  후: %+v", verb, before, after)
	}
}

// 부착·분리의 거부는 뭉뚱그리지 않는다.
func TestRunAttach_RefusalsAreEnumerated(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)

	if code, out := postRun(t, f.s, "/api/runs/attach", `{"memberId":"no-such"}`); code != http.StatusNotFound ||
		out["error"] != "unknown_member" {
		t.Fatalf("없는 멤버 want 404/unknown_member, got %d (%+v)", code, out)
	}

	// 탭에 붙어 태어난 멤버는 부착 대상이 아니다.
	_, tabbed := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"r","agent":"claude","id":"tab-a"}`)
	tabbedID, _ := tabbed["id"].(string)
	if code, out := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+tabbedID+`"}`); code != http.StatusConflict ||
		out["error"] != "member_attached" {
		t.Fatalf("이미 부착된 멤버 want 409/member_attached, got %d (%+v)", code, out)
	}

	// 헤드리스 멤버는 분리 대상이 아니다 — 이미 화면에 없다.
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	if code, out := postRun(t, f.s, "/api/runs/detach", `{"memberId":"`+memberID+`"}`); code != http.StatusConflict ||
		out["error"] != "member_not_attached" {
		t.Fatalf("헤드리스 분리 want 409/member_not_attached, got %d (%+v)", code, out)
	}

	// 도구가 죽었으면 붙일 것이 없다.
	toolID, _ := m["toolId"].(string)
	f.io.setHas(toolID, false)
	if code, _ := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`); code != http.StatusNotFound {
		t.Fatalf("죽은 도구 부착 want 404, got %d", code)
	}
}

// 브라우저가 반영하지 않으면 기록을 고치지 않는다 — 재시도가 스스로 낫는다.
func TestRunAttach_UnconfirmedTabLeavesRecordUntouched(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	toolID, _ := m["toolId"].(string)

	// 브라우저가 탭을 만들지 않는다. attachSettleTimeout 만큼 기다린 뒤 504.
	code, _ := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`)
	if code != http.StatusGatewayTimeout {
		t.Fatalf("미반영 부착 want 504, got %d", code)
	}
	_, after, _ := f.store.FindMember(memberID)
	if after.TabID != "" || !after.Headless {
		t.Fatalf("실패한 부착이 기록을 고쳤다: %+v", after)
	}

	// 뒤늦게 탭이 생기면 재시도가 성공한다.
	f.wi.bind(toolID, "tab-late")
	if code, out := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`); code != http.StatusOK ||
		out["tabId"] != "tab-late" {
		t.Fatalf("재시도가 실패했다: %d (%+v)", code, out)
	}
}

// 구독 중인 브라우저가 없으면 부착은 성립하지 않는다.
func TestRunAttach_NoBrowserIsRefused(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	f.cmds.Remove(f.sub)

	if code, _ := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`); code != http.StatusServiceUnavailable {
		t.Fatalf("브라우저 없음 want 503, got %d", code)
	}
	_, after, _ := f.store.FindMember(memberID)
	if after.TabID != "" {
		t.Fatalf("배달되지 않은 부착이 기록을 고쳤다: %+v", after)
	}
}

// ── FR-HLM-4/5: 수명과 고아 (V-HLM-6, V-HLM-7) ──

func TestRunClose_TerminatesHeadlessToolsOnly(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	headless := f.addHeadless(t, runID, "writer")
	headlessTool, _ := headless["toolId"].(string)

	// 탭에 붙은 멤버도 하나 둔다 — 이쪽 도구는 닫히지 않아야 한다.
	_, tabbed := postRun(t, f.s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"reader","agent":"claude","id":"tab-a"}`)
	tabbedTool, _ := tabbed["toolId"].(string)

	code, out := postRun(t, f.s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, out)
	}
	if f.io.Has(headlessTool) {
		t.Fatalf("헤드리스 도구가 살아남았다: %s", headlessTool)
	}
	if !f.io.Has(tabbedTool) {
		t.Fatalf("탭 부착 도구를 서버가 죽였다: %s — 화면에 있는 것을 말없이 죽이지 않는다", tabbedTool)
	}
	// V-HLM-6: ⏻ 개수 0.
	if _, _, bg := f.hub.counts(); bg != 0 {
		t.Fatalf("close 후 백그라운드 도구가 남았다 (background=%d)", bg)
	}
	// 거둔 것은 고아가 아니다.
	if orphans, _ := out["orphans"].([]any); len(orphans) != 0 {
		t.Fatalf("거둔 도구가 고아로 보고됐다: %+v", orphans)
	}
}

func TestRunClose_KeepToolsLeavesOrphansInStatus(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	toolID, _ := m["toolId"].(string)
	memberID, _ := m["id"].(string)

	code, out := postRun(t, f.s, "/api/runs/close",
		`{"runId":"`+runID+`","force":true,"keepTools":true}`)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, out)
	}
	if !f.io.Has(toolID) {
		t.Fatalf("--keep-tools 인데 도구가 죽었다: %s", toolID)
	}
	// 보존도 보고된다 — 조용히 남는 자원이 없어야 한다.
	kept, _ := out["keptTools"].([]any)
	if len(kept) != 1 {
		t.Fatalf("보존 보고가 없다: %+v", out["keptTools"])
	}
	// V-HLM-7: 이후의 run status 에 고아로 남는다.
	assertOrphan(t, f, runID, memberID, toolID)

	// 도구가 사라지면 고아 목록에서도 빠진다 — 없는 것을 남았다고 하지 않는다.
	f.io.setHas(toolID, false)
	_, status := getRun(t, f.s, "/api/runs?id="+runID)
	if orphans, _ := status["orphans"].([]any); len(orphans) != 0 {
		t.Fatalf("죽은 도구가 고아로 남았다: %+v", orphans)
	}
}

func assertOrphan(t *testing.T, f *headlessFixture, runID, memberID, toolID string) {
	t.Helper()
	code, status := getRun(t, f.s, "/api/runs?id="+runID)
	if code != http.StatusOK {
		t.Fatalf("run status want 200, got %d", code)
	}
	orphans, _ := status["orphans"].([]any)
	if len(orphans) != 1 {
		t.Fatalf("고아 목록 = %+v, want 1건", status["orphans"])
	}
	o, _ := orphans[0].(map[string]any)
	if o["memberId"] != memberID || o["toolId"] != toolID {
		t.Fatalf("고아 항목이 어긋난다: %+v", o)
	}
}

// 열린 Run 은 고아를 내지 않는다 — 살아 있는 멤버는 고아가 아니다.
func TestRunStatus_OpenRunHasNoOrphans(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	f.addHeadless(t, runID, "writer")

	_, status := getRun(t, f.s, "/api/runs?id="+runID)
	if _, present := status["orphans"]; present {
		t.Fatalf("열린 Run 이 고아를 보고했다: %+v", status["orphans"])
	}
}

// ── FR-HLM-12: 헤드리스 도구도 접합면에서 동등하다 (NFR-ORC-2) ──
//
// read-screen 은 화면 부착 여부와 무관하다. 헤드리스 멤버가 막혔을 때 진단할
// 유일한 길이므로 막지 않는다.

func TestHeadlessTool_ReadableThroughToolIO(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	toolID, _ := m["toolId"].(string)

	// ResolveStrict 1단계가 살아있는 toolId 를 그대로 해석한다 — 탭이 없어도
	// 통과하는 근거가 이것이다.
	f.wi.setResolve(toolID, toolID)
	f.io.snap[toolID] = []byte("헤드리스 출력")

	code, out := getRun(t, f.s, "/api/tools/output?id="+toolID)
	if code != http.StatusOK {
		t.Fatalf("헤드리스 도구 read-output want 200, got %d (%+v)", code, out)
	}
	if out["text"] != "헤드리스 출력" {
		t.Fatalf("출력이 어긋난다: %+v", out)
	}
}

// ── POST /api/tools/headless — 탭 없는 Tool 생성의 1급 종단 ──

func TestApiToolsHeadless_CreatesBackgroundTool(t *testing.T) {
	f := newHeadlessFixture(t)
	code, out := postRun(t, f.s, "/api/tools/headless", `{"cwd":"/somewhere"}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	toolID, _ := out["toolId"].(string)
	if toolID == "" {
		t.Fatalf("toolId 가 없다: %+v", out)
	}
	if out["cols"] != float64(headlessCols) || out["rows"] != float64(headlessRows) {
		t.Fatalf("고정 크기가 아니다: %+v", out)
	}
	if _, _, bg := f.hub.counts(); bg != 1 {
		t.Fatalf("백그라운드에 등록되지 않았다 (background=%d)", bg)
	}
	// 어떤 탭도 참조하지 않는다.
	if f.s.tabIDOfTool(toolID) != "" {
		t.Fatalf("생성 직후 탭이 붙었다: %s", toolID)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// ── FR-HLM-9: ⏻ 목록이 Run 멤버를 구분할 수 있게 한다 ──
//
// 배지를 그리는 것은 프런트의 몫이고(WS-8 / FR-BGK-12), 여기서 고정하는 것은
// 서버가 그 근거를 낸다는 사실이다. 헤드리스 도구는 "떼어 둔 내 도구" 와 같은
// 목록에 섞이므로, 구분할 값이 없으면 프런트도 구분할 수 없다.

func TestApiToolsBackground_AnnotatesRunMembers(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	toolID, _ := m["toolId"].(string)

	// Run 과 무관한 백그라운드 도구도 하나 둔다 — 이쪽은 비어 있어야 한다.
	f.hub.SetBackground("tool-a", true)

	code, out := getRun(t, f.s, "/api/tools/background")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	rows, _ := out["background"].([]any)
	if len(rows) != 2 {
		t.Fatalf("백그라운드 목록 = %+v, want 2건", out["background"])
	}
	seen := map[string]map[string]any{}
	for _, rv := range rows {
		row, _ := rv.(map[string]any)
		id, _ := row["toolId"].(string)
		seen[id] = row
	}
	member := seen[toolID]
	if member == nil {
		t.Fatalf("헤드리스 도구가 목록에 없다: %+v", seen)
	}
	if member["runId"] != runID || member["memberId"] != memberID || member["role"] != "writer" {
		t.Fatalf("Run 멤버 표시가 어긋난다: %+v", member)
	}
	plain := seen["tool-a"]
	if plain == nil {
		t.Fatalf("일반 백그라운드 도구가 목록에 없다: %+v", seen)
	}
	// 남의 것을 Run 의 것으로 물들이지 않는다.
	if _, present := plain["runId"]; present {
		t.Fatalf("Run 과 무관한 도구에 runId 가 붙었다: %+v", plain)
	}
}

// ── V-HLM-3: 헤드리스 멤버에 msg → status 가 성립한다 ──
//
// NFR-ORC-2 의 최소선이다 — 헤드리스 멤버와 탭 부착 멤버 사이에 관측·제어의
// 능력 차이를 만들지 않는다. 전이를 일으키는 것은 에이전트의 훅이므로 여기서는
// 그 훅이 도달할 수 있다는 것과, 도달한 상태가 그대로 읽힌다는 것을 고정한다.
func TestHeadlessTool_MessageAndStatusWork(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	toolID, _ := m["toolId"].(string)
	f.wi.setResolve(toolID, toolID)

	// msg — 탭이 없어도 엔벨로프가 그 PTY 로 간다.
	code, out := postRun(t, f.s, "/api/tools/message",
		`{"to":"`+toolID+`","message":"시작해라"}`)
	if code != http.StatusOK {
		t.Fatalf("헤드리스 멤버에 msg want 200, got %d (%+v)", code, out)
	}
	if len(f.io.pastes) != 1 || f.io.pastes[0].ToolID != toolID {
		t.Fatalf("엔벨로프가 배달되지 않았다: %+v", f.io.pastes)
	}
	if !containsAll(f.io.pastes[0].Text, "DONGMINAL-AGENT-MSG", "시작해라") {
		t.Fatalf("엔벨로프 형식이 어긋난다: %q", f.io.pastes[0].Text)
	}

	// 에이전트 훅이 working 을 알린다 (dmctl activity 가 하는 일).
	if code, _ := postRun(t, f.s, "/api/tools/activity/set",
		`{"toolId":"`+toolID+`","state":"working","tool":"Edit"}`); code != http.StatusOK {
		t.Fatalf("activity/set want 200, got %d", code)
	}

	// status — 그 상태가 그대로 읽힌다.
	code, out = getRun(t, f.s, "/api/tools/activity/get?id="+toolID)
	if code != http.StatusOK {
		t.Fatalf("헤드리스 멤버 status want 200, got %d (%+v)", code, out)
	}
	if out["state"] != "working" {
		t.Fatalf("상태 = %v, want working", out["state"])
	}

	// 멤버 상태도 따라 움직인다 — deriveMemberState 가 같은 관측을 본다.
	_, view := getRun(t, f.s, "/api/runs?id="+runID)
	members, _ := view["members"].([]any)
	first, _ := members[0].(map[string]any)
	if first["state"] != "working" {
		t.Fatalf("멤버 state = %v, want working", first["state"])
	}
}

// ── 복귀의 단일 관문이 기록을 맞춘다 (FR-HLM-6) ──
//
// ⏻ 모달의 행 클릭은 dmctl 을 지나지 않고 브라우저가 직접 백그라운드를 해제한다.
// 그 경로에서도 Member.TabID 가 채워져야 **경로가 둘이어도 기록이 하나**가 된다.

func TestBackgroundSet_RestoreRecordsMemberTab(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	toolID, _ := m["toolId"].(string)

	// 브라우저가 탭을 만드는 것을 흉내 낸다. 실물은 백그라운드 해제를 **기다린
	// 뒤에** 탭을 만들므로, 화해는 비동기여야 한다.
	go func() {
		time.Sleep(20 * time.Millisecond)
		f.wi.bind(toolID, "tab-clicked")
	}()

	code, _ := postRun(t, f.s, "/api/tools/background/set",
		`{"toolId":"`+toolID+`","background":false}`)
	if code != http.StatusOK {
		t.Fatalf("background/set want 200, got %d", code)
	}

	// 응답은 즉시 온다 — 브라우저를 붙잡지 않는다. 기록은 곧 따라온다.
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, got, _ := f.store.FindMember(memberID)
		if got.TabID == "tab-clicked" && !got.Headless {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("클릭 복귀가 기록에 반영되지 않았다: %+v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Run 과 무관한 도구의 복귀는 아무것도 하지 않는다.
func TestBackgroundSet_RestoreIgnoresNonMembers(t *testing.T) {
	f := newHeadlessFixture(t)
	f.hub.SetBackground("tool-a", true)

	code, _ := postRun(t, f.s, "/api/tools/background/set",
		`{"toolId":"tool-a","background":false}`)
	if code != http.StatusOK {
		t.Fatalf("background/set want 200, got %d", code)
	}
}

// 부착과 클릭 복귀가 겹쳐도 결과는 하나다 — 먼저 기록한 쪽이 이기고, 나중 쪽은
// 같은 답을 확인하고 성공한다.
func TestRunAttach_ToleratesConcurrentReconcile(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "writer")
	memberID, _ := m["id"].(string)
	toolID, _ := m["toolId"].(string)

	// 화해가 먼저 이긴 상태를 만든다.
	f.wi.bind(toolID, "tab-race")
	if _, _, err := f.store.Attach(memberID, "tab-race"); err != nil {
		t.Fatalf("사전 부착: %v", err)
	}

	// 같은 탭이면 attach 는 성공으로 답한다.
	code, out := postRun(t, f.s, "/api/runs/attach", `{"memberId":"`+memberID+`"}`)
	if code != http.StatusConflict {
		t.Fatalf("이미 부착된 멤버의 attach want 409, got %d (%+v)", code, out)
	}
	// 위는 handler 앞단의 TabID 검사에 걸린다 — 경합이 아니라 **재부착**이므로
	// 409 가 맞다. 경합 관용은 그 검사를 통과한 뒤에만 의미가 있다.
	_, got, _ := f.store.FindMember(memberID)
	if got.TabID != "tab-race" {
		t.Fatalf("거부가 기록을 바꿨다: %+v", got)
	}
}
