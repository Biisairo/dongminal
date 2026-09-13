// Package agentsess 는 에이전트 도구의 **서버 해석층**이다 (M8_UNIFIED_SRS D-U-4 (a),
// D-C-2·3 · FR-APS-2~8 · FR-AAL-1~4).
//
// 도구 하나에 세션 하나. 바이트(절대 오프셋)를 받아 줄로 자르고 `Proto.Decode` 로
// 공통 이벤트를 얻어, 이벤트 로그(seq)에 남기고 싱크(SSE)로 내고 활동 보고를 파생한다.
// 두 모드가 같은 함수를 지난다 — 직접 모드는 `ToolHooks.OnOutput`, 데몬 모드는
// `ToolClient.SetOnOutput` 이 `Feed` 를 부른다.
//
// 이 패키지는 에이전트를 모른다 (FR-U-1). 아는 것은 `agentadapter.Proto` 의 함수와
// 공통 이벤트뿐이다.
package agentsess

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// ErrNoSession 은 그 도구에 세션이 없다 — 에이전트 도구가 아니거나 이미 끝났다.
var ErrNoSession = errors.New("agent_session_not_found")

// DefaultLogCap 은 도구마다의 이벤트 로그 상한이다 (NFR-C-2, P3 값).
const DefaultLogCap = 4096

// Logged 는 로그의 한 줄이다. Seq 는 1 부터 단조 증가하며 잘려도 이어진다.
type Logged struct {
	Seq int64              `json:"seq"`
	At  int64              `json:"at"`
	Ev  agentadapter.Event `json:"ev"`
}

// Sink 는 해석층이 밖으로 내는 둘이다.
type Sink interface {
	// Event 는 새 이벤트 하나 — SSE 방송의 자리.
	Event(toolID string, le Logged)
	// Activity 는 활동 보고다 — `activity/set` 종단과 **같은 함수**를 지나야 한다
	// (D-C-2): 그래야 알람·활동 패널·`dmctl wait` 가 터미널 도구와 같은 길로 선다.
	Activity(toolID, state, tool, detail string, userPrompt bool)
}

// Deps 는 해석층이 딛는 것이다.
type Deps struct {
	Sink Sink
	// Write 는 도구에 프레임을 쓴다 — `ToolHub.Write`. 줄바꿈은 여기서 붙인다.
	Write func(id string, data []byte) error
	// Snapshot 은 도구 출력의 스냅샷이다 — `ToolHub.SnapshotTool`. 열 때와 틈이
	// 보일 때 되메우는 근거다 (§9.3 ④).
	Snapshot func(id string) (toolhub.ToolSnapshot, error)
	// LogCap 은 로그 상한. 0 이면 DefaultLogCap.
	LogCap int
}

// Manager 는 도구 → 세션이다.
type Manager struct {
	deps Deps
	mu   sync.Mutex
	sess map[string]*Session
}

// New 는 빈 관리자다.
func New(d Deps) *Manager {
	if d.LogCap <= 0 {
		d.LogCap = DefaultLogCap
	}
	return &Manager{deps: d, sess: map[string]*Session{}}
}

// Open 은 도구에 세션을 세운다. 핸드셰이크를 보내고 지금까지의 출력을 스냅샷으로
// 되메운다 — 세션이 붙기 전에 나온 첫 프레임을 놓치지 않기 위해서다 (D-C-2).
// 이미 있으면 그것을 돌려준다.
func (m *Manager) Open(toolID string, ad agentadapter.Adapter) (*Session, error) {
	if ad.Proto == nil {
		return nil, fmt.Errorf("%s: 프로토콜 표면이 없다 (FR-APS-4)", ad.ID)
	}
	m.mu.Lock()
	if s, ok := m.sess[toolID]; ok {
		m.mu.Unlock()
		return s, nil
	}
	s := &Session{toolID: toolID, ad: ad, st: agentadapter.NewProtoState(), mgr: m, firstSeq: 1}
	m.sess[toolID] = s
	m.mu.Unlock()
	if ad.Proto.Handshake != nil {
		for _, fr := range ad.Proto.Handshake(s.st) {
			if err := m.write(toolID, fr); err != nil {
				dmlog.Warnf(nil, "[agent %s] handshake write: %v", toolID, err)
			}
		}
	}
	s.resync()
	return s, nil
}

// Get 은 세션이다. 없으면 nil.
func (m *Manager) Get(toolID string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sess[toolID]
}

