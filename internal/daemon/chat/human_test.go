package chat

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/humancmd"
)

// PEER_CHAT_SRS §3.12 단계 4 — 사람 명령 프레임과 도우미 키 신뢰 (TC-PCH-7 채팅 쪽).

type humanNode struct {
	*testNode
	helper ed25519.PrivateKey
	emu    sync.Mutex
	edges  []edge.Edge
	// noPin 이면 Pin 이 아무것도 적지 않는다(고정하지 못한 노드 흉내).
	noPin bool
}

// newHumanNode 는 도우미 키와 간선 목록을 가진 시험 노드다. Pin 은 간선 항목에 적는다.
func newHumanNode(t *testing.T, name string) *humanNode {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &humanNode{testNode: &testNode{t: t, name: name}, helper: priv}
	h.Service = New(Options{
		Identity: id,
		Name:     func() string { return name },
		Deliver: func(pid string, m Message) {
			h.mu.Lock()
			h.got = append(h.got, delivery{pid, m})
			h.mu.Unlock()
		},
		Edges: func() []edge.Edge {
			h.emu.Lock()
			defer h.emu.Unlock()
			return append([]edge.Edge{}, h.edges...)
		},
		Pin: func(fp, key string) {
			h.emu.Lock()
			defer h.emu.Unlock()
			if h.noPin {
				return
			}
			for i := range h.edges {
				if h.edges[i].Fingerprint == fp && h.edges[i].HelperKey == "" {
					h.edges[i].HelperKey = key
				}
			}
		},
	})
	h.SetHelper(humancmd.PublicKey(priv))
	t.Cleanup(h.Close)
	return h
}

func (h *humanNode) pinOf(fp string) string {
	h.emu.Lock()
	defer h.emu.Unlock()
	for _, e := range h.edges {
		if e.Fingerprint == fp {
			return e.HelperKey
		}
	}
	return ""
}

// edgeLink 는 두 노드를 간선으로 등록하고 메모리 연결로 잇는다.
func edgeLink(a, b *humanNode) func() {
	a.emu.Lock()
	a.edges = append(a.edges, edge.Edge{Name: b.name, Fingerprint: b.fp()})
	a.emu.Unlock()
	b.emu.Lock()
	b.edges = append(b.edges, edge.Edge{Name: a.name, Fingerprint: a.fp()})
	b.emu.Unlock()
	return link(a.testNode, b.testNode)
}

