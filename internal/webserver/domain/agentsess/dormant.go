package agentsess

import (
	"encoding/json"
	"errors"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// 휴면·오류 (M8_UNIFIED_SRS 묶음 B — FR-ABG-10·11·20·21, D-C-11~17). 프로세스의 끝은 세션을
// 지우지 않는다 — 세션은 프로세스 없는 상태(dormant)로 남고, 같은 toolId 로 재개된다.
// 지우는 것은 사용자의 닫기(Forget) 하나다.

// Dormant 의 값. 빈 문자열은 활성이다.
const (
	DormantHibernated = "hibernated"
	DormantError      = "error"
)

// EvExit 의 Text — 종료의 사유다 (D-C-15). 뷰가 이것으로 갈린다.
const (
	ExitHibernated = "hibernated"
	ExitClosed     = "closed"
	ExitDied       = "died"
)

// ReasonServerRestart 는 서버가 다시 섰을 때 프로세스가 없던 세션의 사유다 (D-C-14).
const ReasonServerRestart = "server_restart"

var (
	// ErrDormant 는 프로세스 없는 세션에 프로세스가 필요한 일을 청했다 (프롬프트·휴면).
	ErrDormant = errors.New("agent_dormant")
	// ErrNotDormant 는 활성 세션을 재개하려 했다.
	ErrNotDormant = errors.New("agent_not_dormant")
	// ErrNoIdentity 는 세션 신원이 없어 휴면할 수 없다 (D-C-16 — claude 의 첫 턴 전).
	ErrNoIdentity = errors.New("agent_no_identity")
)

// Snapshot 은 링에서 버려진 이벤트의 접힘이다 (D-C-13, FR-ABG-21). Seq 는 접힌 마지막 seq —
// 남은 이벤트는 Seq+1 부터다.
type Snapshot struct {
	Seq         int64                          `json:"seq"`
	SessionID   string                         `json:"sessionId,omitempty"`
	Status      agentadapter.ProtoStatus       `json:"status"`
	Usage       agentadapter.ProtoUsage        `json:"usage"`
	Open        []agentadapter.ApprovalRequest `json:"open"`
	LastMessage json.RawMessage                `json:"lastMessage,omitempty"`
}

// clone 은 잠금 밖으로 나가는 복사다 — fold 가 Open 을 이어 붙이므로 그 배열을 공유하지 않는다.
func (p *Snapshot) clone() *Snapshot {
	if p == nil {
		return nil
	}
	c := *p
	c.Open = append([]agentadapter.ApprovalRequest(nil), p.Open...)
	return &c
}

// fold 는 버려지는 이벤트 하나를 접는다.
func (p *Snapshot) fold(le Logged) {
	ev := le.Ev
	p.Seq = le.Seq
	mergeStatus(&p.Status, ev.Status)
	mergeUsage(&p.Usage, ev.Usage)
	switch ev.Kind {
	case agentadapter.EvSession, agentadapter.EvReset:
		if ev.SessionID != "" {
			p.SessionID = ev.SessionID
		}
	case agentadapter.EvMessage:
		if len(ev.Message) > 0 {
			p.LastMessage = ev.Message
		}
	case agentadapter.EvApprovalOpen:
		if ev.Approval != nil {
			p.Open = append(p.Open, *ev.Approval)
		}
	case agentadapter.EvApprovalClosed:
		if ev.Approval != nil {
			for i, r := range p.Open {
				if r.ID == ev.Approval.ID {
					p.Open = append(p.Open[:i], p.Open[i+1:]...)
					break
				}
			}
		}
	}
}

// Exit 은 도구 프로세스의 끝이다 (FR-ABG-20) — exit 이벤트가 사유를 들고(D-C-15) 세션은
// 휴면(절차 중이었으면) 또는 오류 상태로 남는다. 세션이 없으면(닫혔다) 아무 일도 없다.
func (m *Manager) Exit(toolID string, info toolhub.ExitInfo) {
	s := m.Get(toolID)
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.dormant != "" {
		s.mu.Unlock()
		return
	}
	reason, state := ExitDied, DormantError
	if s.pending == ExitHibernated {
		reason, state = ExitHibernated, DormantHibernated
	}
	detail := info.String()
	s.dormant, s.reason, s.pending = state, detail, ""
	s.emit(agentadapter.Event{Kind: agentadapter.EvExit, Text: reason, Detail: detail, IsError: reason == ExitDied})
	wait := s.exitWait
	s.exitWait = nil
	s.mu.Unlock()
	if wait != nil {
		close(wait)
	}
	m.saveRecords()
}

// Hibernate 는 명시적 휴면이다 (FR-ABG-11). stop 이 프로세스를 끝내고(`ToolHub.Delete`), 그 exit
// 관측이 세션을 휴면으로 마감한다. 신원이 없으면 ErrNoIdentity — 되살릴 길이 없다 (D-C-16).
func (m *Manager) Hibernate(toolID string, stop func() error) error {
	s := m.Get(toolID)
	if s == nil {
		return ErrNoSession
	}
	s.mu.Lock()
	if s.dormant != "" {
		s.mu.Unlock()
		return ErrDormant
	}
	if s.st.SessionID == "" {
		s.mu.Unlock()
		return ErrNoIdentity
	}
	wait := make(chan struct{})
	s.pending, s.exitWait = ExitHibernated, wait
	s.mu.Unlock()
	if err := stop(); err != nil {
		s.mu.Lock()
		s.pending, s.exitWait = "", nil
		s.mu.Unlock()
		return err
	}
	select {
	case <-wait:
	case <-time.After(m.deps.ExitWait):
		// exit 이 오지 않았다 — stop 은 성공했으니 프로세스는 없다. 여기서 마감한다.
		m.Exit(toolID, toolhub.ExitInfo{})
	}
	return nil
}

// Reopen 은 재개다 (FR-ABG-10) — 호출자가 같은 toolId 로 새 프로세스를 세운 뒤 부른다.
// 어댑터 상태는 새로 서되 신원은 opts.Resume 이고, 오프셋은 0 부터, seq 는 이어진다 (D-C-11).
func (m *Manager) Reopen(toolID string, opts agentadapter.LaunchOpts) error {
	s := m.Get(toolID)
	if s == nil {
		return ErrNoSession
	}
	s.mu.Lock()
	if s.dormant == "" {
		s.mu.Unlock()
		return ErrNotDormant
	}
	s.st = agentadapter.NewProtoState()
	s.st.SessionID = opts.Resume
	s.seen, s.linebuf, s.skipLine = 0, nil, false
	s.dormant, s.reason, s.pending = "", "", ""
	s.opts = opts
	s.mu.Unlock()
	s.handshake(opts)
	m.saveRecords()
	return nil
}

// ResumeOpts 는 이 세션을 되살릴 기동 옵션이다 (D-C-14) — Model 은 싣지 않는다 (U-4: 셋 다
// 세션이 기억한다). Bin 은 호출자가 채운다.
func (s *Session) ResumeOpts() agentadapter.LaunchOpts {
	r := s.record()
	return agentadapter.LaunchOpts{Cwd: r.Cwd, Resume: r.SessionID, Approval: r.Approval, PermissionMode: r.PermissionMode}
}

// Forget 은 사용자의 닫기다 — 세션·레코드·로그를 지운다. 그 뒤 오는 exit 은 무해하다.
func (m *Manager) Forget(toolID string) {
	m.mu.Lock()
	_, ok := m.sess[toolID]
	delete(m.sess, toolID)
	m.mu.Unlock()
	if !ok {
		return
	}
	m.removeLog(toolID)
	m.saveRecords()
}

// Dormant 는 프로세스 없는 세션들을 도구 목록의 모양으로 낸다 (D-C-17) — `/api/state` 가
// toolhub 의 목록에 합친다. 활성 세션은 toolhub 가 이미 안다.
func (m *Manager) Dormant() []toolhub.ToolInfo {
	m.mu.Lock()
	sess := make([]*Session, 0, len(m.sess))
	for _, s := range m.sess {
		sess = append(sess, s)
	}
	m.mu.Unlock()
	var out []toolhub.ToolInfo
	for _, s := range sess {
		s.mu.Lock()
		if s.dormant != "" {
			out = append(out, toolhub.ToolInfo{ID: s.toolID, Name: s.ad.ID, Kind: toolhub.KindAgent, Agent: s.ad.ID, Dormant: s.dormant})
		}
		s.mu.Unlock()
	}
	return out
}

// Restore 는 부팅이다 (D-C-14). 레코드마다 — 도구가 살아 있으면(데몬 모드) Resume 으로 채택해
// 핸드셰이크한다(codex 는 살아 있는 thread 를 rejoin 한다) · 없으면 디스크 로그에서 오류
// 상태로 되살린다 · 신원이 없거나 어느 탭도 참조하지 않으면 버린다. SSE 는 내지 않는다 —
// 브라우저는 재생으로 읽는다.
func (m *Manager) Restore(alive, referenced func(toolID string) bool) {
	if m.deps.DataDir == "" {
		return
	}
	recs := loadRecords(m.recordsPath())
	for id, r := range recs {
		ad, err := m.deps.Adapter(r.Agent)
		if err != nil || ad.Proto == nil || r.SessionID == "" || !referenced(id) {
			dmlog.Infof(nil, "[agent %s] 레코드를 버린다 (agent=%q sid=%q referenced=%v)", id, r.Agent, r.SessionID, referenced(id))
			m.removeLog(id)
			continue
		}
		opts := agentadapter.LaunchOpts{Cwd: r.Cwd, Resume: r.SessionID, Approval: r.Approval, PermissionMode: r.PermissionMode}
		s := &Session{toolID: id, ad: ad, st: agentadapter.NewProtoState(), mgr: m, firstSeq: 1, opts: opts, at: r.At}
		s.st.SessionID = r.SessionID
		s.rebuildFromLog(m.logPath(id), r.LastSeq)
		if alive(id) {
			m.mu.Lock()
			m.sess[id] = s
			m.mu.Unlock()
			s.handshake(opts)
			continue
		}
		s.dormant, s.reason = DormantError, ReasonServerRestart
		m.mu.Lock()
		m.sess[id] = s
		m.mu.Unlock()
	}
	m.saveRecords()
}

// rebuildFromLog 는 디스크 로그로 링·스냅샷·합쳐진 상태(status·usage·열린 요청)를 되살린다.
// 스냅샷이 버려진 구간의 접힘이므로 그것을 먼저 놓고 남은 이벤트를 위에 접는다.
func (s *Session) rebuildFromLog(path string, lastSeq int64) {
	s.snap, s.log, s.logBytes = loadLog(path)
	if s.snap != nil {
		s.firstSeq, s.nextSeq = s.snap.Seq+1, s.snap.Seq
		s.status, s.usage = s.snap.Status, s.snap.Usage
		for _, r := range s.snap.Open {
			s.st.Open[r.ID] = r
		}
	}
	if len(s.log) > 0 {
		s.firstSeq, s.nextSeq = s.log[0].Seq, s.log[len(s.log)-1].Seq
	}
	if s.nextSeq < lastSeq {
		s.nextSeq = lastSeq
	}
	for _, le := range s.log {
		s.merge(le.Ev)
		if a := le.Ev.Approval; a != nil {
			switch le.Ev.Kind {
			case agentadapter.EvApprovalOpen:
				s.st.Open[a.ID] = *a
			case agentadapter.EvApprovalClosed:
				delete(s.st.Open, a.ID)
			}
		}
	}
}
