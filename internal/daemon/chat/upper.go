package chat

import (
	"encoding/json"
	"time"

	"dongminal/internal/shared/edgemesh"
)

// 채팅은 간선 연결 위에 얹힌 위층이다 (EDGE_MESH_SRS FR-EGM-40). 연결·다시 걸기·생존 확인은
// 간선 계층이 하고, 채팅은 자기 프레임(state·msg·cmd)만 다룬다.

// Frame 은 간선 계층이 넘긴 채팅 프레임이다. from 은 받은 간선 연결의 상대다.
func (s *Service) Frame(from string, fr frame) { s.handle(from, fr) }

// Linked 는 새 간선 연결이다. 자기 상태와 아는 노드들의 상태를 처음 줄로 넣는다 — 받는 쪽은
// 상태를 글보다 먼저 받는다 (FR-EGM-6).
func (s *Service) Linked(fp string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.opts.Mesh == nil {
		return
	}
	lines := [][]byte{edgemesh.Encode(s.own)}
	for _, r := range s.nodes {
		lines = append(lines, edgemesh.Encode(r.raw))
	}
	s.edgeCache = nil // 새 연결은 대개 간선이 바뀐 뒤다 — 고정 판정이 낡은 목록을 보지 않게 한다
	s.opts.Mesh.Open(fp, lines)
}

// Changed 는 망 그림이 바뀌었다는 간선 계층의 알림이다. 개인채팅을 맞추고 바뀜을 알린다.
func (s *Service) Changed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.changedLocked()
	}
}

func (s *Service) handle(from string, fr frame) {
	switch fr.T {
	case frameState:
		s.mu.Lock()
		var pin func()
		if _, ok := s.acceptStateLocked(fr); ok {
			s.broadcastLocked(fr, from)
			s.changedLocked()
		}
		// 간선 상대 자신의 연결로 온 상태는, 같은 번호를 다른 길로 먼저 받았어도 고정을 확인한다
		// (§3.12a R-6, EDGE_MESH_SRS FR-EGM-44). 그 상대의 최신 상태(s.nodes)로 본다.
		pin = s.pinLocked(from)
		s.mu.Unlock()
		if pin != nil {
			pin()
		}
	case frameCmd:
		s.mu.Lock()
		if s.acceptCmdLocked(fr) {
			s.broadcastLocked(fr, from)
			s.changedLocked()
		}
		s.mu.Unlock()
	case frameMsg:
		s.mu.Lock()
		out, ok := s.acceptMsgLocked(fr)
		if ok {
			s.broadcastLocked(fr, from)
		}
		s.mu.Unlock()
		s.deliver(out)
	}
}

// broadcastLocked 는 fr 을 skip 을 뺀 모든 간선 연결로 보낸다 (FR-PCH-4). 간선 계층의 잠금은
// 채팅 잠금 안에서 잡아도 된다 (NFR-EGM-1).
func (s *Service) broadcastLocked(fr frame, skip string) {
	if s.opts.Mesh != nil {
		s.opts.Mesh.Broadcast(fr, skip)
	}
}

// acceptStateLocked 는 바르고 더 새로운 노드 상태 알림만 받고 그 노드 지문을 돌려준다
// (FR-PCH-5·9·20).
func (s *Service) acceptStateLocked(fr frame) (string, bool) {
	var st stateBody
	if json.Unmarshal(fr.B, &st) != nil || st.Node == s.id.Fingerprint {
		return "", false
	}
	pub, ok := parseKey(st.Node, st.Key)
	if !ok || !verify(pub, frameState, fr.B, fr.S) || !validState(st) {
		return "", false
	}
	if old, ok := s.nodes[st.Node]; ok {
		if !newer(st, old.st.Epoch, old.st.Seq) {
			return "", false
		}
	} else {
		m, marked := s.marks[st.Node]
		if marked && !newer(st, m.epoch, m.stateSeq) {
			return "", false
		}
		if len(s.nodes) >= s.maxNodes && !s.evictLocked() {
			return "", false
		}
		if marked {
			delete(s.marks, st.Node)
			if st.Epoch == m.epoch {
				s.wins[st.Node] = m.window()
			}
		}
	}
	rooms := map[string]room{}
	for _, rec := range st.Rooms {
		if b, ok := openRecord(rec); ok {
			rooms[rec.id()] = room{rec: rec, body: b}
		}
	}
	s.nodes[st.Node] = &remote{st: st, key: pub, raw: fr, rooms: rooms, at: s.now()}
	return st.Node, true
}

func newer(st stateBody, epoch int64, seq uint64) bool {
	return st.Epoch > epoch || st.Epoch == epoch && st.Seq > seq
}

