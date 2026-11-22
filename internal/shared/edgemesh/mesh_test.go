package edgemesh

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
)

// EDGE_MESH_SRS 묶음 L·N·H·I — 간선 계층의 연결·망 정보·직접 정보·초대.

type testMesh struct {
	*Mesh
	t      *testing.T
	mu     sync.Mutex
	hellos map[string]Hello
	sent   map[string]int
	inv    []Invite
	name   string
	edges  []edge.Edge
}

func newTestMesh(t *testing.T, name string) *testMesh {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tm := &testMesh{t: t, name: name, hellos: map[string]Hello{}, sent: map[string]int{}}
	tm.Mesh = New(Options{
		Identity: id,
		Name:     func() string { tm.mu.Lock(); defer tm.mu.Unlock(); return tm.name },
		Hello:    func() Hello { tm.mu.Lock(); defer tm.mu.Unlock(); return Hello{Name: tm.name} },
		Edges:    func() []edge.Edge { tm.mu.Lock(); defer tm.mu.Unlock(); return append([]edge.Edge{}, tm.edges...) },
		OnHello: func(fp string, h Hello, _ string) {
			tm.mu.Lock()
			tm.hellos[fp] = h
			tm.mu.Unlock()
		},
		OnHelloSent: func(fp string) {
			tm.mu.Lock()
			tm.sent[fp]++
			tm.mu.Unlock()
		},
		OnInvite: func(inv Invite) {
			tm.mu.Lock()
			tm.inv = append(tm.inv, inv)
			tm.mu.Unlock()
		},
	})
	t.Cleanup(tm.Close)
	return tm
}

func (tm *testMesh) fp() string { return tm.id.Fingerprint }

func (tm *testMesh) hello(fp string) (Hello, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	h, ok := tm.hellos[fp]
	return h, ok
}

func (tm *testMesh) sentCount(fp string) int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.sent[fp]
}

func (tm *testMesh) invites() []Invite {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return append([]Invite{}, tm.inv...)
}

