package chat

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgemesh"
)

// PEER_CHAT_SRS §3.9 단계 1 — 데몬의 채팅 핵심.

type delivery struct {
	pid string
	msg Message
}

type testNode struct {
	*Service
	mesh *edgemesh.Mesh
	t    *testing.T
	mu   sync.Mutex
	got  []delivery
	name string
}

func newTestNode(t *testing.T, name string) *testNode {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tn := &testNode{t: t, name: name, mesh: newMesh(t, id, name)}
	tn.Service = New(Options{
		Identity: id,
		Mesh:     tn.mesh,
		Deliver: func(pid string, m Message) {
			tn.mu.Lock()
			tn.got = append(tn.got, delivery{pid, m})
			tn.mu.Unlock()
		},
	})
	t.Cleanup(tn.Close)
	return tn
}

// newMesh 는 시험 노드의 간선 계층이다. 연결은 link 로 손으로 잇는다.
func newMesh(t *testing.T, id edge.Identity, name string) *edgemesh.Mesh {
	t.Helper()
	m := edgemesh.New(edgemesh.Options{Identity: id, Name: func() string { return name }})
	t.Cleanup(m.Close)
	return m
}

func (tn *testNode) fp() string { return tn.id.Fingerprint }

func (tn *testNode) deliveries(pid string) []Message {
	tn.mu.Lock()
	defer tn.mu.Unlock()
	var out []Message
	for _, d := range tn.got {
		if d.pid == pid {
			out = append(out, d.msg)
		}
	}
	return out
}

// link 는 a(건 쪽)와 b 를 메모리 연결로 잇는다. 돌려준 함수가 끊는다.
func link(a, b *testNode) func() {
	p1, p2 := net.Pipe()
	a.mesh.Attach(b.fp(), p1, true)
	b.mesh.Attach(a.fp(), p2, false)
	return func() { _ = p1.Close(); _ = p2.Close() }
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("시간 안에 이루어지지 않았다: %s", what)
}

