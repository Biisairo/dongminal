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
	"sync/atomic"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// ErrNoSession 은 그 도구에 세션이 없다 — 에이전트 도구가 아니거나 닫혔다.
var ErrNoSession = errors.New("agent_session_not_found")

// DefaultLogCap 은 도구마다의 이벤트 로그 상한이다 (NFR-C-2, P3 값).
const DefaultLogCap = 4096

// DefaultExitWait 는 휴면 절차가 프로세스의 exit 관측을 기다리는 상한이다 (D-C-15). 그 안에
// 오지 않으면(옛 데몬·경합) 휴면으로 마감한다 — stop 이 이미 성공한 뒤다.
const DefaultExitWait = 3 * time.Second

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
	// DataDir 은 디스크 로그·휴면 레코드의 자리다 (D-C-12·14). 비면 디스크가 없다.
	DataDir string
	// ExitWait 는 휴면 절차의 exit 대기 상한. 0 이면 DefaultExitWait.
	ExitWait time.Duration
	// Adapter 는 레코드의 어댑터 id 를 어댑터로 — 부팅(Restore)이 쓴다. nil 이면 등록부
	// (`agentadapter.Get`). 테스트가 장난감 어댑터를 꽂는 자리다.
	Adapter func(id string) (agentadapter.Adapter, error)
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
	if d.ExitWait <= 0 {
		d.ExitWait = DefaultExitWait
	}
	if d.Adapter == nil {
		d.Adapter = agentadapter.Get
	}
	return &Manager{deps: d, sess: map[string]*Session{}}
}

// Open 은 도구에 세션을 세운다. 핸드셰이크를 보내고 지금까지의 출력을 스냅샷으로
// 되메운다 — 세션이 붙기 전에 나온 첫 프레임을 놓치지 않기 위해서다 (D-C-2).
// 이미 있으면 그것을 돌려준다. opts 는 기동에 쓴 것 그대로다 — 핸드셰이크가 그것을
// 프레임으로 옮기는 어댑터가 있다 (P4 codex).
func (m *Manager) Open(toolID string, ad agentadapter.Adapter, opts agentadapter.LaunchOpts) (*Session, error) {
	if ad.Proto == nil {
		return nil, fmt.Errorf("%s: 프로토콜 표면이 없다 (FR-APS-4)", ad.ID)
	}
	m.mu.Lock()
	if s, ok := m.sess[toolID]; ok {
		m.mu.Unlock()
		return s, nil
	}
	s := &Session{toolID: toolID, ad: ad, st: agentadapter.NewProtoState(), mgr: m, firstSeq: 1, opts: opts, at: time.Now().UnixMilli()}
	s.st.SessionID = opts.Resume
	m.sess[toolID] = s
	m.mu.Unlock()
	s.handshake(opts)
	m.saveRecords()
	return s, nil
}

// handshake 는 어댑터의 첫 프레임들을 보내고 지금까지의 출력을 되메운다 — 열 때와 재개 때.
func (s *Session) handshake(opts agentadapter.LaunchOpts) {
	if s.ad.Proto.Handshake != nil {
		s.mu.Lock()
		frames := s.ad.Proto.Handshake(opts, s.st)
		s.mu.Unlock()
		for _, fr := range frames {
			if err := s.mgr.write(s.toolID, fr); err != nil {
				dmlog.Warnf(nil, "[agent %s] handshake write: %v", s.toolID, err)
			}
		}
	}
	s.resync()
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
	// resyncing 은 틈을 메울 고루틴이 떠 있다는 뜻이다 — 둘을 띄우지 않는다.
	resyncing bool

	log      []Logged
	firstSeq int64
	nextSeq  int64
	// snap 은 링에서 버려진 이벤트의 접힘이다 (D-C-13). 처음 버릴 때 선다.
	snap *Snapshot
	// droppedSinceCompact·logBytes 는 디스크 로그의 압축 조건이다 (D-C-12).
	droppedSinceCompact int
	logBytes            int64

	status agentadapter.ProtoStatus
	usage  agentadapter.ProtoUsage

	// opts 는 기동에 쓴 것이다 — 재개 옵션·레코드의 근거. at 은 세션이 선 시각.
	opts agentadapter.LaunchOpts
	at   int64
	// dormant 는 프로세스 없는 상태다 (D-C-11): "" 활성 · DormantHibernated · DormantError.
	// reason 은 그 사유(exit 의 Detail 또는 ReasonServerRestart). pending 은 지금 진행 중인
	// 절차가 exit 에 붙일 사유다 — 휴면 중이면 ExitHibernated. exitWait 는 그 절차가 exit 를
	// 기다리는 채널이다.
	dormant  string
	reason   string
	pending  string
	exitWait chan struct{}
	// dormantAt 은 dormant 가 선 시각(ms)이다 — Reap 의 유예가 이것을 잰다 (D-A-23).
	dormantAt int64
	// recordDirty 는 레코드를 다시 써야 한다는 표시다 — emit 이 세우고 flushRecord 가 내린다.
	// recordKey 는 마지막으로 표시를 세운 근거다.
	recordDirty atomic.Bool
	recordKey   string
}