// connect 는 a(건 쪽)와 b 를 메모리 연결로 잇는다. 돌려준 함수가 끊는다.
func connect(a, b *testMesh) func() {
	p1, p2 := net.Pipe()
	a.Attach(b.fp(), p1, true)
	b.Attach(a.fp(), p2, false)
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

func online(m *testMesh, fp string) bool {
	for _, n := range m.Nodes() {
		if n.FP == fp {
			return n.Online
		}
	}
	return false
}

func nameOf(m *testMesh, fp string) string {
	for _, n := range m.Nodes() {
		if n.FP == fp {
			return n.Name
		}
	}
	return ""
}

// TC-EGM-1 (FR-EGM-10·12): A-B-C 에서 A 는 간선이 아닌 C 를 온라인으로 안다. B-C 가 끊기면
// C 는 연결 끊김이 되고 이름은 남는다.
func TestNeighborOnlineFollowsLinks(t *testing.T) {
	a, b, c := newTestMesh(t, "a"), newTestMesh(t, "b"), newTestMesh(t, "c")
	connect(a, b)
	cut := connect(b, c)
	eventually(t, "A 가 C 를 온라인으로 안다", func() bool { return online(a, c.fp()) })
	if nameOf(a, c.fp()) != "c" {
		t.Fatalf("이름 = %q", nameOf(a, c.fp()))
	}
	if !a.Mutual(b.fp(), c.fp()) || a.Mutual(a.fp(), c.fp()) {
		t.Fatal("서로 이어짐 판정이 틀렸다")
	}
	v := a.View()
	if len(v.Links) != 2 {
		t.Fatalf("links = %v, want 2 쌍", v.Links)
	}
	cut()
	eventually(t, "C 가 연결 끊김이 된다", func() bool { return !online(a, c.fp()) })
	if nameOf(a, c.fp()) != "c" {
		t.Fatal("끊긴 노드도 목록에 남는다")
	}
}

// FR-EGM-10: 이름을 바꾸고 알리면 망 이웃이 새 이름을 본다.
func TestAnnounceSpreadsName(t *testing.T) {
	a, b, c := newTestMesh(t, "a"), newTestMesh(t, "b"), newTestMesh(t, "c")
	connect(a, b)
	connect(b, c)
	eventually(t, "C 를 안다", func() bool { return online(a, c.fp()) })
	c.mu.Lock()
	c.name = "c2"
	c.mu.Unlock()
	c.Announce()
	eventually(t, "새 이름이 퍼진다", func() bool { return nameOf(a, c.fp()) == "c2" })
}

// fakePeer 는 손으로 프레임을 쓰는 상대다.
type fakePeer struct {
	id   edge.Identity
	conn net.Conn
	r    *bufio.Scanner
	seq  uint64
}

func newFakePeer(t *testing.T, target *testMesh, read bool) *fakePeer {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p1, p2 := net.Pipe()
	f := &fakePeer{id: id, conn: p2}
	if read {
		f.r = bufio.NewScanner(p2)
		f.r.Buffer(make([]byte, 0, 64<<10), maxLine)
	} else {
		go func() {
			buf := make([]byte, 64<<10)
			for {
				if _, err := p2.Read(buf); err != nil {
					return
				}
			}
		}()
	}
	target.Attach(id.Fingerprint, p1, false)
	t.Cleanup(func() { _ = p2.Close() })
	return f
}

func (f *fakePeer) write(t *testing.T, fr Frame) {
	t.Helper()
	if _, err := f.conn.Write(Encode(fr)); err != nil {
		t.Fatal(err)
	}
}

func (f *fakePeer) next(t *testing.T) Frame {
	t.Helper()
	_ = f.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for f.r.Scan() {
		var fr Frame
		if err := json.Unmarshal(f.r.Bytes(), &fr); err != nil {
			t.Fatal(err)
		}
		if fr.T == FramePing {
			continue
		}
		return fr
	}
	t.Fatalf("읽기: %v", f.r.Err())
	return Frame{}
}

// nextNot 은 skip 종류를 건너뛴 다음 줄이다. 위층이 연결을 열면 간선 계층이 새 net 을 낸다 (FR-EGM-6).
func (f *fakePeer) nextNot(t *testing.T, skip string) Frame {
	t.Helper()
	for {
		if fr := f.next(t); fr.T != skip {
			return fr
		}
	}
}

func (f *fakePeer) net(t *testing.T, name string, links []string) Frame {
	t.Helper()
	f.seq++
	fr, err := SignFrame(f.id, FrameNet, netBody{Node: f.id.Fingerprint, Key: PublicKey(f.id), Name: name, Epoch: 1, Seq: f.seq, Links: links})
	if err != nil {
		t.Fatal(err)
	}
	return fr
}

// TC-EGM-2 (FR-EGM-11): 서명을 바꾼 net, 남의 키를 단 net, 옛 번호의 net 은 버린다.
func TestNetValidation(t *testing.T) {
	a := newTestMesh(t, "a")
	f := newFakePeer(t, a, false)
	good := f.net(t, "fake", []string{a.fp()})
	bad := good
	bad.B = json.RawMessage(string(good.B[:len(good.B)-1]) + ` ,"x":1}`)
	f.write(t, bad)
	never(t, "바꾼 net 을 받는다", func() bool { return nameOf(a, f.id.Fingerprint) != "" })

	other, _ := edge.LoadOrCreateIdentity(t.TempDir())
	forged, _ := SignFrame(other, FrameNet, netBody{Node: f.id.Fingerprint, Key: PublicKey(other), Name: "forged", Epoch: 1, Seq: 9})
	f.write(t, forged)
	never(t, "남의 키를 단 net 을 받는다", func() bool { return nameOf(a, f.id.Fingerprint) != "" })

	f.write(t, good)
	eventually(t, "바른 net 을 받는다", func() bool { return nameOf(a, f.id.Fingerprint) == "fake" })
	if !online(a, f.id.Fingerprint) {
		t.Fatal("서로 이어진 가짜 상대는 온라인이다")
	}
	old := good
	newer := f.net(t, "newer", []string{a.fp()})
	f.write(t, newer)
	eventually(t, "새 net", func() bool { return nameOf(a, f.id.Fingerprint) == "newer" })
	f.write(t, old)
	never(t, "옛 net 이 덮는다", func() bool { return nameOf(a, f.id.Fingerprint) == "fake" })
}

// TC-EGM-3 (FR-EGM-13): 아는 노드 상한을 넘으면 닿지 않는 오래된 노드부터 잊고, 잊은 노드의
// 옛 net 은 다시 받지 않는다.
func TestKnownNodesCapped(t *testing.T) {
	a := newTestMesh(t, "a")
	a.Mesh.mu.Lock()
	a.maxNodes = 2
	a.Mesh.mu.Unlock()
	f := newFakePeer(t, a, false)
	var frames []Frame
	var ids []edge.Identity
	for i := range 3 {
		id, _ := edge.LoadOrCreateIdentity(t.TempDir())
		ids = append(ids, id)
		fr, _ := SignFrame(id, FrameNet, netBody{Node: id.Fingerprint, Key: PublicKey(id), Name: "n", Epoch: 1, Seq: 1})
		frames = append(frames, fr)
		f.write(t, fr)
		if i < 2 {
			fp := id.Fingerprint
			eventually(t, "받는다", func() bool { return nameOf(a, fp) == "n" })
		}
	}
	eventually(t, "셋째를 받는다", func() bool { return nameOf(a, ids[2].Fingerprint) == "n" })
	if nameOf(a, ids[0].Fingerprint) != "" {
		t.Fatal("가장 오래된 노드를 잊어야 한다")
	}
	f.write(t, frames[0])
	never(t, "잊은 노드의 옛 net 을 다시 받는다", func() bool { return nameOf(a, ids[0].Fingerprint) != "" })
}

type fakeUpper struct {
	m      *Mesh
	mu     sync.Mutex
	frames []Frame
	from   []string
	first  [][]byte
	pokes  int
}

func (u *fakeUpper) Frame(from string, fr Frame) {
	u.mu.Lock()
	u.frames = append(u.frames, fr)
	u.from = append(u.from, from)
	u.mu.Unlock()
}

func (u *fakeUpper) Linked(fp string) { u.m.Open(fp, u.first) }

func (u *fakeUpper) Changed() {
	u.mu.Lock()
	u.pokes++
	u.mu.Unlock()
}

func (u *fakeUpper) got() []Frame {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]Frame{}, u.frames...)
}

