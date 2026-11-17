package chat

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"net"
	"sort"
	"sync"
	"time"

	"dongminal/internal/shared/edge"
)

// 참가자와 방의 종류다.
const (
	KindAgent  = "agent"
	KindUser   = "user"
	KindGroup  = "group"
	KindDirect = "direct"
)

// 상한이다 (FR-PCH-55, §3.9).
const (
	// MaxParticipants 는 노드 하나의 참가자 상한이다. 넘는 노드 상태 알림은 받는 쪽이 버린다.
	MaxParticipants = 64
	// MaxText 는 글 하나의 바이트 상한이다.
	MaxText = 16 << 10
	// PerMinute 는 참가자 하나가 1분에 쓸 수 있는 글 수다.
	PerMinute = 30
	// maxParts 는 노드 하나의 참가자 상한, maxPartRooms 는 참가자 하나의 방 상한,
	// maxNodeRooms 는 노드 하나가 싣는 방 기록의 상한이다.
	maxParts     = MaxParticipants
	maxPartRooms = 64
	maxNodeRooms = 128
	maxName      = 64 * 4
	maxPurpose   = 512
	maxLabel     = 128
	maxID        = 128
	// maxNodes 는 아는 노드의 상한이다. 넘으면 닿지 않는 노드부터 잊는다.
	maxNodes = 256
	// maxMarks 는 잊은 노드의 마지막 번호를 기억하는 수다 (재전송 막기).
	maxMarks = 4096
	// idPrefix 는 참가자 id 앞에 붙는 노드 지문의 길이(지문 전체)다. id 를 노드에 묶는다.
	idPrefix = 64
)

// Participant 는 이 노드의 참가자 하나다.
type Participant struct {
	ID    string
	Label string
	Kind  string
}

// Message 는 참가자에게 넘기는 글이다. 방 종류·이름·목적을 함께 싣는다 (FR-PCH-13).
type Message struct {
	ID          string
	Room        string
	RoomKind    string
	RoomName    string
	RoomPurpose string
	From        string
	FromLabel   string
	// FromKind 는 보낸 참가자의 종류(agent·user)다. 표시 이름이 아니라 참가자 기록에서 온다.
	FromKind string
	Node     string
	Text     string
	At       time.Time
	Epoch    int64
	Seq      uint64
}

// Member 는 방이나 온라인 목록의 참가자 하나다. Online 은 그 노드에 지금 닿는지다.
type Member struct {
	ID     string
	Label  string
	Kind   string
	Node   string
	Online bool
}

// RoomInfo 는 방 하나의 보기다.
type RoomInfo struct {
	ID          string
	Kind        string
	Name        string
	Purpose     string
	Creator     string
	CreatorName string
	Members     []Member
	Joined      bool
}

// NodeInfo 는 온라인 목록의 노드 하나다.
type NodeInfo struct {
	FP     string
	Name   string
	Online bool
	Self   bool
}

// OnlineView 는 온라인 목록이다 (FR-PCH-3).
type OnlineView struct {
	Nodes        []NodeInfo
	Participants []Member
}

// Options 는 채팅을 세우는 값이다.
type Options struct {
	Identity edge.Identity
	// Name 은 이 노드의 표시 이름이다.
	Name func() string
	// Edges 는 지금의 간선이다. 맺은 간선마다 채팅 연결을 건다. nil 이면 걸지 않는다.
	Edges func() []edge.Edge
	// Dial 은 간선 상대에게 채팅 연결을 연다(노드 포트 Upgrade).
	Dial func(ctx context.Context, t edge.Target) (net.Conn, error)
	// Deliver 는 이 노드의 참가자에게 글을 넘긴다. 잠금 밖에서 부른다.
	Deliver func(pid string, m Message)
	// Pin 은 간선 상대 fp 의 도우미 공개키를 고정한다(비었을 때만, §3.12). 잠금 밖에서 부른다.
	// nil 이면 고정하지 않는다.
	Pin func(fp, key string)
	// Unpaired 는 간선 상대가 이 노드를 간선이 아니라고(403 edge_not_edge) 답했을 때 그 지문으로
	// 부른다. 상대가 먼저 지운 간선을 이쪽에서도 지운다 (EDGE_PAIRING_SRS FR-EPR-22). 잠금 밖에서
	// 부른다. nil 이면 아무것도 하지 않는다.
	Unpaired func(fp string)
	// Changed 는 온라인 목록이나 방이 바뀌었을 수 있다는 알림이다. 잠금 밖의 고루틴에서
	// 부르고, 여러 번의 바뀜을 한 번으로 묶을 수 있다. nil 이면 알리지 않는다.
	Changed func()
	Now     func() time.Time
}