func never(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if cond() {
			t.Fatalf("일어나면 안 되는 일이 일어났다: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func roomVisible(s *testNode, pid, room string) bool {
	for _, r := range s.Rooms(pid) {
		if r.ID == room {
			return true
		}
	}
	return false
}

func nodeOnline(s *testNode, fp string) bool {
	for _, n := range s.Online().Nodes {
		if n.FP == fp {
			return n.Online
		}
	}
	return false
}

func mustCode(t *testing.T, err error, code string) {
	t.Helper()
	if got := ErrorCode(err); got != code {
		t.Fatalf("code = %q (%v), want %q", got, err, code)
	}
}

// TC-PCH-1 (FR-PCH-1·2·4): A-B-C 에서 간선이 아닌 A 와 C 가 채팅한다. 같은 글은 한 번만 온다.
func TestChatAcrossNetworkNeighbor(t *testing.T) {
	a, b, c := newTestNode(t, "a"), newTestNode(t, "b"), newTestNode(t, "c")
	link(a, b)
	link(b, c)
	pa := a.Register("a/claude", KindAgent)
	pc := c.Register("c/claude", KindAgent)
	room, err := a.Create(pa.ID, "auth-review", "리뷰")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 가 방을 본다", func() bool { return roomVisible(c, pc.ID, room.ID) })
	eventually(t, "A 가 C 를 온라인으로 본다", func() bool { return nodeOnline(a, c.fp()) })
	if _, err := c.Join(pc.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "A 가 C 의 참가를 본다", func() bool {
		for _, r := range a.Rooms(pa.ID) {
			if r.ID == room.ID {
				return len(r.Members) == 2
			}
		}
		return false
	})
	if err := a.Send(pa.ID, room.ID, "안녕"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 가 글을 받는다", func() bool { return len(c.deliveries(pc.ID)) == 1 })
	m := c.deliveries(pc.ID)[0]
	if m.Text != "안녕" || m.From != pa.ID || m.Room != room.ID || m.FromLabel != "a/claude" {
		t.Fatalf("msg %+v", m)
	}
	// PEER_CHAT_SRS §3.10: 글에 방 이름·목적을 싣는다 (FR-PCH-13).
	if m.RoomKind != KindGroup || m.RoomName != "auth-review" || m.RoomPurpose != "리뷰" || m.FromKind != KindAgent {
		t.Fatalf("방 정보 %+v", m)
	}
	never(t, "같은 글이 두 번 온다", func() bool { return len(c.deliveries(pc.ID)) > 1 })
	if len(a.deliveries(pa.ID)) != 0 {
		t.Fatal("보낸 이에게 되돌아왔다")
	}
}

// TC-PCH-1 (FR-PCH-4): 고리 모양 망에서도 한 번만 온다.
func TestChatRingDeliversOnce(t *testing.T) {
	a, b, c := newTestNode(t, "a"), newTestNode(t, "b"), newTestNode(t, "c")
	link(a, b)
	link(b, c)
	link(c, a)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	room, _ := a.Create(pa.ID, "ring", "")
	eventually(t, "B 가 방을 본다", func() bool { return roomVisible(b, pb.ID, room.ID) })
	if _, err := b.Join(pb.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "A 가 B 의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	_ = a.Send(pa.ID, room.ID, "1")
	eventually(t, "B 가 받는다", func() bool { return len(b.deliveries(pb.ID)) == 1 })
	never(t, "두 번 받는다", func() bool { return len(b.deliveries(pb.ID)) > 1 })
}

// fakePeer 는 서명한 프레임을 손으로 넣는 상대 노드다.
type fakePeer struct {
	id   edge.Identity
	conn net.Conn
	seq  uint64
}

func newFakePeer(t *testing.T, target *testNode) *fakePeer {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p1, p2 := net.Pipe()
	f := &fakePeer{id: id, conn: p2}
	go func() { // 상대가 보내는 것은 읽어 버린다
		buf := make([]byte, 64<<10)
		for {
			if _, err := p2.Read(buf); err != nil {
				return
			}
		}
	}()
	target.mesh.Attach(id.Fingerprint, p1, false)
	t.Cleanup(func() { _ = p2.Close() })
	return f
}

// pid 는 이 가짜 노드에 묶인 참가자 id 다.
func (f *fakePeer) pid(x string) string { return f.id.Fingerprint[:idPrefix] + "-" + x }

func (f *fakePeer) write(t *testing.T, fr frame) {
	t.Helper()
	raw, _ := json.Marshal(fr)
	if _, err := f.conn.Write(append(raw, '\n')); err != nil {
		t.Fatal(err)
	}
}

// state 는 가짜 노드의 채팅 상태를 보낸다. links 가 있으면 간선 계층의 망 정보(net)를 먼저 보낸다
// — 온라인 판정은 간선 계층이 한다 (EDGE_MESH_SRS FR-EGM-42).
func (f *fakePeer) state(t *testing.T, parts []statePart, rooms []signedRecord, links []string) {
	t.Helper()
	f.seq++
	if links != nil {
		nf, err := signFrame(f.id, edgemesh.FrameNet, map[string]any{"node": f.id.Fingerprint, "key": publicKeyOf(f.id),
			"name": "fake", "epoch": 1, "seq": f.seq, "links": links})
		if err != nil {
			t.Fatal(err)
		}
		f.write(t, nf)
	}
	st := stateBody{Node: f.id.Fingerprint, Key: publicKeyOf(f.id), Epoch: 1, Seq: f.seq, Parts: parts, Rooms: rooms}
	fr, err := signFrame(f.id, frameState, st)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, fr)
}

// TC-PCH-1 (FR-PCH-5): 서명 뒤에 본문을 바꾼 글은 버려지고, 바른 글은 받는다.
func TestTamperedMessageDropped(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	f := newFakePeer(t, a)
	rec := a.recordOf(room.ID)
	f.state(t, []statePart{{ID: f.pid("fp1"), Label: "fake/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{rec}, []string{a.fp()})
	eventually(t, "A 가 가짜 노드의 참가자를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })

	body := msgBody{ID: "m1", Node: f.id.Fingerprint, Epoch: 1, Seq: 1, Room: room.ID, From: f.pid("fp1"), Text: "원문", At: time.Now()}
	fr, _ := signFrame(f.id, frameMsg, body)
	tampered := fr
	tampered.B = json.RawMessage(strings.Replace(string(fr.B), "원문", "바꿈", 1))
	f.write(t, tampered)
	never(t, "바꾼 글이 전달된다", func() bool { return len(a.deliveries(pa.ID)) > 0 })
	f.write(t, fr)
	eventually(t, "바른 글이 전달된다", func() bool { return len(a.deliveries(pa.ID)) == 1 })
	if a.deliveries(pa.ID)[0].Text != "원문" {
		t.Fatal("본문이 다르다")
	}
}

// FR-PCH-5: 다른 노드인 척한 상태(지문과 키가 맞지 않음)는 버린다.
func TestStateWithForeignKeyDropped(t *testing.T) {
	a := newTestNode(t, "a")
	f := newFakePeer(t, a)
	other, _ := edge.LoadOrCreateIdentity(t.TempDir())
	st := stateBody{Node: other.Fingerprint, Key: publicKeyOf(f.id), Epoch: 1, Seq: 1}
	fr, _ := signFrame(f.id, frameState, st)
	f.write(t, fr)
	never(t, "가짜 노드가 목록에 선다", func() bool {
		for _, n := range a.Online().Nodes {
			if n.FP == other.Fingerprint {
				return true
			}
		}
		return false
	})
}

// FR-PCH-21: 방이 있다고 말하는 참가자가 없으면 방은 목록에 서지 않는다.
func TestRoomWithoutClaimNotListed(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	f := newFakePeer(t, a)
	rec, err := newRecord(f.id, recordBody{Kind: KindGroup, Creator: f.id.Fingerprint, Name: "ghost", Created: time.Now(), Nonce: "n"})
	if err != nil {
		t.Fatal(err)
	}
	f.state(t, nil, []signedRecord{rec}, []string{a.fp()})
	never(t, "주장 없는 방이 보인다", func() bool { return len(a.Rooms(pa.ID)) > 0 })
}

// TC-PCH-2 (FR-PCH-10): 생성 기록을 바꾼 방은 버린다.
func TestTamperedRoomRecordDropped(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	f := newFakePeer(t, a)
	rec, err := newRecord(f.id, recordBody{Kind: KindGroup, Creator: f.id.Fingerprint, Name: "real", Created: time.Now(), Nonce: "n"})
	if err != nil {
		t.Fatal(err)
	}
	roomID := rec.id()
	rec.B = json.RawMessage(strings.Replace(string(rec.B), "real", "fake", 1))
	f.state(t, []statePart{{ID: f.pid("p"), Label: "f/x", Kind: KindAgent, Rooms: []string{roomID}}}, []signedRecord{rec}, []string{a.fp()})
	never(t, "바꾼 방이 보인다", func() bool { return len(a.Rooms(pa.ID)) > 0 })
}

// TC-PCH-3 (FR-PCH-20~24): 마지막 퇴장에 방이 사라진다. 늦게 들어오면 그 뒤의 글만 받는다.
func TestLastLeaveAndLateJoin(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "목적")
	eventually(t, "B 가 방을 본다", func() bool { return roomVisible(b, pb.ID, room.ID) })
	_ = a.Send(pa.ID, room.ID, "들어오기 전")
	// 같은 연결에서 글 뒤에 오는 상태 알림을 기다려, 글이 B 에 먼저 닿은 것을 확인한다.
	marker := a.Register("a/marker", KindAgent)
	eventually(t, "B 가 글 뒤의 상태를 받는다", func() bool {
		for _, m := range b.Online().Participants {
			if m.ID == marker.ID {
				return true
			}
		}
		return false
	})
	if info, err := b.Join(pb.ID, room.ID); err != nil || info.Purpose != "목적" {
		t.Fatalf("join %+v %v", info, err)
	}
	eventually(t, "A 가 B 의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	_ = a.Send(pa.ID, room.ID, "들어온 뒤")
	eventually(t, "B 가 받는다", func() bool { return len(b.deliveries(pb.ID)) == 1 })
	if got := b.deliveries(pb.ID)[0].Text; got != "들어온 뒤" {
		t.Fatalf("got %q", got)
	}
	if err := a.Leave(pa.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "A 에 방 기록이 없다", func() bool { return a.recordCount() == 0 })
	if !roomVisible(b, pb.ID, room.ID) {
		t.Fatal("B 가 남았는데 방이 사라졌다")
	}
	eventually(t, "A 가 아직 방을 본다(B 가 말한다)", func() bool { return roomVisible(a, pa.ID, room.ID) })
	if err := b.Leave(pb.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "방이 모두에게서 사라진다", func() bool {
		return !roomVisible(a, pa.ID, room.ID) && !roomVisible(b, pb.ID, room.ID) && b.recordCount() == 0
	})
}

// TC-PCH-4 (FR-PCH-30~33): 갈라지면 양쪽이 쓰고, 그동안의 글은 건너가지 않는다. 이어지면 합친다.
func TestPartitionAndMerge(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	cut := link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	eventually(t, "B 가 방을 본다", func() bool { return roomVisible(b, pb.ID, room.ID) })
	_, _ = b.Join(pb.ID, room.ID)
	eventually(t, "A 가 B 의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })

	cut()
	eventually(t, "A 가 B 를 연결 끊김으로 본다", func() bool { return !nodeOnline(a, b.fp()) })
	eventually(t, "B 가 A 를 연결 끊김으로 본다", func() bool { return !nodeOnline(b, a.fp()) })
	if err := a.Send(pa.ID, room.ID, "갈라진 동안"); err != nil {
		t.Fatal(err)
	}
	if err := b.Send(pb.ID, room.ID, "갈라진 동안 B"); err != nil {
		t.Fatal(err)
	}
	if !roomVisible(b, pb.ID, room.ID) {
		t.Fatal("갈라진 B 쪽에서 방이 사라졌다")
	}
	var offline bool
	for _, m := range b.Rooms(pb.ID)[0].Members {
		if m.ID == pa.ID {
			offline = !m.Online
		}
	}
	if !offline {
		t.Fatal("A 의 참가자가 연결 끊김으로 보이지 않는다")
	}

	link(b, a)
	eventually(t, "다시 온라인", func() bool { return nodeOnline(a, b.fp()) && nodeOnline(b, a.fp()) })
	for i := range 5 {
		_ = a.Send(pa.ID, room.ID, string(rune('0'+i)))
	}
	eventually(t, "B 가 다섯 글을 받는다", func() bool { return len(b.deliveries(pb.ID)) == 5 })
	var got []string
	for _, m := range b.deliveries(pb.ID) {
		got = append(got, m.Text)
	}
	if strings.Join(got, "") != "01234" {
		t.Fatalf("순서 %v — 갈라진 동안의 글이 섞였거나 순서가 틀렸다", got)
	}
}

// FR-PCH-33: 다른 곳에서 소멸한 방을 돌아온 노드가 말하면 그 참가자만의 방으로 다시 보인다.
func TestReturningNodeRevivesRoom(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	cut := link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	eventually(t, "B 가 방을 본다", func() bool { return roomVisible(b, pb.ID, room.ID) })
	_, _ = b.Join(pb.ID, room.ID)
	eventually(t, "A 가 B 의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	cut()
	eventually(t, "끊김", func() bool { return !nodeOnline(a, b.fp()) })
	_ = a.Leave(pa.ID, room.ID)
	eventually(t, "A 에서 방이 사라진다", func() bool { return !roomVisible(a, pa.ID, room.ID) })
	link(a, b)
	eventually(t, "A 가 B 만 있는 방을 다시 본다", func() bool {
		for _, r := range a.Rooms(pa.ID) {
			if r.ID == room.ID {
				return len(r.Members) == 1 && r.Members[0].ID == pb.ID && !r.Joined
			}
		}
		return false
	})
}

// TC-PCH-5 (FR-PCH-43·44): 참가자를 없애면 모든 방에서 나가고, 새로 만들면 방이 없다.
func TestUnregisterLeavesAllRooms(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	r1, _ := a.Create(pa.ID, "r1", "")
	r2, _ := a.Create(pa.ID, "r2", "")
	eventually(t, "B 가 두 방을 본다", func() bool { return len(b.Rooms(pb.ID)) == 2 })
	a.Unregister(pa.ID)
	eventually(t, "두 방이 사라진다", func() bool { return len(b.Rooms(pb.ID)) == 0 })
	mustCode(t, a.Send(pa.ID, r1.ID, "x"), CodeNoSuchParticipant)
	again := a.Register("a/x", KindAgent)
	if again.ID == pa.ID || len(a.Rooms(again.ID)) != 0 {
		t.Fatal("새 참가자가 이전 참가자를 잇는다")
	}
	_ = r2
}

// FR-PCH-44: 들지 않은 방에 쓰면 not_in_room, 없는 방에 들어가면 no_such_room.
func TestSendNotInRoom(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	pb := a.Register("a/y", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	mustCode(t, a.Send(pb.ID, room.ID, "x"), CodeNotInRoom)
	_, err := a.Join(pb.ID, "nope")
	mustCode(t, err, CodeNoSuchRoom)
	// FR-PCH-45: 같은 노드 안에서도 대화한다.
	if _, err := a.Join(pb.ID, room.ID); err != nil {
		t.Fatal(err)
	}
	_ = a.Send(pa.ID, room.ID, "local")
	eventually(t, "같은 노드의 참가자가 받는다", func() bool { return len(a.deliveries(pb.ID)) == 1 })
}

// TC-PCH-10 (FR-PCH-14~17): 개인채팅.
func TestDirectChat(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	pc := b.Register("b/y", KindAgent)
	eventually(t, "A 가 B 의 참가자를 본다", func() bool { return len(a.Online().Participants) == 3 })

	_, err := a.Direct(pa.ID, "nobody", "")
	mustCode(t, err, CodeNoSuchParticipant)

	room, err := a.Direct(pa.ID, pb.ID, "1대1")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "상대가 자동으로 들어간다", func() bool {
		for _, r := range b.Rooms(pb.ID) {
			if r.ID == room.ID {
				return r.Joined && r.Kind == KindDirect
			}
		}
		return false
	})
	if roomVisible(b, pc.ID, room.ID) {
		t.Fatal("제3자에게 개인채팅이 보인다")
	}
	_, err = b.Join(pc.ID, room.ID)
	mustCode(t, err, CodeNoSuchRoom)
	eventually(t, "A 가 상대의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	_ = a.Send(pa.ID, room.ID, "hi")
	eventually(t, "상대가 받는다", func() bool { return len(b.deliveries(pb.ID)) == 1 })

	_ = b.Leave(pb.ID, room.ID)
	eventually(t, "만든 쪽도 나가 방이 사라진다", func() bool { return len(a.Rooms(pa.ID)) == 0 && a.recordCount() == 0 })
	never(t, "상대가 다시 들어간다", func() bool { return roomVisible(b, pb.ID, room.ID) })
}

// FR-PCH-16: 개인채팅 상대가 연결 끊김이 된 것은 떠난 것이 아니다.
func TestDirectSurvivesDisconnect(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	cut := link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	eventually(t, "참가자를 본다", func() bool { return len(a.Online().Participants) == 2 })
	room, _ := a.Direct(pa.ID, pb.ID, "")
	eventually(t, "A 가 상대의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	cut()
	eventually(t, "끊김", func() bool { return !nodeOnline(a, b.fp()) })
	never(t, "끊김에 개인채팅이 끝난다", func() bool { return !roomVisible(a, pa.ID, room.ID) })
}

// TC-PCH-11 (FR-PCH-8·9·10a): 가운데 간선이 끊기면 너머의 노드가 바로 끊김이 된다.
func TestReachabilityFollowsLinks(t *testing.T) {
	a, b, c := newTestNode(t, "a"), newTestNode(t, "b"), newTestNode(t, "c")
	link(a, b)
	cut := link(b, c)
	eventually(t, "A 가 C 를 본다", func() bool { return nodeOnline(a, c.fp()) })
	cut()
	eventually(t, "A 가 C 를 끊김으로 본다", func() bool { return !nodeOnline(a, c.fp()) })
	if !nodeOnline(a, b.fp()) {
		t.Fatal("B 까지 끊김이 됐다")
	}
	link(c, b)
	eventually(t, "C 가 돌아온다", func() bool { return nodeOnline(a, c.fp()) })
}

// TC-PCH-12 (FR-PCH-55): 글 크기와 빈도 상한.
func TestSendLimits(t *testing.T) {
	a := newTestNode(t, "a")
	now := time.Unix(1_000_000, 0)
	a.now = func() time.Time { return now }
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	mustCode(t, a.Send(pa.ID, room.ID, strings.Repeat("x", MaxText+1)), CodeTooLarge)
	if err := a.Send(pa.ID, room.ID, strings.Repeat("x", MaxText)); err != nil {
		t.Fatalf("상한 크기: %v", err)
	}
	for i := 1; i < PerMinute; i++ {
		if err := a.Send(pa.ID, room.ID, "x"); err != nil {
			t.Fatalf("%d 번째: %v", i+1, err)
		}
	}
	mustCode(t, a.Send(pa.ID, room.ID, "x"), CodeRateLimited)
	now = now.Add(time.Minute + time.Second)
	if err := a.Send(pa.ID, room.ID, "x"); err != nil {
		t.Fatalf("1분 뒤: %v", err)
	}
}

// FR-PCH-55: 받는 쪽도 보낸 참가자마다 상한을 센다.
func TestReceiveRateLimited(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	f := newFakePeer(t, a)
	f.state(t, []statePart{{ID: f.pid("fp1"), Label: "f/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{a.recordOf(room.ID)}, []string{a.fp()})
	eventually(t, "참가자를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	for i := range PerMinute + 5 {
		fr, _ := signFrame(f.id, frameMsg, msgBody{ID: "m" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Node: f.id.Fingerprint, Epoch: 1, Seq: uint64(i + 1), Room: room.ID, From: f.pid("fp1"), Text: "x", At: time.Now()})
		f.write(t, fr)
	}
	eventually(t, "상한만큼 받는다", func() bool { return len(a.deliveries(pa.ID)) == PerMinute })
	never(t, "상한을 넘겨 받는다", func() bool { return len(a.deliveries(pa.ID)) > PerMinute })
}

// FR-PCH-8: 같은 상대와 연결이 둘이면 하나만 남기고, 채팅은 그대로 된다.
func TestDuplicateLinksCollapse(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	link(b, a)
	eventually(t, "이어진다", func() bool { return a.mesh.Linked(b.fp()) && b.mesh.Linked(a.fp()) })
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	eventually(t, "B 가 방을 본다", func() bool { return roomVisible(b, pb.ID, room.ID) })
	_, _ = b.Join(pb.ID, room.ID)
	eventually(t, "A 가 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	_ = a.Send(pa.ID, room.ID, "x")
	eventually(t, "B 가 받는다", func() bool { return len(b.deliveries(pb.ID)) == 1 })
}

func TestErrorCodeOfPlainError(t *testing.T) {
	if ErrorCode(errors.New("x")) != "" || ErrorCode(nil) != "" {
		t.Fatal("일반 오류에 코드가 붙었다")
	}
}

// FR-PCH-9: 상태 알림은 자기 내용이 바뀔 때만 낸다 — 노드끼리 알림을 끝없이 주고받지 않는다.
func TestStateAnnouncementsSettle(t *testing.T) {
	a, b, c := newTestNode(t, "a"), newTestNode(t, "b"), newTestNode(t, "c")
	link(a, b)
	link(b, c)
	link(c, a)
	a.Register("a/x", KindAgent)
	eventually(t, "C 가 A 의 참가자를 본다", func() bool { return len(c.Online().Participants) == 1 })
	time.Sleep(100 * time.Millisecond)
	seqOf := func(n *testNode) uint64 {
		n.Service.mu.Lock()
		defer n.Service.mu.Unlock()
		return n.seq
	}
	before := []uint64{seqOf(a), seqOf(b), seqOf(c)}
	time.Sleep(200 * time.Millisecond)
	after := []uint64{seqOf(a), seqOf(b), seqOf(c)}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("알림이 멈추지 않는다: %v → %v", before, after)
		}
	}
}

// FR-PCH-15·20 (보안 검토): 개인채팅에는 두 참가자만 쓴다. 제3의 노드가 그 방에 참가자를
// 적거나 상대의 id 를 사칭해도 글은 전달되지 않는다.
func TestDirectRejectsThirdNode(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	eventually(t, "참가자를 본다", func() bool { return len(a.Online().Participants) == 2 })
	room, _ := a.Direct(pa.ID, pb.ID, "")
	eventually(t, "A 가 상대의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })

	f := newFakePeer(t, a)
	rec := a.recordOf(room.ID)
	for i, from := range []string{f.pid("evil"), pb.ID} {
		f.state(t, []statePart{{ID: from, Label: "f/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{rec}, []string{a.fp()})
		fr, _ := signFrame(f.id, frameMsg, msgBody{ID: "x" + string(rune('a'+i)), Node: f.id.Fingerprint, Epoch: 1, Seq: uint64(i + 1), Room: room.ID, From: from, Text: "끼어들기", At: time.Now()})
		f.write(t, fr)
	}
	never(t, "제3의 노드 글이 개인채팅에 들어온다", func() bool { return len(a.deliveries(pa.ID)) > 0 })
	_ = b.Send(pb.ID, room.ID, "진짜")
	eventually(t, "진짜 상대의 글은 온다", func() bool { return len(a.deliveries(pa.ID)) == 1 })
}

// FR-PCH-20 (보안 검토): 이 노드의 참가자 id 를 주장하는 남의 상태는 버린다.
func TestStateClaimingLocalParticipantDropped(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	f := newFakePeer(t, a)
	f.state(t, []statePart{{ID: pa.ID, Label: "spoof", Kind: KindAgent}}, nil, []string{a.fp()})
	never(t, "사칭한 참가자가 목록에 선다", func() bool { return len(a.Online().Participants) > 1 })
}

// FR-PCH-4 (보안 검토): 지난 글을 다시 보내도 다시 전달되지 않는다 — id 를 잊은 뒤에도,
// 보낸 노드가 다시 선 뒤(epoch 가 바뀐 뒤)에도.
func TestReplayedMessageDropped(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	f := newFakePeer(t, a)
	f.state(t, []statePart{{ID: f.pid("fp1"), Label: "f/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{a.recordOf(room.ID)}, []string{a.fp()})
	eventually(t, "참가자를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	old, _ := signFrame(f.id, frameMsg, msgBody{ID: "old", Node: f.id.Fingerprint, Epoch: 1, Seq: 1, Room: room.ID, From: f.pid("fp1"), Text: "1", At: time.Now()})
	f.write(t, old)
	eventually(t, "처음 글", func() bool { return len(a.deliveries(pa.ID)) == 1 })
	f.write(t, old)
	never(t, "같은 글이 다시 온다", func() bool { return len(a.deliveries(pa.ID)) > 1 })
	stale, _ := signFrame(f.id, frameMsg, msgBody{ID: "stale", Node: f.id.Fingerprint, Epoch: 0, Seq: 9, Room: room.ID, From: f.pid("fp1"), Text: "2", At: time.Now()})
	f.write(t, stale)
	never(t, "지난 epoch 의 글이 온다", func() bool { return len(a.deliveries(pa.ID)) > 1 })
}

// 보안 검토: 줄바꿈·탭 밖의 제어 문자가 든 글은 보내지도 받지도 않는다.
func TestControlCharsRejected(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	mustCode(t, a.Send(pa.ID, room.ID, "a\x1b[2Jb"), CodeBadRequest)
	if err := a.Send(pa.ID, room.ID, "줄\n바꿈\t탭"); err != nil {
		t.Fatalf("줄바꿈·탭: %v", err)
	}
	f := newFakePeer(t, a)
	f.state(t, []statePart{{ID: f.pid("fp1"), Label: "f/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{a.recordOf(room.ID)}, []string{a.fp()})
	eventually(t, "참가자를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	fr, _ := signFrame(f.id, frameMsg, msgBody{ID: "esc", Node: f.id.Fingerprint, Epoch: 1, Seq: 1, Room: room.ID, From: f.pid("fp1"), Text: "\x1b]0;x\x07", At: time.Now()})
	f.write(t, fr)
	never(t, "제어 문자 글이 온다", func() bool { return len(a.deliveries(pa.ID)) > 0 })
}

// 보안 검토: 아는 노드 수에 상한이 있다. 가득 차면 닿지 않는 노드부터 잊는다.
func TestRemoteNodesCapped(t *testing.T) {
	a := newTestNode(t, "a")
	f := newFakePeer(t, a)
	for range maxNodes + 10 {
		id, err := edge.LoadOrCreateIdentity(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		fr, _ := signFrame(id, frameState, stateBody{Node: id.Fingerprint, Key: publicKeyOf(id), Epoch: 1, Seq: 1})
		f.write(t, fr)
	}
	f.state(t, nil, nil, []string{a.fp()})
	eventually(t, "직접 이어진 노드는 남는다", func() bool { return nodeOnline(a, f.id.Fingerprint) })
	a.Service.mu.Lock()
	n := len(a.nodes)
	a.Service.mu.Unlock()
	if n > maxNodes {
		t.Fatalf("아는 노드 %d > %d", n, maxNodes)
	}
}

// 보안 검토: 참가자 id 는 노드에 묶인다. 남의 노드 접두어를 단 주장은 버려지고, 진짜 노드의
// 상태는 막히지 않는다.
func TestParticipantIDBoundToNode(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	pb := b.Register("b/x", KindAgent)
	if pb.ID[:idPrefix] != b.fp()[:idPrefix] {
		t.Fatalf("id %s 가 노드에 묶이지 않았다", pb.ID)
	}
	f := newFakePeer(t, a)
	f.state(t, []statePart{{ID: pb.ID, Label: "squat", Kind: KindAgent}}, nil, []string{a.fp()})
	link(a, b)
	eventually(t, "진짜 B 의 참가자가 보인다", func() bool {
		for _, m := range a.Online().Participants {
			if m.ID == pb.ID {
				return m.Label == "b/x" && m.Node == b.fp()
			}
		}
		return false
	})
}

// 보안 검토: 잊은 노드의 옛 상태와 옛 글을 다시 보내도 받지 않는다.
func TestEvictedNodeReplayDropped(t *testing.T) {
	a := newTestNode(t, "a")
	a.maxNodes = 2
	pa := a.Register("a/x", KindAgent)
	room, _ := a.Create(pa.ID, "r", "")
	f := newFakePeer(t, a)
	f.state(t, nil, nil, []string{a.fp()})
	x, _ := edge.LoadOrCreateIdentity(t.TempDir())
	xp := x.Fingerprint[:idPrefix] + "-x"
	xState, _ := signFrame(x, frameState, stateBody{Node: x.Fingerprint, Key: publicKeyOf(x), Epoch: 1, Seq: 1,
		Parts: []statePart{{ID: xp, Label: "x/x", Kind: KindAgent, Rooms: []string{room.ID}}}})
	xMsg, _ := signFrame(x, frameMsg, msgBody{ID: "xm", Node: x.Fingerprint, Epoch: 1, Seq: 1, Room: room.ID, From: xp, Text: "옛 글", At: time.Now()})
	f.write(t, xState)
	f.write(t, xMsg)
	eventually(t, "X 의 글을 받는다", func() bool { return len(a.deliveries(pa.ID)) == 1 })
	y, _ := edge.LoadOrCreateIdentity(t.TempDir())
	yState, _ := signFrame(y, frameState, stateBody{Node: y.Fingerprint, Key: publicKeyOf(y), Epoch: 1, Seq: 1})
	f.write(t, yState)
	eventually(t, "X 를 잊는다", func() bool {
		a.Service.mu.Lock()
		defer a.Service.mu.Unlock()
		_, known := a.nodes[x.Fingerprint]
		return !known
	})
	// 자리를 늘려, X 를 다시 들일지는 상한이 아니라 기억한 번호로만 가르게 한다.
	a.Service.mu.Lock()
	a.maxNodes = 3
	a.Service.mu.Unlock()
	f.write(t, xState)
	f.write(t, xMsg)
	never(t, "옛 글이 다시 온다", func() bool { return len(a.deliveries(pa.ID)) > 1 })
}

// 보안 검토: 1대1 채팅 상대의 노드를 잊게 만들어도 채팅이 끝나지 않는다.
func TestDirectPeerNodeNotEvicted(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	cut := link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	eventually(t, "참가자를 본다", func() bool { return len(a.Online().Participants) == 2 })
	room, _ := a.Direct(pa.ID, pb.ID, "")
	eventually(t, "A 가 상대의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
	cut()
	eventually(t, "끊김", func() bool { return !nodeOnline(a, b.fp()) })
	a.Service.mu.Lock()
	a.maxNodes = 2
	a.Service.mu.Unlock()
	f := newFakePeer(t, a)
	f.state(t, nil, nil, []string{a.fp()})
	y, _ := edge.LoadOrCreateIdentity(t.TempDir())
	yState, _ := signFrame(y, frameState, stateBody{Node: y.Fingerprint, Key: publicKeyOf(y), Epoch: 1, Seq: 1})
	f.write(t, yState)
	never(t, "1대1 채팅이 끝난다", func() bool { return !roomVisible(a, pa.ID, room.ID) })
}

// 보안 검토: 남이 만든 개인채팅에 자동으로 들어가는 것도 방 상한을 지킨다.
func TestDirectAutoJoinCapped(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	f := newFakePeer(t, a)
	owners := []string{f.pid("o1"), f.pid("o2")}
	var recs []signedRecord
	byOwner := map[string][]string{}
	for i := range maxPartRooms + 5 {
		o := owners[i/maxPartRooms]
		rec, err := newRecord(f.id, recordBody{Kind: KindDirect, Owner: o, Peer: pa.ID, PeerNode: a.fp(), Created: time.Now(), Nonce: string(rune('a'+i%26)) + string(rune('a'+i/26))})
		if err != nil {
			t.Fatal(err)
		}
		recs = append(recs, rec)
		byOwner[o] = append(byOwner[o], rec.id())
	}
	f.state(t, []statePart{
		{ID: owners[0], Label: "f/o1", Kind: KindAgent, Rooms: byOwner[owners[0]]},
		{ID: owners[1], Label: "f/o2", Kind: KindAgent, Rooms: byOwner[owners[1]]},
	}, recs, []string{a.fp()})
	eventually(t, "상한까지 들어간다", func() bool { return len(a.Rooms(pa.ID)) >= maxPartRooms })
	never(t, "상한을 넘어 들어간다", func() bool {
		n := 0
		for _, r := range a.Rooms(pa.ID) {
			if r.Joined {
				n++
			}
		}
		return n > maxPartRooms
	})
}

// PEER_CHAT_SRS §3.11: 상태가 바뀌면 Changed 로 알린다. 화면이 다시 읽는 계기다.
func TestChangedNotifies(t *testing.T) {
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	n := 0
	count := func() int { mu.Lock(); defer mu.Unlock(); return n }
	m := newMesh(t, id, "a")
	s := New(Options{Identity: id, Mesh: m, Changed: func() { mu.Lock(); n++; mu.Unlock() }})
	t.Cleanup(s.Close)
	before := count()
	p := s.Register("a/x", KindAgent)
	eventually(t, "참가 알림", func() bool { return count() > before })
	before = count()
	if _, err := s.Create(p.ID, "r", "p"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "방 알림", func() bool { return count() > before })
	b := newTestNode(t, "b")
	before = count()
	link(&testNode{Service: s, mesh: m, t: t, name: "a"}, b)
	b.Register("b/y", KindAgent)
	eventually(t, "남의 상태 알림", func() bool { return count() > before+1 })
}

func leftCount(s *testNode, pid string) int {
	s.Service.mu.Lock()
	defer s.Service.mu.Unlock()
	return len(s.parts[pid].left)
}

// TC-ATF-52 (FR-ATF-52): 나간 개인채팅은 상대 노드 상태에 남아 있는 동안 다시 들어가지 않고,
// 상대 노드 상태에서 사라지면 left 에서도 지운다.
func TestLeftDirectForgottenWhenGone(t *testing.T) {
	a := newTestNode(t, "a")
	pa := a.Register("a/x", KindAgent)
	f := newFakePeer(t, a)
	owner := f.pid("o")
	rec, err := newRecord(f.id, recordBody{Kind: KindDirect, Owner: owner, Peer: pa.ID, PeerNode: a.fp(), Created: time.Now(), Nonce: "n1"})
	if err != nil {
		t.Fatal(err)
	}
	inRoom := []statePart{{ID: owner, Label: "f/o", Kind: KindAgent, Rooms: []string{rec.id()}}}
	f.state(t, inRoom, []signedRecord{rec}, []string{a.fp()})
	eventually(t, "자동으로 들어간다", func() bool { return roomVisible(a, pa.ID, rec.id()) })
	if err := a.Leave(pa.ID, rec.id()); err != nil {
		t.Fatal(err)
	}
	f.state(t, inRoom, []signedRecord{rec}, nil)
	never(t, "방이 남은 동안 다시 들어간다", func() bool { return roomVisible(a, pa.ID, rec.id()) })
	if leftCount(a, pa.ID) != 1 {
		t.Fatal("방이 남은 동안 left 를 지웠다")
	}
	f.state(t, []statePart{{ID: owner, Label: "f/o", Kind: KindAgent}}, nil, nil)
	eventually(t, "사라진 방을 left 에서 지운다", func() bool { return leftCount(a, pa.ID) == 0 })
}

// TC-ATF-52 (FR-ATF-52): 1:1 방을 만들고 나가기를 되풀이해도 left 가 쌓이지 않는다.
func TestLeftDirectDoesNotGrow(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	link(a, b)
	pa := a.Register("a/x", KindAgent)
	pb := b.Register("b/x", KindAgent)
	eventually(t, "참가자를 본다", func() bool { return len(a.Online().Participants) == 2 })
	for range 3 {
		room, err := a.Direct(pa.ID, pb.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		eventually(t, "상대가 들어간다", func() bool { return roomVisible(b, pb.ID, room.ID) })
		eventually(t, "A 가 상대의 참가를 본다", func() bool { return len(a.Rooms(pa.ID)[0].Members) == 2 })
		if err := b.Leave(pb.ID, room.ID); err != nil {
			t.Fatal(err)
		}
		eventually(t, "방이 사라진다", func() bool { return a.recordCount() == 0 })
	}
	eventually(t, "left 가 비워진다", func() bool { return leftCount(a, pa.ID) == 0 && leftCount(b, pb.ID) == 0 })
}

// orderedFixture 는 가짜 노드 f 의 참가자와 a 의 참가자가 함께 든 방이다. g 는 f 의 글을 다른
// 연결로 나르는 두 번째 가짜 상대다. Deliver 는 글 "1" 에서 release 가 닫힐 때까지 멈춘다.
type orderedFixture struct {
	a       *testNode
	f, g    *fakePeer
	room    string
	from    string
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	got     []string
}

func newOrderedFixture(t *testing.T) *orderedFixture {
	t.Helper()
	x := &orderedFixture{a: newTestNode(t, "a"), entered: make(chan struct{}), release: make(chan struct{})}
	pa := x.a.Register("a/x", KindAgent)
	room, _ := x.a.Create(pa.ID, "r", "")
	x.room = room.ID
	x.f, x.g = newFakePeer(t, x.a), newFakePeer(t, x.a)
	x.from = x.f.pid("fp1")
	x.f.state(t, []statePart{{ID: x.from, Label: "f/x", Kind: KindAgent, Rooms: []string{room.ID}}}, []signedRecord{x.a.recordOf(room.ID)}, []string{x.a.fp()})
	eventually(t, "참가자를 본다", func() bool { return len(x.a.Rooms(pa.ID)[0].Members) == 2 })
	x.a.Service.mu.Lock()
	x.a.opts.Deliver = func(_ string, m Message) {
		if m.Text == "1" {
			close(x.entered)
			<-x.release
		}
		x.mu.Lock()
		x.got = append(x.got, m.Text)
		x.mu.Unlock()
	}
	x.a.Service.mu.Unlock()
	return x
}

func (x *orderedFixture) msg(t *testing.T, seq uint64) frame {
	t.Helper()
	text := string(rune('0' + seq))
	fr, err := signFrame(x.f.id, frameMsg, msgBody{ID: "m" + text, Node: x.f.id.Fingerprint, Epoch: 1, Seq: seq, Room: x.room, From: x.from, Text: text, At: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	return fr
}

func (x *orderedFixture) delivered() []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return append([]string{}, x.got...)
}

// TC-ATF-53 (FR-ATF-53): 같은 노드의 글은 다른 연결로 와도 받은 순서대로 넘긴다.
func TestDeliveryOrderPerNode(t *testing.T) {
	x := newOrderedFixture(t)
	x.f.write(t, x.msg(t, 1))
	<-x.entered
	x.g.write(t, x.msg(t, 2))
	never(t, "앞 글을 넘기기 전에 뒷 글을 넘긴다", func() bool { return len(x.delivered()) > 0 })
	close(x.release)
	eventually(t, "두 글", func() bool { return len(x.delivered()) == 2 })
	if got := x.delivered(); got[0] != "1" || got[1] != "2" {
		t.Fatalf("순서 = %v", got)
	}
}