// TC-EGM-4 (FR-EGM-4·5·6): 새 연결의 첫 줄은 hello → net → 위층의 첫 줄 순서다. 모르는 종류는
// 위층에 가고, 간선 계층의 종류는 가지 않는다.
func TestUpperFramesAndFirstLines(t *testing.T) {
	a := newTestMesh(t, "a")
	up := &fakeUpper{m: a.Mesh, first: [][]byte{Encode(Frame{T: "state", B: json.RawMessage(`{"x":1}`)})}}
	a.SetUpper(up)
	f := newFakePeer(t, a, true)
	if fr := f.next(t); fr.T != FrameHello {
		t.Fatalf("첫 줄 = %q, want hello", fr.T)
	}
	if fr := f.next(t); fr.T != FrameNet {
		t.Fatalf("둘째 줄 = %q, want net", fr.T)
	}
	if fr := f.next(t); fr.T != "state" {
		t.Fatalf("셋째 줄 = %q, want 위층의 state", fr.T)
	}
	f.write(t, Frame{T: "msg", B: json.RawMessage(`{"y":2}`)})
	f.write(t, f.net(t, "fake", []string{a.fp()}))
	eventually(t, "위층이 msg 를 받는다", func() bool { return len(up.got()) == 1 })
	if got := up.got()[0]; got.T != "msg" {
		t.Fatalf("위층이 받은 것 = %q", got.T)
	}
	never(t, "net 이 위층에 간다", func() bool { return len(up.got()) > 1 })
	up.mu.Lock()
	from := up.from[0]
	up.mu.Unlock()
	if from != f.id.Fingerprint {
		t.Fatal("위층은 받은 연결의 상대를 안다")
	}
	a.Broadcast(Frame{T: "msg", B: json.RawMessage(`{"z":3}`)}, "")
	if fr := f.nextNot(t, FrameNet); fr.T != "msg" {
		t.Fatalf("Broadcast 가 닿지 않았다: %q", fr.T)
	}
}