func signCmd(t *testing.T, key ed25519.PrivateKey, node, op string, rooms []string, kicks []humancmd.Kick, at time.Time) humancmd.Signed {
	t.Helper()
	s, err := humancmd.Sign(key, humancmd.Body{ID: humancmd.NewID(), Node: node, Op: op, Rooms: rooms, Kicks: kicks, At: at.UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func cmdFrame(s humancmd.Signed) frame { return frame{T: frameCmd, B: s.B, S: s.S} }

func inRoom(n *humanNode, pid, room string) bool {
	for _, r := range n.Rooms(pid) {
		if r.ID == room {
			return r.Joined
		}
	}
	return false
}

// triangle 은 A-B-C(A·C 는 간선 아님)와 C 가 만든 방에 셋이 든 상태다.
func triangle(t *testing.T) (a, b, c *humanNode, pa, pb, pc Participant, room string) {
	t.Helper()
	a, b, c = newHumanNode(t, "a"), newHumanNode(t, "b"), newHumanNode(t, "c")
	edgeLink(a, b)
	edgeLink(b, c)
	pa, pb, pc = a.Register("a/x", KindAgent), b.Register("b/x", KindAgent), c.Register("c/x", KindAgent)
	r, err := c.Create(pc.ID, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	room = r.ID
	eventually(t, "A·B 가 방을 본다", func() bool { return roomVisible(a.testNode, pa.ID, room) && roomVisible(b.testNode, pb.ID, room) })
	if _, err := a.Join(pa.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Join(pb.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	// 간선 상대의 도우미 키가 고정되고, B 의 고정값이 C 에 퍼질 때까지 기다린다.
	eventually(t, "고정", func() bool {
		return a.pinOf(b.fp()) == b.HelperKey() && b.pinOf(a.fp()) == a.HelperKey() && b.pinOf(c.fp()) == c.HelperKey() && c.pinOf(b.fp()) == b.HelperKey()
	})
	eventually(t, "C 가 A 의 키를 B 의 고정값으로 안다", func() bool {
		k, ok := c.trustedKey(a.fp())
		return ok && k == a.HelperKey()
	})
	return
}

func (s *Service) trustedKey(node string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.trustedKeyLocked(node)
}

// 간선 상대가 낸 강제 삭제: 모든 노드의 참가자가 나가고 방이 사라진다.
func TestKillByEdgePeer(t *testing.T) {
	a, b, c, pa, pb, pc, room := triangle(t)
	if err := b.Command(signCmd(t, b.helper, b.fp(), humancmd.OpKill, []string{room}, nil, time.Now())); err != nil {
		t.Fatal(err)
	}
	eventually(t, "셋 모두 방에서 나간다", func() bool {
		return !inRoom(a, pa.ID, room) && !inRoom(b, pb.ID, room) && !inRoom(c, pc.ID, room)
	})
	eventually(t, "방이 사라진다", func() bool {
		return !roomVisible(a.testNode, pa.ID, room) && !roomVisible(c.testNode, pc.ID, room)
	})
}

// 망 이웃이 낸 강퇴: C 는 A 의 키를 B 의 고정값으로 믿는다. 대상만 빠진다.
func TestKickByNeighbor(t *testing.T) {
	a, b, c, pa, pb, pc, room := triangle(t)
	kick := []humancmd.Kick{{Room: room, Participant: pc.ID}}
	if err := a.Command(signCmd(t, a.helper, a.fp(), humancmd.OpKick, nil, kick, time.Now())); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 의 참가자가 빠진다", func() bool { return !inRoom(c, pc.ID, room) })
	never(t, "다른 참가자가 빠진다", func() bool { return !inRoom(a, pa.ID, room) || !inRoom(b, pb.ID, room) })
}

// 낸 노드는 자기 도우미 키로 서명된 것만 낸다.
func TestCommandOwnNodeOnly(t *testing.T) {
	a, b, _, _, _, _, room := triangle(t)
	if err := a.Command(signCmd(t, a.helper, b.fp(), humancmd.OpKill, []string{room}, nil, time.Now())); err == nil {
		t.Fatal("다른 노드 이름의 명령을 냈다")
	}
}

// §3.12a R-3: Command 는 서명 본문의 키를 이 노드의 도우미 키로 싣고 같은 잠금 안에서 적용한다.
// 도우미 키를 아직 몰라도(watchHelper 가 비웠어도) 도우미가 서명한 명령은 적용된다.
func TestCommandAdoptsSignedKey(t *testing.T) {
	a, _, _, pa, _, _, room := triangle(t)
	a.SetHelper("")
	_, fresh, _ := ed25519.GenerateKey(rand.Reader)
	if err := a.Command(signCmd(t, fresh, a.fp(), humancmd.OpKill, []string{room}, nil, time.Now())); err != nil {
		t.Fatal(err)
	}
	if a.HelperKey() != humancmd.PublicKey(fresh) {
		t.Fatal("서명 본문의 키를 싣지 않았다")
	}
	if inRoom(a, pa.ID, room) {
		t.Fatal("적용되지 않았다")
	}
}

// 고정 키와 다른 키, 시각 밖, 같은 id 두 번은 받지 않는다.
func TestCommandRejected(t *testing.T) {
	a, b, _, pa, pb, _, room := triangle(t)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	kickA := []humancmd.Kick{{Room: room, Participant: pa.ID}}
	a.handle(nil, cmdFrame(signCmd(t, other, b.fp(), humancmd.OpKick, nil, kickA, time.Now())))
	never(t, "고정과 다른 키의 강퇴", func() bool { return !inRoom(a, pa.ID, room) })
	a.handle(nil, cmdFrame(signCmd(t, b.helper, b.fp(), humancmd.OpKick, nil, kickA, time.Now().Add(-6*time.Minute))))
	never(t, "오래된 강퇴", func() bool { return !inRoom(a, pa.ID, room) })

	kickB := []humancmd.Kick{{Room: room, Participant: pb.ID}}
	once := signCmd(t, a.helper, a.fp(), humancmd.OpKick, nil, kickB, time.Now())
	b.handle(nil, cmdFrame(once))
	eventually(t, "첫 강퇴", func() bool { return !inRoom(b, pb.ID, room) })
	if _, err := b.Join(pb.ID, room); err != nil {
		t.Fatal(err)
	}
	b.handle(nil, cmdFrame(once))
	never(t, "같은 id 의 두 번째 강퇴", func() bool { return !inRoom(b, pb.ID, room) })
}

// 이미 고정한 키는 바꾸지 않는다. 다른 키를 알리는 간선 상대의 명령은 받지 않는다.
func TestPinNotReplaced(t *testing.T) {
	a, b := newHumanNode(t, "a"), newHumanNode(t, "b")
	_, stale, _ := ed25519.GenerateKey(rand.Reader)
	a.edges = append(a.edges, edge.Edge{Name: "b", Fingerprint: b.fp(), HelperKey: humancmd.PublicKey(stale)})
	b.edges = append(b.edges, edge.Edge{Name: "a", Fingerprint: a.fp()})
	link(a.testNode, b.testNode)
	pa, pb := a.Register("a/x", KindAgent), b.Register("b/x", KindAgent)
	r, err := b.Create(pb.ID, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "A 가 방을 본다", func() bool { return roomVisible(a.testNode, pa.ID, r.ID) })
	if _, err := a.Join(pa.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	if err := b.Command(signCmd(t, b.helper, b.fp(), humancmd.OpKick, nil, []humancmd.Kick{{Room: r.ID, Participant: pa.ID}}, time.Now())); err != nil {
		t.Fatal(err)
	}
	never(t, "고정과 다른 키의 강퇴", func() bool { return !inRoom(a, pa.ID, r.ID) })
	if got := a.pinOf(b.fp()); got != humancmd.PublicKey(stale) {
		t.Fatalf("고정이 바뀌었다: %s", got)
	}
}

// 망 이웃의 키는 고정값이 하나 이상이고 모두 같을 때만 믿는다.
func TestAgreedPins(t *testing.T) {
	cases := []struct {
		pins []string
		want string
		ok   bool
	}{
		{nil, "", false},
		{[]string{"k"}, "k", true},
		{[]string{"k", "k"}, "k", true},
		{[]string{"k", "j"}, "", false},
	}
	for _, c := range cases {
		got, ok := agreed(c.pins)
		if got != c.want || ok != c.ok {
			t.Errorf("agreed(%v) = %q,%v", c.pins, got, ok)
		}
	}
}

// 보증은 대상 노드와 서로 이어진 간선 상대의 고정값만 센다. 간선이 아닌 노드가 실은 다른 키는
// 믿음을 바꾸지 못한다 (보안 검토).
func TestNonAdjacentPinIgnored(t *testing.T) {
	a, _, c, _, _, _, _ := triangle(t)
	f := newFakePeer(t, a.testNode)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	st := stateBody{Node: f.id.Fingerprint, Key: publicKeyOf(f.id), Name: "fake", Epoch: 1, Seq: 1,
		Links: []string{a.fp()}, Pins: map[string]string{c.fp(): humancmd.PublicKey(other)}}
	fr, err := signFrame(f.id, frameState, st)
	if err != nil {
		t.Fatal(err)
	}
	f.write(t, fr)
	eventually(t, "A 가 가짜 노드를 온라인으로 본다", func() bool { return nodeOnline(a.testNode, f.id.Fingerprint) })
	k, ok := a.trustedKey(c.fp())
	if !ok || k != c.HelperKey() {
		t.Fatalf("C 의 키 = %q,%v — 간선이 아닌 노드의 고정값에 흔들렸다", k, ok)
	}
}

// 대상 노드 자신이 알린 helper 와 다른 보증은 믿지 않는다.
func TestPinMustMatchOwnHelper(t *testing.T) {
	a, _, c, _, _, _, _ := triangle(t)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	c.SetHelper(humancmd.PublicKey(other))
	eventually(t, "A 가 C 를 믿지 않는다", func() bool { _, ok := a.trustedKey(c.fp()); return !ok })
}

func TestHelperKeyShape(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	if !validHelperKey(humancmd.PublicKey(priv)) || !validHelperKey("") {
		t.Fatal("바른 키를 거절했다")
	}
	if validHelperKey("abc") || validHelperKey(strings.Repeat("A", 44)+"x") {
		t.Fatal("틀린 키를 받았다")
	}
}

// §3.12a R-6: 간선 상대의 같은 상태가 다른 길로 먼저 와도, 직접 연결로 온 상태로 고정한다.
func TestPinAfterRelayedState(t *testing.T) {
	a, b := newHumanNode(t, "a"), newHumanNode(t, "b")
	a.edges = append(a.edges, edge.Edge{Name: "b", Fingerprint: b.fp()})
	b.mu.Lock()
	own := b.own
	b.mu.Unlock()
	a.handle(nil, own) // 다른 노드를 거쳐 먼저 온 것처럼
	p1, p2 := net.Pipe()
	t.Cleanup(func() { _ = p1.Close(); _ = p2.Close() })
	go func() { _, _ = io.Copy(io.Discard, p2) }()
	a.attach(b.fp(), p1, true)
	raw, _ := json.Marshal(own) // 같은 상태가 직접 연결로 늦게 온다
	if _, err := p2.Write(append(raw, '\n')); err != nil {
		t.Fatal(err)
	}
	eventually(t, "A 가 B 의 도우미 키를 고정한다", func() bool { return a.pinOf(b.fp()) == b.HelperKey() })
}

// §3.12a R-2: 고정한 간선에 같은 지문을 다시 더해도 helperKey 가 남는다 (edge 쪽 시험과 짝).

// §3.12a R-10: 서명이 맞으면 믿지 못해도 넘긴다. 적용은 각 노드가 정한다.
func TestCommandForwardedThroughUntrusting(t *testing.T) {
	a, b, c, d := newHumanNode(t, "a"), newHumanNode(t, "b"), newHumanNode(t, "c"), newHumanNode(t, "d")
	b.noPin = true
	edgeLink(a, b)
	edgeLink(b, c)
	edgeLink(a, d)
	pa, pb, pc := a.Register("a/x", KindAgent), b.Register("b/x", KindAgent), c.Register("c/x", KindAgent)
	r, err := c.Create(pc.ID, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "방이 보인다", func() bool { return roomVisible(a.testNode, pa.ID, r.ID) && roomVisible(b.testNode, pb.ID, r.ID) })
	if _, err := b.Join(pb.ID, r.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 가 D 의 고정값으로 A 를 믿는다", func() bool {
		k, ok := c.trustedKey(a.fp())
		return ok && k == a.HelperKey()
	})
	if _, ok := b.trustedKey(a.fp()); ok {
		t.Fatal("B 가 A 를 믿는다 — 시험 전제가 틀렸다")
	}
	if err := a.Command(signCmd(t, a.helper, a.fp(), humancmd.OpKill, []string{r.ID}, nil, time.Now())); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 가 적용한다", func() bool { return !inRoom(c, pc.ID, r.ID) })
	never(t, "B 가 적용한다", func() bool { return !inRoom(b, pb.ID, r.ID) })
}

// 보안 검토: 같은 id 를 단 가짜(다른 키) 명령이 먼저 와도 진짜 명령을 막지 못한다.
func TestForgedSameIDDoesNotSuppress(t *testing.T) {
	a, b, _, _, pb, _, room := triangle(t)
	real := signCmd(t, a.helper, a.fp(), humancmd.OpKick, nil, []humancmd.Kick{{Room: room, Participant: pb.ID}}, time.Now())
	rb, err := humancmd.Open(real)
	if err != nil {
		t.Fatal(err)
	}
	_, evil, _ := ed25519.GenerateKey(rand.Reader)
	forged, err := humancmd.Sign(evil, humancmd.Body{ID: rb.ID, Node: a.fp(), Op: rb.Op, Kicks: rb.Kicks, At: rb.At})
	if err != nil {
		t.Fatal(err)
	}
	b.handle(nil, cmdFrame(forged))
	b.handle(nil, cmdFrame(real))
	eventually(t, "진짜 강퇴가 적용된다", func() bool { return !inRoom(b, pb.ID, room) })
}

// 같은 서명을 비정규 base64 로 바꿔 다시 보내도 두 번 적용되지 않는다 (§3.12a R-10).
func TestNonCanonicalReplayIgnored(t *testing.T) {
	a, b, _, _, pb, _, room := triangle(t)
	real := signCmd(t, a.helper, a.fp(), humancmd.OpKick, nil, []humancmd.Kick{{Room: room, Participant: pb.ID}}, time.Now())
	b.handle(nil, cmdFrame(real))
	eventually(t, "강퇴가 적용된다", func() bool { return !inRoom(b, pb.ID, room) })
	if _, err := b.Join(pb.ID, room); err != nil {
		t.Fatal(err)
	}
	replay := humancmd.Signed{B: real.B, S: real.S[:10] + "\n" + real.S[10:]}
	b.handle(nil, cmdFrame(replay))
	if !inRoom(b, pb.ID, room) {
		t.Fatal("비정규 표기 재전송이 다시 적용됐다")
	}
}