// evictLocked 는 닿지 않는 노드 가운데 가장 오래 소식이 없는 것을 잊는다. 이 노드의 개인채팅에
// 걸린 노드는 잊지 않는다. 잊은 노드의 마지막 번호는 남겨, 옛 상태와 옛 글을 다시 받지 않는다.
// 잊을 것이 없으면 거짓이다.
func (s *Service) evictLocked() bool {
	reach := s.reachableLocked()
	pinned := map[string]bool{}
	for _, r := range s.rooms {
		if r.body.Kind == KindDirect {
			pinned[r.body.Creator], pinned[r.body.PeerNode] = true, true
		}
	}
	victim := ""
	var at time.Time
	for fp, r := range s.nodes {
		if reach[fp] || pinned[fp] {
			continue
		}
		if victim == "" || r.at.Before(at) {
			victim, at = fp, r.at
		}
	}
	if victim == "" {
		return false
	}
	r := s.nodes[victim]
	m := mark{epoch: r.st.Epoch, stateSeq: r.st.Seq, at: s.now()}
	if w := s.wins[victim]; w != nil && w.epoch == r.st.Epoch {
		m.msgMax = w.max
	}
	s.rememberLocked(victim, m)
	delete(s.nodes, victim)
	delete(s.wins, victim)
	return true
}

// mark 는 잊은 노드의 마지막 번호다.
type mark struct {
	epoch    int64
	stateSeq uint64
	msgMax   uint64
	at       time.Time
}

// window 는 msgMax 까지를 모두 본 것으로 치는 순서 창이다.
func (m mark) window() *seqWindow {
	w := &seqWindow{epoch: m.epoch, max: m.msgMax}
	for i := range w.bits {
		w.bits[i] = true
	}
	return w
}

func (s *Service) rememberLocked(fp string, m mark) {
	if len(s.marks) >= maxMarks {
		oldest := ""
		for k, v := range s.marks {
			if oldest == "" || v.at.Before(s.marks[oldest].at) {
				oldest = k
			}
		}
		delete(s.marks, oldest)
	}
	s.marks[fp] = m
}

func validState(st stateBody) bool {
	if len(st.Parts) > maxParts || len(st.Rooms) > maxNodeRooms {
		return false
	}
	if !validHelperKey(st.Helper) || len(st.Pins) > maxNodes {
		return false
	}
	for fp, k := range st.Pins {
		if len(fp) != idPrefix || !validID(fp) || k == "" || !validHelperKey(k) {
			return false
		}
	}
	for _, p := range st.Parts {
		if len(p.Rooms) > maxPartRooms || !validID(p.ID) || !boundTo(p.ID, st.Node) || !validText(p.Label, maxLabel) {
			return false
		}
	}
	return true
}

// acceptMsgLocked 는 처음 보는 바른 글을 받고, 이 노드의 그 방 참가자에게 넘길 것을 돌려준다.
// 보낸 노드의 최신 상태에서 보낸 이가 그 방에 들어 있어야 하고, 개인채팅이면 두 참가자 중
// 하나여야 한다. 같은 글과 지난 글은 보낸 노드마다의 순서 창으로 거른다 (§3.9).
func (s *Service) acceptMsgLocked(fr frame) ([]pending, bool) {
	var b msgBody
	if json.Unmarshal(fr.B, &b) != nil || b.Node == s.id.Fingerprint || !validID(b.ID) || b.ID == "" {
		return nil, false
	}
	r, ok := s.nodes[b.Node]
	if !ok || b.Epoch != r.st.Epoch || !verify(r.key, frameMsg, fr.B, fr.S) ||
		len(b.Text) > MaxText || !validBody(b.Text) || !partInRoom(r.st, b.From, b.Room) {
		return nil, false
	}
	rm, ok := s.recordLocked(b.Room)
	if !ok || !partyOK(rm, b.Node, b.From) {
		return nil, false
	}
	w := s.wins[b.Node]
	if w == nil {
		w = &seqWindow{}
		s.wins[b.Node] = w
	}
	if !w.accept(b.Epoch, b.Seq) {
		return nil, false
	}
	if !s.recvRate.allow(b.Node + "/" + b.From) {
		return nil, false
	}
	label, kind := "", ""
	for _, sp := range r.st.Parts {
		if sp.ID == b.From {
			label, kind = sp.Label, sp.Kind
		}
	}
	return s.localDeliveriesLocked(b, label, kind), true
}

func short(fp string) string {
	if len(fp) > 12 {
		return fp[:12]
	}
	return fp
}
