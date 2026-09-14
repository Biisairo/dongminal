package agentsess

import (
	"bytes"
	"fmt"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/toolhub"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `session.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **바이트가 이벤트가 되는 길**이다 — 청크·줄·해석·기록·파생.
// `session.go` 에 남은 것은 세션의 **표면**(상태·재생·프롬프트·승인·제어)이며,
// 프로토콜이 바뀌면 이쪽만 흔들린다.

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
