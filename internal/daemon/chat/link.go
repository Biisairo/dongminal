package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
)

const (
	// Proto 는 채팅 연결의 Upgrade 프로토콜 이름이고, Path 는 그 노드 포트 경로다 (§3.9).
	Proto = "dmchat1"
	Path  = "/edge/v1/chat"
	// maxLine 은 프레임 한 줄의 상한이다. 노드 상태 알림(참가자 64 × 방 64, 방 기록 128)을 덮는다.
	maxLine = 1 << 20
	// outQueue 는 연결 하나의 보낼 줄 상한이다. 넘치면 느린 상대로 보고 끊는다.
	outQueue = 1024
	// 다시 걸기 간격의 처음과 끝이다 (FR-PCH-8).
	redialMin = time.Second
	redialMax = 60 * time.Second
)

var pingLine = []byte(`{"t":"ping"}` + "\n")

// peerLink 는 간선 상대 하나와의 채팅 연결이다.
type peerLink struct {
	fp string
	// dialer 는 이 연결을 건 노드의 지문이다. 중복 연결 정리에 쓴다.
	dialer   string
	conn     net.Conn
	out      chan []byte
	done     chan struct{}
	once     sync.Once
	lastSeen atomic.Int64
}

func (l *peerLink) close() {
	l.once.Do(func() {
		close(l.done)
		_ = l.conn.Close()
	})
}

// send 는 줄 하나를 보낼 줄에 넣는다. 가득 차면 연결을 끊는다.
func (l *peerLink) send(line []byte) {
	select {
	case l.out <- line:
	case <-l.done:
	default:
		l.close()
	}
}

func (l *peerLink) writeLoop() {
	for {
		select {
		case <-l.done:
			return
		case line := <-l.out:
			if _, err := l.conn.Write(line); err != nil {
				l.close()
				return
			}
		}
	}
}

func encode(fr frame) []byte {
	raw, _ := json.Marshal(fr)
	return append(raw, '\n')
}

// Handler 는 노드 포트의 채팅 연결 경로다. 판정은 노드 포트가 이미 했다 — 간선 상대만 닿는다.
func (s *Service) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, ok := edge.AcceptUpgrade(w, r, Proto)
		if !ok {
			return
		}
		s.attach(edge.ClientFingerprint(r), conn, false)
	})
}