// FR-EGM-6: 위층이 첫 줄을 넣기 전의 연결은 위층의 Broadcast 가 건너뛴다.
func TestBroadcastSkipsUnopened(t *testing.T) {
	a := newTestMesh(t, "a")
	gate := make(chan struct{})
	up := &blockingUpper{m: a.Mesh, gate: gate}
	a.SetUpper(up)
	f := newFakePeer(t, a, true)
	eventually(t, "Linked 가 불린다", func() bool { return up.called() })
	openLinks := func() []string { a.Mesh.mu.Lock(); defer a.Mesh.mu.Unlock(); return a.openLinksLocked() }
	if len(openLinks()) != 0 {
		t.Fatal("열기 전의 연결이 망 정보에 들어갔다 — 온라인으로 보이면 글이 사라진다")
	}
	a.Broadcast(Frame{T: "msg"}, "")
	close(gate)
	eventually(t, "열면 망 정보에 든다", func() bool { return len(openLinks()) == 1 })
	for _, want := range []string{FrameHello, FrameNet, "state"} {
		if fr := f.next(t); fr.T != want {
			t.Fatalf("줄 = %q, want %q", fr.T, want)
		}
	}
	a.Broadcast(Frame{T: "msg"}, "")
	if fr := f.nextNot(t, FrameNet); fr.T != "msg" {
		t.Fatalf("열린 뒤의 Broadcast = %q", fr.T)
	}
}

type blockingUpper struct {
	m    *Mesh
	gate chan struct{}
	mu   sync.Mutex
	in   bool
}

func (u *blockingUpper) Frame(string, Frame) {}
func (u *blockingUpper) Changed()            {}
func (u *blockingUpper) Linked(fp string) {
	u.mu.Lock()
	u.in = true
	u.mu.Unlock()
	<-u.gate
	u.m.Open(fp, [][]byte{Encode(Frame{T: "state"})})
}
func (u *blockingUpper) called() bool { u.mu.Lock(); defer u.mu.Unlock(); return u.in }

// TC-EGM-5 (FR-EGM-20): 연결이 열리면 양쪽이 hello 를 주고받고, 다 쓴 것을 알린다.
func TestHelloOnConnect(t *testing.T) {
	a, b := newTestMesh(t, "a"), newTestMesh(t, "b")
	connect(a, b)
	eventually(t, "A 가 B 의 hello 를 받는다", func() bool { h, ok := a.hello(b.fp()); return ok && h.Name == "b" })
	eventually(t, "B 가 A 의 hello 를 받는다", func() bool { h, ok := b.hello(a.fp()); return ok && h.Name == "a" })
	eventually(t, "보낸 것을 안다", func() bool { return a.sentCount(b.fp()) == 1 })
}

// TC-EGM-6 (FR-EGM-23): HelloAll 은 열린 연결마다 한 번 보내고, 다 쓸 때까지 기다린다.
func TestHelloAll(t *testing.T) {
	a, b, c := newTestMesh(t, "a"), newTestMesh(t, "b"), newTestMesh(t, "c")
	connect(a, b)
	connect(a, c)
	eventually(t, "연결", func() bool { return a.sentCount(b.fp()) == 1 && a.sentCount(c.fp()) == 1 })
	a.HelloAll(Hello{Name: "a2", Addr: "10.0.0.1", Port: 7001}, time.Second)
	if a.sentCount(b.fp()) != 2 || a.sentCount(c.fp()) != 2 {
		t.Fatal("HelloAll 은 돌아오기 전에 다 쓴다")
	}
	eventually(t, "B 가 새 hello 를 받는다", func() bool { h, _ := b.hello(a.fp()); return h.Port == 7001 && h.Addr == "10.0.0.1" })
}

// TC-EGM-7·8 (FR-EGM-7·26): 연결이 없을 때 Notify 는 바로 건다. 주소를 모르면 ErrAddrUnknown,
// 상대가 404 면 옛 판으로 표시하고 ErrOutdated 다.
func TestNotifyDialsNow(t *testing.T) {
	a, b := newTestMesh(t, "a"), newTestMesh(t, "b")
	a.mu.Lock()
	a.edges = []edge.Edge{{Fingerprint: b.fp(), Name: "b"}}
	a.mu.Unlock()
	if err := a.Notify(context.Background(), b.fp()); !errors.Is(err, ErrAddrUnknown) {
		t.Fatalf("주소 없음 = %v", err)
	}
	a.mu.Lock()
	a.edges = []edge.Edge{{Fingerprint: b.fp(), Name: "b", Addr: "127.0.0.1", Port: 1}}
	a.mu.Unlock()
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		return nil, &edge.RemoteError{Status: http.StatusNotFound, Code: "not_found"}
	}
	if err := a.Notify(context.Background(), b.fp()); !errors.Is(err, ErrOutdated) {
		t.Fatalf("옛 판 = %v", err)
	}
	if !a.Outdated(b.fp()) {
		t.Fatal("옛 판 표시")
	}
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		return nil, errors.New("refused")
	}
	if err := a.Notify(context.Background(), b.fp()); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("닿지 않음 = %v", err)
	}
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		p1, p2 := net.Pipe()
		b.Attach(a.fp(), p2, false)
		return p1, nil
	}
	if err := a.Notify(context.Background(), b.fp()); err != nil {
		t.Fatalf("성공 = %v", err)
	}
	if a.Outdated(b.fp()) {
		t.Fatal("연결되면 옛 판 표시를 지운다")
	}
	if !a.Linked(b.fp()) {
		t.Fatal("연결이 남는다")
	}
	if err := a.Notify(context.Background(), b.fp()); err != nil {
		t.Fatalf("열린 연결로 알리기 = %v", err)
	}
	if a.sentCount(b.fp()) < 2 {
		t.Fatal("열린 연결로 다시 보냈다")
	}
}