type participant struct {
	Participant
	rooms map[string]bool
	// left 는 스스로 나간 개인채팅이다. 다시 자동으로 들어가지 않는다 (FR-PCH-16).
	left map[string]bool
	// peerSeen 은 개인채팅 상대가 그 방에 든 것을 본 방이다.
	peerSeen map[string]bool
}

type room struct {
	rec  signedRecord
	body recordBody
}

type remote struct {
	st    stateBody
	key   *ecdsa.PublicKey
	raw   frame
	rooms map[string]room
	// at 은 이 노드의 상태를 마지막으로 받은 때다.
	at time.Time
}

// Service 는 이 노드의 채팅이다.
type Service struct {
	// pokes 는 Changed 로 알릴 바뀜이다. 하나만 쌓인다.
	pokes chan struct{}
	id    edge.Identity
	key   string
	opts  Options
	now   func() time.Time

	pingEvery time.Duration
	deadAfter time.Duration
	maxNodes  int

	mu     sync.Mutex
	epoch  int64
	seq    uint64
	msgSeq uint64
	parts  map[string]*participant
	// rooms 는 이 노드의 참가자가 든 방의 기록이다 (FR-PCH-22).
	rooms map[string]room
	nodes map[string]*remote
	links map[string]*peerLink
	wins  map[string]*seqWindow
	marks map[string]mark
	own   frame
	// ownContent 는 마지막으로 알린 자기 상태의 내용(순서 번호 제외)이다.
	ownContent string
	sendRate   *limiter
	recvRate   *limiter
	dialing    map[string]*dialState
	// helperKey 는 이 노드의 도우미 공개키, cmds 는 본 사람 명령 id, warned 는 고정과 다른
	// 키를 알린 간선 상대다 (§3.12).
	helperKey string
	cmds      map[string]time.Time
	relayed   map[string]time.Time
	warned    map[string]string
	edgeCache []edge.Edge
	edgeAt    time.Time
	closed    bool
	done      chan struct{}
}

// New 는 채팅을 세운다. 연결 유지는 Run 이 한다.
func New(o Options) *Service {
	now := o.Now
	if now == nil {
		now = time.Now
	}
	s := &Service{
		id: o.Identity, key: publicKeyOf(o.Identity), opts: o, now: now,
		pingEvery: 15 * time.Second, deadAfter: 45 * time.Second, maxNodes: maxNodes,
		marks: map[string]mark{},
		epoch: now().UnixNano(),
		parts: map[string]*participant{}, rooms: map[string]room{},
		nodes: map[string]*remote{}, links: map[string]*peerLink{},
		wins: map[string]*seqWindow{}, dialing: map[string]*dialState{},
		cmds: map[string]time.Time{}, relayed: map[string]time.Time{}, warned: map[string]string{},
		done: make(chan struct{}), pokes: make(chan struct{}, 1),
	}
	s.sendRate = newLimiter(PerMinute, time.Minute, s.clock)
	s.recvRate = newLimiter(PerMinute, time.Minute, s.clock)
	s.mu.Lock()
	s.announceLocked()
	s.mu.Unlock()
	if o.Changed != nil {
		go s.notifyLoop()
	}
	return s
}

// notifyLoop 는 바뀜을 Changed 로 알린다. 쌓인 바뀜은 한 번으로 묶인다.
func (s *Service) notifyLoop() {
	for {
		select {
		case <-s.done:
			return
		case <-s.pokes:
			s.opts.Changed()
		}
	}
}

func (s *Service) clock() time.Time { return s.now() }

func (s *Service) name() string {
	if s.opts.Name == nil {
		return ""
	}
	return s.opts.Name()
}

// Close 는 모든 연결을 닫는다. 그 뒤에는 연결을 받지 않는다.
func (s *Service) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.done)
	links := make([]*peerLink, 0, len(s.links))
	for _, l := range s.links {
		links = append(links, l)
	}
	s.links = map[string]*peerLink{}
	s.mu.Unlock()
	for _, l := range links {
		l.close()
	}
}

// Register 는 참가자를 만든다. 방이 없는 새 참가자다 (FR-PCH-43·46).
func (s *Service) Register(label, kind string) Participant {
	p := &participant{
		Participant: Participant{ID: s.id.Fingerprint[:idPrefix] + "-" + randomHex(16), Label: label, Kind: kind},
		rooms:       map[string]bool{}, left: map[string]bool{}, peerSeen: map[string]bool{},
	}
	s.mu.Lock()
	s.parts[p.ID] = p
	s.changedLocked()
	s.mu.Unlock()
	return p.Participant
}