// flushRecord 는 표시가 섰으면 레코드를 다시 쓴다. s.mu 밖에서 부른다.
func (s *Session) flushRecord() {
	if s.recordDirty.CompareAndSwap(true, false) {
		s.mgr.saveRecords()
	}
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
	// Exited 는 프로세스가 없다는 뜻이다 — Dormant 가 비어 있지 않은 것과 같다 (P3 의 이름).
	Exited bool `json:"exited,omitempty"`
	// Dormant·Reason·Resumable 은 휴면·오류 상태다 (D-C-11·15). Resumable 은 신원이 있어
	// 재개가 가능하다는 뜻 — 뷰는 그때만 재개 버튼을 놓는다 (FR-ABG-20 "재개가 가능하면").
	Dormant   string `json:"dormant,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Resumable bool   `json:"resumable,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
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
		Exited:          s.dormant != "",
		Dormant:         s.dormant, Reason: s.reason, Resumable: s.dormant != "" && s.st.SessionID != "",
		Cwd: s.opts.Cwd,
	}
}

// Events 는 since 뒤의 로그다 (D-C-3). truncated 는 since 가 가리키는 자리가 이미
// 잘렸다는 뜻 — 브라우저는 그때 "이전 기록은 잘렸다" 를 보인다 (FR-ABG-21).
func (s *Session) Events(since int64) (evs []Logged, truncated bool) {
	evs, truncated, _ = s.Replay(since)
	return evs, truncated
}

// Replay 는 Events 에 요약 스냅샷을 더한 것이다 (D-C-13) — snap 은 truncated 일 때만 있다.
func (s *Session) Replay(since int64) (evs []Logged, truncated bool, snap *Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// since 는 "이것까지 보았다" 다. 다음은 since+1 이고, 그것이 firstSeq 앞이면 잘렸다.
	if since+1 < s.firstSeq {
		truncated = true
		snap = s.snap.clone()
	}
	for _, le := range s.log {
		if le.Seq > since {
			evs = append(evs, le)
		}
	}
	return evs, truncated, snap
}