// TC-EGM-10 (FR-EGM-32~36): A-B-C 에서 A 가 C 에 초대를 보낸다. C 만 열고, B 는 넘기기만 한다.
func TestInviteReachesOnlyTarget(t *testing.T) {
	a, b, c := newTestMesh(t, "a"), newTestMesh(t, "b"), newTestMesh(t, "c")
	connect(a, b)
	connect(b, c)
	eventually(t, "A 가 C 를 안다", func() bool { return online(a, c.fp()) })
	code := edge.EncodeInvite(edge.InviteCode{Addr: "10.0.0.1", Port: 7001, Fingerprint: a.fp(), Token: "tok"})
	exp := time.Now().Add(edge.InviteTTL)
	if err := a.SendInvite(c.fp(), code, exp); err != nil {
		t.Fatal(err)
	}
	eventually(t, "C 가 초대를 받는다", func() bool { return len(c.invites()) == 1 })
	got := c.invites()[0]
	if got.From != a.fp() || got.Code != code || got.Name != "a" {
		t.Fatalf("받은 초대 = %+v", got)
	}
	never(t, "B 가 초대를 연다", func() bool { return len(b.invites()) > 0 })
	if err := a.SendInvite("ff", code, exp); !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("모르는 노드 = %v", err)
	}
}

// TC-ATF-51 (FR-ATF-51): 초대 기억이 만료 전 항목으로 가득 차면 새 초대를 보내지도 받지도 않는다.
// 만료된 항목이 하나라도 있으면 그 자리를 쓴다.
func TestInviteMemoryFullRejects(t *testing.T) {
	a, c := newTestMesh(t, "a"), newTestMesh(t, "c")
	connect(a, c)
	eventually(t, "A 가 C 를 안다", func() bool { return online(a, c.fp()) })
	fill := func(m *testMesh, exp time.Time) {
		m.Mesh.mu.Lock()
		defer m.Mesh.mu.Unlock()
		for i := len(m.seen); i < maxSeenInvites; i++ {
			m.seen[randomHex(inviteIDBytes)] = exp
		}
	}
	code := edge.EncodeInvite(edge.InviteCode{Addr: "10.0.0.1", Port: 7001, Fingerprint: a.fp(), Token: "tok"})
	exp := time.Now().Add(edge.InviteTTL)
	fill(a, exp)
	if err := a.SendInvite(c.fp(), code, exp); !errors.Is(err, ErrInviteFull) {
		t.Fatalf("가득 찬 기억으로 보내기 = %v", err)
	}
	a.Mesh.mu.Lock()
	clear(a.seen)
	a.Mesh.mu.Unlock()
	fill(c, exp)
	if err := a.SendInvite(c.fp(), code, exp); err != nil {
		t.Fatal(err)
	}
	never(t, "가득 찬 C 가 초대를 받는다", func() bool { return len(c.invites()) > 0 })
	c.Mesh.mu.Lock()
	for k := range c.seen {
		c.seen[k] = time.Now().Add(-time.Second)
		break
	}
	c.Mesh.mu.Unlock()
	if err := a.SendInvite(c.fp(), code, exp); err != nil {
		t.Fatal(err)
	}
	eventually(t, "만료된 자리로 받는다", func() bool { return len(c.invites()) == 1 })
}