// Feed 는 도구의 출력 청크다. 에이전트 세션이 있으면 소비하고 true — 호출자는
// 그때 터미널 경로(L1 OSC·L2 무장)를 지나지 않는다 (FR-AAL-5). 없으면 false.
func (m *Manager) Feed(toolID string, data []byte, end int64) bool {
	s := m.Get(toolID)
	if s == nil {
		return false
	}
	s.feed(data, end)
	return true
}

// Exit 은 도구 프로세스의 끝이다 — exit 이벤트와 `ended` 활동, 세션은 닫힌다.
// 세션이 없으면 아무 일도 없다.
func (m *Manager) Exit(toolID string) {
	m.mu.Lock()
	s, ok := m.sess[toolID]
	if ok {
		delete(m.sess, toolID)
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	s.mu.Lock()
	s.exited = true
	s.emit(agentadapter.Event{Kind: agentadapter.EvExit})
	s.mu.Unlock()
}

// ToolIDs 는 열린 세션의 도구들이다 (테스트·진단).
func (m *Manager) ToolIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.sess))
	for id := range m.sess {
		out = append(out, id)
	}
	return out
}

func (m *Manager) write(toolID string, frame []byte) error {
	if m.deps.Write == nil {
		return errors.New("write 가 배선되지 않았다")
	}
	if !bytes.HasSuffix(frame, []byte("\n")) {
		frame = append(append([]byte(nil), frame...), '\n')
	}
	return m.deps.Write(toolID, frame)
}

// Session 은 도구 하나의 해석 상태다.
type Session struct {
	toolID string
	ad     agentadapter.Adapter
	mgr    *Manager

	mu      sync.Mutex
	st      *agentadapter.ProtoState
	seen    int64 // 소비한 절대 오프셋
	linebuf []byte
	// skipLine 은 틈을 되메우지 못해 다음 줄바꿈까지를 버리는 중이라는 뜻이다 —
	// 반 토막 줄을 해석하면 없는 오류를 만든다.
	skipLine bool
	exited   bool

	log      []Logged
	firstSeq int64
	nextSeq  int64

	status agentadapter.ProtoStatus
	usage  agentadapter.ProtoUsage
}

// State 는 지금의 합쳐진 상태다 — 재생 응답에 함께 실린다.
type State struct {
	ToolID          string                         `json:"toolId"`
	Agent           string                         `json:"agent"`
	SessionID       string                         `json:"sessionId,omitempty"`
	Status          agentadapter.ProtoStatus       `json:"status"`
	Usage           agentadapter.ProtoUsage        `json:"usage"`
	Open            []agentadapter.ApprovalRequest `json:"open"`
	PermissionModes []string                       `json:"permissionModes,omitempty"`
	// Controls 는 이 어댑터가 주는 제어의 유무다 (FR-AGT-11, FR-APS-4 — 없는 것은
	// 메뉴에 나타나지 않는다).
	Controls Controls `json:"controls"`
	Exited   bool     `json:"exited,omitempty"`
}

// Controls 는 어댑터가 준 제어 표면의 유무다.
type Controls struct {
	Interrupt bool `json:"interrupt"`
	Control   bool `json:"control"`
	TUIResume bool `json:"tuiResume"`
}

// SessionID 는 프로토콜의 세션 신원이다. 비어 있으면 아직 모른다.
func (s *Session) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.SessionID
}

// Open 은 열린 승인 요청이다 (FR-APS-5). 프로토콜 id 순.
func (s *Session) Open() []agentadapter.ApprovalRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.openLocked()
}