// Prompt 는 사용자 입력이다 (FR-AAL-2 — 표시를 세우는 것은 우리가 보낸 입력이다).
func (s *Session) Prompt(text string) error {
	s.mu.Lock()
	if s.dormant != "" {
		s.mu.Unlock()
		return ErrDormant
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
	s.feedLocked(data, end, true)
	s.mu.Unlock()
	s.flushRecord()
}

func (s *Session) feedLocked(data []byte, end int64, mayResync bool) {
	if s.dormant != "" || len(data) == 0 {
		return
	}
	start := end - int64(len(data))
	if end == 0 || start < 0 {
		// 오프셋을 모르는 옛 데몬 — 그대로 이어 붙인다. 겹침 제거는 건너뛴다.
		s.consume(data)
		return
	}
	if start > s.seen && mayResync {
		// 틈 — 스냅샷으로 되메운다. **비동기로** (P5): 이 함수는 데몬 모드에서 ToolClient 의
		// readLoop 안이고 Snapshot 은 그 readLoop 이 응답을 읽어야 끝나는 RPC 다 — 여기서
		// 부르면 §2-25 와 같은 5초 정체 뒤 연결이 떨어진다 (되살림 뒤 첫 청크가 그 자리였다).
		// 이 청크는 버린다 — 스냅샷이 이것을 포함해 seen 뒤를 전부 가져온다.
		s.scheduleResync()
		return
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

// resync 는 스냅샷으로 seen 뒤를 되메운다 — 열 때(동기), 틈이 보일 때(scheduleResync 의
// 고루틴). 스냅샷은 잠금 밖에서 받는다 — 데몬 모드에서는 RPC 다.
func (s *Session) resync() {
	var snap toolhub.ToolSnapshot
	var err error
	if s.mgr.deps.Snapshot != nil {
		snap, err = s.mgr.deps.Snapshot(s.toolID)
	}
	s.mu.Lock()
	s.resyncing = false
	if err == nil && len(snap.Data) > 0 {
		s.feedLocked(snap.Data, snap.End, false)
	}
	s.mu.Unlock()
	s.flushRecord()
}

// scheduleResync 는 되메움을 한 번만 띄운다. s.mu 아래.
func (s *Session) scheduleResync() {
	if s.resyncing || s.mgr.deps.Snapshot == nil {
		return
	}
	s.resyncing = true
	go s.resync()
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
	s.appendLog(le)
	if over := len(s.log) - s.mgr.deps.LogCap; over > 0 {
		// 버려지는 것은 스냅샷으로 접힌다 (D-C-13) — 지금 상태의 복사가 아니다.
		if s.snap == nil {
			s.snap = &Snapshot{}
		}
		for _, d := range s.log[:over] {
			s.snap.fold(d)
		}
		s.droppedSinceCompact += over
		s.log = append([]Logged(nil), s.log[over:]...)
		s.firstSeq = s.log[0].Seq
		if s.droppedSinceCompact >= s.mgr.deps.LogCap || s.logBytes > diskLogMaxBytes {
			s.compactLog()
		}
	}
	s.mgr.deps.Sink.Event(s.toolID, le)
	// 레코드의 근거(신원·권한 모드·모델)가 바뀌었으면 표시만 세운다 (D-C-14) — 쓰는 것은 잠금을
	// 놓은 뒤 flushRecord 다 (saveRecords 가 다른 세션의 잠금을 잡는다). 신원은 어댑터가 Decode
	// 안에서 st 에 쓰므로 이벤트 전후가 아니라 **마지막으로 적은 값**과 견준다.
	if k := s.st.SessionID + "\x00" + s.status.PermissionMode + "\x00" + s.status.Model; k != s.recordKey {
		s.recordKey = k
		s.recordDirty.Store(true)
	}
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
	mergeStatus(&s.status, ev.Status)
	mergeUsage(&s.usage, ev.Usage)
	if ev.Kind == agentadapter.EvReset && ev.SessionID != "" {
		s.st.SessionID = ev.SessionID
	}
}

func mergeStatus(dst *agentadapter.ProtoStatus, st *agentadapter.ProtoStatus) {
	if st == nil {
		return
	}
	if st.Model != "" {
		dst.Model = st.Model
	}
	if st.PermissionMode != "" {
		dst.PermissionMode = st.PermissionMode
	}
	if len(st.Models) > 0 {
		dst.Models = st.Models
	}
	if len(st.Commands) > 0 {
		dst.Commands = st.Commands
	}
	if st.Account != "" {
		dst.Account = st.Account
	}
}

func mergeUsage(dst *agentadapter.ProtoUsage, u *agentadapter.ProtoUsage) {
	if u == nil {
		return
	}
	if u.Tokens > 0 {
		dst.Tokens = u.Tokens
	}
	if u.OutputTokens > 0 {
		dst.OutputTokens = u.OutputTokens
	}
	if u.ContextWindow > 0 {
		dst.ContextWindow = u.ContextWindow
	}
	if u.CostUSD > 0 {
		dst.CostUSD = u.CostUSD
	}
	if u.Model != "" {
		dst.Model = u.Model
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