// FR-EGM-32: 상자는 받을 노드만 연다.
func TestInviteBoxOnlyForRecipient(t *testing.T) {
	a, b, c := newTestMesh(t, "a"), newTestMesh(t, "b"), newTestMesh(t, "c")
	box, err := seal(a.id, PublicKeyOf(t, c), "id1", a.fp(), c.fp(), []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := open(c.id, PublicKeyOf(t, a), "id1", a.fp(), c.fp(), box); !ok || string(got) != "secret" {
		t.Fatal("받는 노드는 연다")
	}
	if _, ok := open(b.id, PublicKeyOf(t, a), "id1", a.fp(), c.fp(), box); ok {
		t.Fatal("다른 노드는 열지 못한다")
	}
	if _, ok := open(c.id, PublicKeyOf(t, a), "id2", a.fp(), c.fp(), box); ok {
		t.Fatal("id 를 바꾸면 열리지 않는다")
	}
}

// PublicKeyOf 는 시험 노드의 공개키다.
func PublicKeyOf(t *testing.T, m *testMesh) string {
	t.Helper()
	return PublicKey(m.id)
}

// FR-EGM-33·34: 서명을 바꾼 초대, 만료된 초대, 같은 id 의 초대, 코드의 지문이 보낸 노드가 아닌
// 초대는 받지 않는다.
func TestInviteValidation(t *testing.T) {
	c := newTestMesh(t, "c")
	f := newFakePeer(t, c, false)
	f.write(t, f.net(t, "fake", []string{c.fp()}))
	eventually(t, "가짜를 안다", func() bool { return online(c, f.id.Fingerprint) })
	mk := func(id string, at, exp time.Time, codeFP string) Frame {
		code := edge.EncodeInvite(edge.InviteCode{Addr: "10.0.0.1", Port: 7001, Fingerprint: codeFP, Token: "t"})
		box, err := seal(f.id, PublicKey(c.id), id, f.id.Fingerprint, c.fp(), []byte(code))
		if err != nil {
			t.Fatal(err)
		}
		fr, err := SignFrame(f.id, FrameInvite, inviteBody{ID: id, From: f.id.Fingerprint, To: c.fp(), At: at.UnixMilli(), Exp: exp.UnixMilli(), Box: box})
		if err != nil {
			t.Fatal(err)
		}
		return fr
	}
	now := time.Now()
	f.write(t, mk("00000000000000000000000000000001", now.Add(-time.Hour), now.Add(-time.Minute), f.id.Fingerprint))
	f.write(t, mk("00000000000000000000000000000002", now, now.Add(time.Hour), f.id.Fingerprint))
	f.write(t, mk("00000000000000000000000000000003", now, now.Add(time.Minute), c.fp()))
	tampered := mk("00000000000000000000000000000004", now, now.Add(time.Minute), f.id.Fingerprint)
	tampered.S = mk("00000000000000000000000000000005", now, now.Add(time.Minute), f.id.Fingerprint).S
	f.write(t, tampered)
	never(t, "틀린 초대를 받는다", func() bool { return len(c.invites()) > 0 })
	good := mk("00000000000000000000000000000006", now, now.Add(time.Minute), f.id.Fingerprint)
	f.write(t, good)
	eventually(t, "바른 초대", func() bool { return len(c.invites()) == 1 })
	f.write(t, good)
	never(t, "같은 초대를 두 번 받는다", func() bool { return len(c.invites()) > 1 })
}

// FR-EGM-3: 지운 간선의 연결은 Drop 으로 바로 닫힌다.
func TestDropClosesLink(t *testing.T) {
	a, b := newTestMesh(t, "a"), newTestMesh(t, "b")
	connect(a, b)
	eventually(t, "연결", func() bool { return a.Linked(b.fp()) })
	a.Drop(b.fp())
	if a.Linked(b.fp()) {
		t.Fatal("Drop 뒤에도 연결이 있다")
	}
	eventually(t, "상대도 끊긴다", func() bool { return !b.Linked(a.fp()) })
}

// FR-EGM-3: 같은 상대와의 연결이 둘이면 하나만 남는다.
func TestDuplicateLinksCollapse(t *testing.T) {
	a, b := newTestMesh(t, "a"), newTestMesh(t, "b")
	connect(a, b)
	connect(b, a)
	eventually(t, "하나만 남는다", func() bool { return a.linkCount() == 1 && b.linkCount() == 1 })
	eventually(t, "서로 온라인", func() bool { return online(a, b.fp()) && online(b, a.fp()) })
}

// FR-EGM-3: 조용한 연결은 끊는다.
func TestSilentLinkDropped(t *testing.T) {
	a := newTestMesh(t, "a")
	a.Mesh.mu.Lock()
	a.deadAfter = 50 * time.Millisecond
	a.Mesh.mu.Unlock()
	f := newFakePeer(t, a, false)
	eventually(t, "연결", func() bool { return a.Linked(f.id.Fingerprint) })
	time.Sleep(80 * time.Millisecond)
	a.pingAll(time.Now())
	if a.Linked(f.id.Fingerprint) {
		t.Fatal("조용한 연결이 남았다")
	}
}

// NFR-EGM-2: 프레임 한 줄의 상한을 넘으면 연결을 끊는다.
func TestOversizedLineDropsLink(t *testing.T) {
	a := newTestMesh(t, "a")
	f := newFakePeer(t, a, false)
	eventually(t, "연결", func() bool { return a.Linked(f.id.Fingerprint) })
	go func() { _, _ = f.conn.Write([]byte(strings.Repeat("x", maxLine+1) + "\n")) }()
	eventually(t, "끊긴다", func() bool { return !a.Linked(f.id.Fingerprint) })
}

// FR-EGM-3: 다시 걸 때 상대가 edge_not_edge 로 답하면 간선을 지우라고 알린다. 다른 실패는 간선을
// 그대로 둔다. 주소를 모르는 간선에는 걸지 않는다.
func TestRedialOutcomes(t *testing.T) {
	peer := edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("ab", 32)}
	for _, tc := range []struct {
		err    error
		forget bool
	}{
		{&edge.RemoteError{Status: 403, Code: edge.CodeNotEdge}, true},
		{edge.ErrUnreachable, false},
		{edge.ErrRejected, false},
		{&edge.RemoteError{Status: 404, Code: "not_found"}, false},
		{errors.New("boom"), false},
	} {
		a := newTestMesh(t, "a")
		a.mu.Lock()
		a.edges = []edge.Edge{peer}
		a.mu.Unlock()
		var gone atomic.Int64
		var dials atomic.Int64
		a.opts.OnNotEdge = func(string) { gone.Add(1) }
		a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) { dials.Add(1); return nil, tc.err }
		a.dialEdges(context.Background(), time.Now())
		eventually(t, "다시 걸기가 끝난다", func() bool {
			a.Mesh.mu.Lock()
			defer a.Mesh.mu.Unlock()
			d := a.dialing[peer.Fingerprint]
			return dials.Load() == 1 && d != nil && !d.running
		})
		if (gone.Load() == 1) != tc.forget {
			t.Fatalf("%v: 지우기 알림 = %d", tc.err, gone.Load())
		}
	}
	a := newTestMesh(t, "a")
	bare := peer
	bare.Addr, bare.Port = "", 0
	a.mu.Lock()
	a.edges = []edge.Edge{bare}
	a.mu.Unlock()
	var dials atomic.Int64
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) { dials.Add(1); return nil, errors.New("x") }
	a.dialEdges(context.Background(), time.Now())
	if dials.Load() != 0 {
		t.Fatal("주소 없는 간선에 걸었다")
	}
}