// Unregister 는 참가자를 없앤다. 모든 방에서 바로 나간다 (FR-PCH-43).
func (s *Service) Unregister(pid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.parts[pid]; !ok {
		return
	}
	delete(s.parts, pid)
	s.dropUnclaimedLocked()
	s.changedLocked()
}

// Create 는 단체채팅 방을 만들고 pid 를 넣는다 (FR-PCH-10·11).
func (s *Service) Create(pid, name, purpose string) (RoomInfo, error) {
	if name == "" || !validText(name, maxName) || !validText(purpose, maxPurpose) {
		return RoomInfo{}, fail(CodeBadRequest, "name 또는 purpose")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.partLocked(pid)
	if err != nil {
		return RoomInfo{}, err
	}
	if err := s.roomCapLocked(p); err != nil {
		return RoomInfo{}, err
	}
	rec, err := newRecord(s.id, recordBody{Kind: KindGroup, Owner: pid, Name: name, Purpose: purpose, Created: s.now(), Nonce: randomHex(16)})
	if err != nil {
		return RoomInfo{}, err
	}
	id := s.addRoomLocked(rec)
	p.rooms[id] = true
	s.changedLocked()
	return s.roomInfoLocked(pid, id), nil
}

// Direct 는 pid 와 온라인 참가자 peer 의 개인채팅을 만든다. 상대는 따로 수락하지 않고
// 들어간다 (FR-PCH-14·15·17).
func (s *Service) Direct(pid, peer, purpose string) (RoomInfo, error) {
	if !validText(purpose, maxPurpose) || !validID(peer) {
		return RoomInfo{}, fail(CodeBadRequest, "purpose 또는 participant")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.partLocked(pid)
	if err != nil {
		return RoomInfo{}, err
	}
	peerNode, ok := s.onlinePartLocked(peer)
	if peer == pid || !ok {
		return RoomInfo{}, fail(CodeNoSuchParticipant, peer)
	}
	if err := s.roomCapLocked(p); err != nil {
		return RoomInfo{}, err
	}
	rec, err := newRecord(s.id, recordBody{Kind: KindDirect, Owner: pid, Peer: peer, PeerNode: peerNode, Purpose: purpose, Created: s.now(), Nonce: randomHex(16)})
	if err != nil {
		return RoomInfo{}, err
	}
	id := s.addRoomLocked(rec)
	p.rooms[id] = true
	if q, ok := s.parts[peer]; ok {
		q.rooms[id] = true
	}
	s.changedLocked()
	return s.roomInfoLocked(pid, id), nil
}

// Join 은 보이는 단체채팅 방에 pid 를 넣는다 (FR-PCH-12).
func (s *Service) Join(pid, roomID string) (RoomInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.partLocked(pid)
	if err != nil {
		return RoomInfo{}, err
	}
	if p.rooms[roomID] {
		return s.roomInfoLocked(pid, roomID), nil
	}
	r, ok := s.visibleRoomLocked(pid, roomID)
	if !ok || r.body.Kind != KindGroup {
		return RoomInfo{}, fail(CodeNoSuchRoom, roomID)
	}
	if err := s.roomCapLocked(p); err != nil {
		return RoomInfo{}, err
	}
	s.rooms[roomID] = r
	p.rooms[roomID] = true
	s.changedLocked()
	return s.roomInfoLocked(pid, roomID), nil
}

// Leave 는 pid 를 방에서 뺀다. 그 방에 이 노드의 참가자가 없으면 기록을 지운다 (FR-PCH-22).
func (s *Service) Leave(pid, roomID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.partLocked(pid)
	if err != nil {
		return err
	}
	if !p.rooms[roomID] {
		return fail(CodeNotInRoom, roomID)
	}
	s.leaveLocked(p, roomID)
	s.changedLocked()
	return nil
}

// Send 는 pid 의 글을 방에 보낸다. 노드는 글을 들지 않는다 (FR-PCH-24·55).
func (s *Service) Send(pid, roomID, text string) error {
	s.mu.Lock()
	p, err := s.partLocked(pid)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if !p.rooms[roomID] {
		s.mu.Unlock()
		return fail(CodeNotInRoom, roomID)
	}
	if len(text) > MaxText {
		s.mu.Unlock()
		return fail(CodeTooLarge, "text")
	}
	if text == "" || !validBody(text) {
		s.mu.Unlock()
		return fail(CodeBadRequest, "text")
	}
	if !s.sendRate.allow(pid) {
		s.mu.Unlock()
		return fail(CodeRateLimited, pid)
	}
	s.msgSeq++
	body := msgBody{ID: randomHex(16), Node: s.id.Fingerprint, Epoch: s.epoch, Seq: s.msgSeq, Room: roomID, From: pid, Text: text, At: s.now()}
	fr, err := signFrame(s.id, frameMsg, body)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	s.broadcastLocked(fr, nil)
	out := s.localDeliveriesLocked(body, p.Label, p.Kind)
	s.mu.Unlock()
	s.deliver(out)
	return nil
}

type pending struct {
	pid string
	msg Message
}

func (s *Service) deliver(out []pending) {
	if s.opts.Deliver == nil {
		return
	}
	for _, d := range out {
		s.opts.Deliver(d.pid, d.msg)
	}
}

// localDeliveriesLocked 는 그 방에 든 이 노드의 참가자(보낸 이 제외)에게 넘길 글이다.
func (s *Service) localDeliveriesLocked(b msgBody, label, kind string) []pending {
	var out []pending
	r, _ := s.recordLocked(b.Room)
	for _, q := range s.parts {
		if q.ID == b.From || !q.rooms[b.Room] {
			continue
		}
		out = append(out, pending{q.ID, Message{
			ID: b.ID, Room: b.Room, RoomKind: r.body.Kind, RoomName: r.body.Name, RoomPurpose: r.body.Purpose,
			From: b.From, FromLabel: label, FromKind: kind, Node: b.Node,
			Text: b.Text, At: b.At, Epoch: b.Epoch, Seq: b.Seq,
		}})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].pid < out[j].pid })
	return out
}