func (s *Session) openLocked() []agentadapter.ApprovalRequest {
	out := make([]agentadapter.ApprovalRequest, 0, len(s.st.Open))
	for _, r := range s.st.Open {
		out = append(out, r)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// State 는 합쳐진 상태 스냅샷이다.
func (s *Session) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ad.Proto
	return State{
		ToolID: s.toolID, Agent: s.ad.ID, SessionID: s.st.SessionID,
		Status: s.status, Usage: s.usage, Open: s.openLocked(),
		PermissionModes: p.PermissionModes,
		Controls:        Controls{Interrupt: p.Interrupt != nil, Control: p.Control != nil, TUIResume: p.TUIResume != nil},
		Exited:          s.exited,
	}
}

// Events 는 since 뒤의 로그다 (D-C-3). truncated 는 since 가 가리키는 자리가 이미
// 잘렸다는 뜻 — 브라우저는 그때 "이전 기록은 잘렸다" 를 보인다 (FR-ABG-21 의 P3 몫).
func (s *Session) Events(since int64) (evs []Logged, truncated bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// since 는 "이것까지 보았다" 다. 다음은 since+1 이고, 그것이 firstSeq 앞이면 잘렸다.
	if since+1 < s.firstSeq {
		truncated = true
	}
	for _, le := range s.log {
		if le.Seq > since {
			evs = append(evs, le)
		}
	}
	return evs, truncated
}

// Prompt 는 사용자 입력이다 (FR-AAL-2 — 표시를 세우는 것은 우리가 보낸 입력이다).
func (s *Session) Prompt(text string) error {
	s.mu.Lock()
	if s.exited {
		s.mu.Unlock()
		return ErrNoSession
	}
	frames := s.ad.Proto.Prompt(text, s.st)
	s.emit(agentadapter.Event{Kind: agentadapter.EvUser, Text: text})
	s.mgr.deps.Sink.Activity(s.toolID, "working", "", "", true)
	s.mu.Unlock()
	for _, fr := range frames {
		if err := s.mgr.write(s.toolID, fr); err != nil {
			return err
		}
	}
	return nil
}

// Approve 는 열린 요청에 답한다 (FR-APS-5, NFR-C-4 — 프레임 하나). 서버가 고르지
// 않는다 (FR-APS-6); 없는 요청은 ErrNotOpen.
func (s *Session) Approve(id string, d agentadapter.Decision) error {
	s.mu.Lock()
	req, ok := s.st.Open[id]
	if !ok {
		s.mu.Unlock()
		return agentadapter.ErrNotOpen
	}
	frame, err := s.ad.Proto.Approve(req, d, s.st)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	choice := d.Choice
	if choice == "" && len(d.Answers) > 0 {
		choice = "answered"
	}
	s.emit(agentadapter.Event{Kind: agentadapter.EvApprovalClosed, Text: choice, Approval: &agentadapter.ApprovalRequest{ID: id, Kind: req.Kind, Tool: req.Tool}})
	s.mgr.deps.Sink.Activity(s.toolID, "working", "", "", false)
	s.mu.Unlock()
	return s.mgr.write(s.toolID, frame)
}

// Control 은 세션 중 제어다 (FR-AGT-11). 어댑터에 없으면 ErrUnsupported.
func (s *Session) Control(op agentadapter.ControlOp) error {
	s.mu.Lock()
	if s.ad.Proto.Control == nil {
		s.mu.Unlock()
		return agentadapter.ErrUnsupported
	}
	frame, err := s.ad.Proto.Control(op, s.st)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.mgr.write(s.toolID, frame)
}

// Interrupt 는 진행 중 턴을 멈춘다 (FR-AGT-4a Esc). 없으면 ErrUnsupported.
func (s *Session) Interrupt() error {
	s.mu.Lock()
	if s.ad.Proto.Interrupt == nil {
		s.mu.Unlock()
		return agentadapter.ErrUnsupported
	}
	frame := s.ad.Proto.Interrupt(s.st)
	s.mu.Unlock()
	return s.mgr.write(s.toolID, frame)
}

// TUIResume 은 같은 세션을 터미널에서 여는 argv 다 (FR-AGT-10). nil 이면 없다.
func (s *Session) TUIResume() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ad.Proto.TUIResume == nil {
		return nil
	}
	return s.ad.Proto.TUIResume(s.st.SessionID)
}

// feed 는 청크 하나다. 절대 오프셋 위에서 겹침을 버리고 틈을 되메운다 (D-C-2).
func (s *Session) feed(data []byte, end int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.feedLocked(data, end, true)
}

func (s *Session) feedLocked(data []byte, end int64, mayResync bool) {
	if s.exited || len(data) == 0 {
		return
	}
	start := end - int64(len(data))
	if end == 0 || start < 0 {
		// 오프셋을 모르는 옛 데몬 — 그대로 이어 붙인다. 겹침 제거는 건너뛴다.
		s.consume(data)
		return
	}
	if start > s.seen && mayResync {
		// 틈 — 스냅샷으로 되메운다. 그 뒤 이 청크는 겹침으로 읽힌다.
		s.resyncLocked()
	}
	if start > s.seen {
		// 되메우지 못한 틈 — 원문으로 남기고 다음 줄바꿈까지 버린다 (FR-APS-8).
		s.emit(agentadapter.Event{Kind: agentadapter.EvRaw, Text: fmt.Sprintf("gap %d..%d", s.seen, start)})
		s.linebuf = nil
		s.skipLine = true
		s.seen = start
	}
	if start < s.seen {
		if end <= s.seen {
			return
		}
		data = data[s.seen-start:]
	}
	s.consume(data)
	s.seen = end
}

// resync 는 스냅샷으로 seen 뒤를 되메운다 — 열 때, 틈이 보일 때.
func (s *Session) resync() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.resyncLocked()
}