// TC-ATF-50 (FR-ATF-50): Notify 의 걸기와 자동 재연결은 같은 dialState 를 거쳐 겹치지 않는다.
func TestNotifySharesDialState(t *testing.T) {
	for _, notifyFirst := range []bool{true, false} {
		a := newTestMesh(t, "a")
		peer := edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("cd", 32)}
		a.mu.Lock()
		a.edges = []edge.Edge{peer}
		a.mu.Unlock()
		var dials atomic.Int64
		release := make(chan struct{})
		a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
			dials.Add(1)
			<-release
			return nil, errors.New("refused")
		}
		notified := make(chan error, 1)
		notify := func() { go func() { notified <- a.Notify(context.Background(), peer.Fingerprint) }() }
		if notifyFirst {
			notify()
			eventually(t, "Notify 가 건다", func() bool { return dials.Load() == 1 })
			a.dialEdges(context.Background(), time.Now())
		} else {
			a.dialEdges(context.Background(), time.Now())
			eventually(t, "다시 걸기가 건다", func() bool { return dials.Load() == 1 })
			notify()
		}
		never(t, "두 번째 걸기", func() bool { return dials.Load() > 1 })
		close(release)
		if err := <-notified; !errors.Is(err, ErrUnreachable) {
			t.Fatalf("notifyFirst=%v: Notify = %v", notifyFirst, err)
		}
		if dials.Load() != 1 {
			t.Fatalf("notifyFirst=%v: 걸기 %d 번", notifyFirst, dials.Load())
		}
	}
}