// attach 는 상대 fp 와의 연결을 붙인다. 같은 상대와 이미 연결이 있으면 하나만 남긴다:
// 지문이 작은 쪽이 건 연결을 남기고, 같으면 새 연결을 남긴다 (§3.9).
func (s *Service) attach(fp string, conn net.Conn, dialed bool) {
	l := &peerLink{fp: fp, conn: conn, out: make(chan []byte, outQueue), done: make(chan struct{})}
	l.dialer = fp
	if dialed {
		l.dialer = s.id.Fingerprint
	}
	l.lastSeen.Store(s.now().UnixNano())
	s.mu.Lock()
	if s.closed || fp == "" || fp == s.id.Fingerprint {
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	var replaced *peerLink
	if old, ok := s.links[fp]; ok {
		if !s.preferNew(old, l) {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		replaced = old
	}
	s.links[fp] = l
	go l.writeLoop()
	l.send(encode(s.own))
	for _, r := range s.nodes {
		l.send(encode(r.raw))
	}
	s.changedLocked()
	s.mu.Unlock()
	if replaced != nil {
		replaced.close()
	}
	go s.readLoop(l)
}

func (s *Service) preferNew(old, l *peerLink) bool {
	lo := min(s.id.Fingerprint, l.fp)
	if old.dialer == lo && l.dialer != lo {
		return false
	}
	return true
}

func (s *Service) detach(l *peerLink) {
	l.close()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.links[l.fp] != l {
		return
	}
	delete(s.links, l.fp)
	if !s.closed {
		s.changedLocked()
	}
}

func (s *Service) readLoop(l *peerLink) {
	defer s.detach(l)
	sc := bufio.NewScanner(l.conn)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		l.lastSeen.Store(s.now().UnixNano())
		var fr frame
		if json.Unmarshal(sc.Bytes(), &fr) != nil {
			return
		}
		s.handle(l, fr)
	}
}

func (s *Service) handle(from *peerLink, fr frame) {
	switch fr.T {
	case frameState:
		s.mu.Lock()
		var pin func()
		if fp, ok := s.acceptStateLocked(fr); ok {
			s.broadcastLocked(fr, from)
			pin = s.pinLocked(from, fp)
			s.changedLocked()
		}
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

// broadcastLocked 는 fr 을 skip 을 뺀 모든 연결로 보낸다 (FR-PCH-4).
func (s *Service) broadcastLocked(fr frame, skip *peerLink) {
	line := encode(fr)
	for _, l := range s.links {
		if l != skip {
			l.send(line)
		}
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
	if len(st.Parts) > maxParts || len(st.Rooms) > maxNodeRooms || len(st.Links) > maxNodes || !validText(st.Name, maxName) {
		return false
	}
	if len(st.Helper) > maxHelperKey || !validText(st.Helper, maxHelperKey) || len(st.Pins) > maxNodes {
		return false
	}
	for fp, k := range st.Pins {
		if len(fp) != idPrefix || !validID(fp) || len(k) > maxHelperKey || !validText(k, maxHelperKey) {
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

type dialState struct {
	next    time.Time
	wait    time.Duration
	running bool
}

// Run 은 연결을 유지한다: 간선 상대마다 연결을 걸고, ping 을 보내고, 조용한 연결과 지워진
// 간선의 연결을 끊는다 (FR-PCH-8). ctx 가 끝나거나 Close 하면 돌아온다.
func (s *Service) Run(ctx context.Context) {
	tick := min(s.pingEvery, redialMin)
	t := time.NewTicker(tick)
	defer t.Stop()
	lastPing := s.now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.done:
			return
		case <-t.C:
		}
		now := s.now()
		if now.Sub(lastPing) >= s.pingEvery {
			lastPing = now
			s.pingAll(now)
		}
		s.dialEdges(ctx, now)
	}
}

func (s *Service) pingAll(now time.Time) {
	s.mu.Lock()
	var dead []*peerLink
	for _, l := range s.links {
		if now.Sub(time.Unix(0, l.lastSeen.Load())) > s.deadAfter {
			dead = append(dead, l)
			continue
		}
		l.send(pingLine)
	}
	s.mu.Unlock()
	for _, l := range dead {
		dmlog.Infof(nil, "chat link: %s 에서 %s 동안 받은 것이 없어 끊는다", short(l.fp), s.deadAfter)
		s.detach(l)
	}
}

func (s *Service) dialEdges(ctx context.Context, now time.Time) {
	if s.opts.Edges == nil || s.opts.Dial == nil {
		return
	}
	paired := map[string]edge.Edge{}
	for _, e := range s.opts.Edges() {
		if e.State == edge.StatePaired {
			paired[e.Fingerprint] = e
		}
	}
	s.mu.Lock()
	var stale []*peerLink
	for fp, l := range s.links {
		if _, ok := paired[fp]; !ok {
			stale = append(stale, l)
		}
	}
	for fp := range s.dialing {
		if _, ok := paired[fp]; !ok {
			delete(s.dialing, fp)
		}
	}
	for fp, e := range paired {
		if _, linked := s.links[fp]; linked {
			continue
		}
		d := s.dialing[fp]
		if d == nil {
			d = &dialState{wait: redialMin}
			s.dialing[fp] = d
		}
		if d.running || now.Before(d.next) {
			continue
		}
		d.running = true
		go s.dial(ctx, e, d)
	}
	s.mu.Unlock()
	for _, l := range stale {
		s.detach(l)
	}
}

func (s *Service) dial(ctx context.Context, e edge.Edge, d *dialState) {
	conn, err := s.opts.Dial(ctx, edge.Target{Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint})
	s.mu.Lock()
	d.running = false
	if err != nil {
		d.next = s.now().Add(d.wait)
		d.wait = min(d.wait*2, redialMax)
		s.mu.Unlock()
		return
	}
	d.wait = redialMin
	s.mu.Unlock()
	s.attach(e.Fingerprint, conn, true)
}

func short(fp string) string {
	if len(fp) > 12 {
		return fp[:12]
	}
	return fp
}