func (s *Service) partLocked(pid string) (*participant, error) {
	p, ok := s.parts[pid]
	if !ok {
		return nil, fail(CodeNoSuchParticipant, pid)
	}
	return p, nil
}

func (s *Service) roomCapLocked(p *participant) error {
	if len(p.rooms) >= maxPartRooms || len(s.rooms) >= maxNodeRooms {
		return fail(CodeBadRequest, "too many rooms")
	}
	return nil
}

func (s *Service) addRoomLocked(rec signedRecord) string {
	b, _ := openRecord(rec)
	id := rec.id()
	s.rooms[id] = room{rec: rec, body: b}
	return id
}

func (s *Service) leaveLocked(p *participant, roomID string) {
	delete(p.rooms, roomID)
	delete(p.peerSeen, roomID)
	if r, ok := s.rooms[roomID]; ok && r.body.Kind == KindDirect {
		p.left[roomID] = true
	}
	s.dropUnclaimedLocked()
}

// dropUnclaimedLocked 는 이 노드의 참가자가 아무도 들지 않은 방의 기록을 지운다.
func (s *Service) dropUnclaimedLocked() {
	for id := range s.rooms {
		claimed := false
		for _, p := range s.parts {
			if p.rooms[id] {
				claimed = true
				break
			}
		}
		if !claimed {
			delete(s.rooms, id)
		}
	}
}

// changedLocked 는 개인채팅의 따라 나가기·자동 들어가기를 맞춘 뒤 상태를 알린다.
func (s *Service) changedLocked() {
	select {
	case s.pokes <- struct{}{}:
	default:
	}
	for range maxParts {
		if !s.reactLocked() {
			break
		}
	}
	s.announceLocked()
}

// announceLocked 는 자기 상태의 내용이 바뀌었을 때만 새 노드 상태 알림을 만들어 모든 연결로
// 보낸다 (FR-PCH-9). 남의 알림을 받을 때마다 알리면 노드끼리 끝없이 주고받는다.
func (s *Service) announceLocked() {
	st := s.ownStateLocked()
	content, _ := json.Marshal(st)
	if s.own.T != "" && string(content) == s.ownContent {
		return
	}
	s.ownContent = string(content)
	s.seq++
	st.Epoch, st.Seq = s.epoch, s.seq
	fr, err := signFrame(s.id, frameState, st)
	if err != nil {
		return
	}
	s.own = fr
	s.broadcastLocked(fr, nil)
}