func (s *Session) resyncLocked() {
	if s.mgr.deps.Snapshot == nil {
		return
	}
	snap, err := s.mgr.deps.Snapshot(s.toolID)
	if err != nil || len(snap.Data) == 0 {
		return
	}
	s.feedLocked(snap.Data, snap.End, false)
}

// consume 은 줄을 자른다. 마지막 미완 줄은 다음 청크를 기다린다.
func (s *Session) consume(data []byte) {
	s.linebuf = append(s.linebuf, data...)
	for {
		i := bytes.IndexByte(s.linebuf, '\n')
		if i < 0 {
			return
		}
		line := s.linebuf[:i]
		s.linebuf = s.linebuf[i+1:]
		if s.skipLine {
			s.skipLine = false
			continue
		}
		s.decodeLine(bytes.TrimRight(line, "\r"))
	}
}

// decodeLine 은 한 줄을 어댑터에 묻고 결과를 로그·싱크·활동으로 낸다 (FR-APS-2·8).
func (s *Session) decodeLine(line []byte) {
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	evs, ok := s.ad.Proto.Decode(line, s.st)
	if !ok {
		raw := agentadapter.Event{Kind: agentadapter.EvRaw}
		if bytes.HasPrefix(bytes.TrimSpace(line), []byte("{")) {
			raw.Raw = append([]byte(nil), line...)
		} else {
			raw.Text = string(line)
		}
		s.emit(raw)
		return
	}
	for _, ev := range evs {
		s.emit(ev)
	}
}

// emit 은 이벤트 하나를 로그에 남기고 싱크로 내고 활동을 파생한다. s.mu 아래.
func (s *Session) emit(ev agentadapter.Event) {
	s.merge(ev)
	s.nextSeq++
	le := Logged{Seq: s.nextSeq, At: time.Now().UnixMilli(), Ev: ev}
	s.log = append(s.log, le)
	if over := len(s.log) - s.mgr.deps.LogCap; over > 0 {
		s.log = append([]Logged(nil), s.log[over:]...)
		s.firstSeq = s.log[0].Seq
	}
	s.mgr.deps.Sink.Event(s.toolID, le)
	if state, ok := ev.Activity(); ok {
		tool, detail := "", ""
		if ev.Kind == agentadapter.EvApprovalOpen {
			tool, detail = ev.Tool, ev.Detail
		}
		s.mgr.deps.Sink.Activity(s.toolID, state, tool, detail, false)
	}
}

// merge 는 status·usage 의 채워진 값만 덮는다 (FR-APS-4 — 빈 값은 부재다).
func (s *Session) merge(ev agentadapter.Event) {
	if st := ev.Status; st != nil {
		if st.Model != "" {
			s.status.Model = st.Model
		}
		if st.PermissionMode != "" {
			s.status.PermissionMode = st.PermissionMode
		}
		if len(st.Models) > 0 {
			s.status.Models = st.Models
		}
		if len(st.Commands) > 0 {
			s.status.Commands = st.Commands
		}
		if st.Account != "" {
			s.status.Account = st.Account
		}
	}
	if u := ev.Usage; u != nil {
		if u.Tokens > 0 {
			s.usage.Tokens = u.Tokens
		}
		if u.OutputTokens > 0 {
			s.usage.OutputTokens = u.OutputTokens
		}
		if u.ContextWindow > 0 {
			s.usage.ContextWindow = u.ContextWindow
		}
		if u.CostUSD > 0 {
			s.usage.CostUSD = u.CostUSD
		}
		if u.Model != "" {
			s.usage.Model = u.Model
		}
	}
	if ev.Kind == agentadapter.EvReset && ev.SessionID != "" {
		s.st.SessionID = ev.SessionID
	}
}

// TUIResumeLine 은 TUIResume argv 를 셸에 타이핑할 한 줄로 — 인용은 quote 가 한다
// (플랫폼의 셸이 다르다, agentadapter.LaunchLine 과 같은 규약). 셸이 특별히 읽을
// 글자가 없는 인자는 그대로 둔다 — 사용자가 그 줄을 터미널에서 읽는다.
func TUIResumeLine(argv []string, quote func(string) string) string {
	if len(argv) == 0 {
		return ""
	}
	parts := make([]string, 0, len(argv))
	for i, a := range argv {
		if i == 0 || isShellPlain(a) {
			parts = append(parts, a)
			continue
		}
		parts = append(parts, quote(a))
	}
	return strings.Join(parts, " ")
}

func isShellPlain(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == '/', r == ':', r == '=', r == '+', r == '@', r == '%':
		default:
			return false
		}
	}
	return true
}