// ownStateLocked 는 순서 번호를 뺀 자기 상태다.
func (s *Service) ownStateLocked() stateBody {
	st := stateBody{Node: s.id.Fingerprint, Key: s.key, Name: s.name(), Helper: s.helperKey, Pins: s.pinsLocked()}
	for fp := range s.links {
		st.Links = append(st.Links, fp)
	}
	sort.Strings(st.Links)
	ids := make([]string, 0, len(s.parts))
	for id := range s.parts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := s.parts[id]
		sp := statePart{ID: p.ID, Label: p.Label, Kind: p.Kind}
		for r := range p.rooms {
			sp.Rooms = append(sp.Rooms, r)
		}
		sort.Strings(sp.Rooms)
		st.Parts = append(st.Parts, sp)
	}
	roomIDs := make([]string, 0, len(s.rooms))
	for id := range s.rooms {
		roomIDs = append(roomIDs, id)
	}
	sort.Strings(roomIDs)
	for _, id := range roomIDs {
		st.Rooms = append(st.Rooms, s.rooms[id].rec)
	}
	return st
}

// reactLocked 는 개인채팅을 맞춘다. 바꾼 것이 있으면 참이다 (FR-PCH-15·16).
func (s *Service) reactLocked() bool {
	changed := false
	// 상대 노드가 만든 개인채팅에 이 노드의 참가자가 상대로 적혀 있으면 들어간다.
	for _, r := range s.nodes {
		if !s.reachableLocked()[r.st.Node] {
			continue
		}
		for id, rm := range r.rooms {
			if rm.body.Kind != KindDirect || rm.body.Creator != r.st.Node || rm.body.PeerNode != s.id.Fingerprint {
				continue
			}
			q, ok := s.parts[rm.body.Peer]
			if !ok || q.rooms[id] || q.left[id] || !partInRoom(r.st, rm.body.Owner, id) || s.roomCapLocked(q) != nil {
				continue
			}
			s.rooms[id] = rm
			q.rooms[id] = true
			changed = true
		}
	}
	// 상대를 한 번 본 뒤 상대가 떠났으면 따라 나간다. 상대 노드가 끊긴 것은 떠난 것이 아니다.
	for _, p := range s.parts {
		for id := range p.rooms {
			rm, ok := s.rooms[id]
			if !ok || rm.body.Kind != KindDirect {
				continue
			}
			other, node := rm.body.Peer, rm.body.PeerNode
			if p.ID == rm.body.Peer {
				other, node = rm.body.Owner, rm.body.Creator
			}
			switch s.whereLocked(node, other, id) {
			case presentInRoom:
				if !p.peerSeen[id] {
					p.peerSeen[id] = true
				}
			case absent:
				if p.peerSeen[id] {
					s.leaveLocked(p, id)
					changed = true
				}
			case unreachable:
			}
		}
	}
	return changed
}

type whereabouts int

const (
	absent whereabouts = iota
	presentInRoom
	unreachable
)

// whereLocked 는 노드 node 의 참가자 pid 가 방 roomID 에 들어 있는지다. 닿지 않는 노드의
// 참가자는 모른다.
func (s *Service) whereLocked(node, pid, roomID string) whereabouts {
	if node == s.id.Fingerprint {
		if q, ok := s.parts[pid]; ok && q.rooms[roomID] {
			return presentInRoom
		}
		return absent
	}
	r, ok := s.nodes[node]
	if !ok || !s.reachableLocked()[node] {
		return unreachable
	}
	if partInRoom(r.st, pid, roomID) {
		return presentInRoom
	}
	return absent
}

// partyOK 는 노드 node 의 참가자 pid 가 방 rm 에 들 수 있는지다. 개인채팅은 두 참가자가
// 각자의 노드에 묶인다 — 만든 이는 만든 노드, 상대는 기록에 서명된 상대 노드다.
func partyOK(rm room, node, pid string) bool {
	if rm.body.Kind != KindDirect {
		return true
	}
	return pid == rm.body.Owner && node == rm.body.Creator || pid == rm.body.Peer && node == rm.body.PeerNode
}

func partInRoom(st stateBody, pid, roomID string) bool {
	for _, sp := range st.Parts {
		if sp.ID != pid {
			continue
		}
		for _, r := range sp.Rooms {
			if r == roomID {
				return true
			}
		}
	}
	return false
}

// onlinePartLocked 는 온라인 참가자 pid 가 있는 노드다.
func (s *Service) onlinePartLocked(pid string) (string, bool) {
	if _, ok := s.parts[pid]; ok {
		return s.id.Fingerprint, true
	}
	reach := s.reachableLocked()
	for fp, r := range s.nodes {
		if !reach[fp] {
			continue
		}
		for _, sp := range r.st.Parts {
			if sp.ID == pid {
				return fp, true
			}
		}
	}
	return "", false
}
