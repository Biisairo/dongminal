package edgemesh

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/termtext"
)

const (
	// Path 는 간선 연결의 노드 포트 경로, Proto 는 그 Upgrade 프로토콜 이름이다 (FR-EGM-2).
	Path  = "/edge/v1/link"
	Proto = "dmlink1"
	// maxLine 은 프레임 한 줄의 상한, outQueue 는 연결 하나의 보낼 줄 상한이다 (NFR-EGM-2).
	maxLine  = 1 << 20
	outQueue = 1024
	// 다시 걸기 간격의 처음과 끝이다 (FR-EGM-3).
	redialMin = time.Second
	redialMax = 60 * time.Second
	// HelloWait 는 hello 를 다 쓰기까지 간선 하나를 기다리는 상한이다 (FR-EGM-23). 노드가
	// 바뀐 직접 정보를 모든 간선에 알릴 때도 이 값을 쓴다.
	HelloWait = 2 * time.Second
)

var pingLine = []byte(`{"t":"ping"}` + "\n")

// 간선 계층의 오류다. 노드가 오류 코드로 옮긴다 (FR-EGM-26·60).
var (
	ErrAddrUnknown = errors.New("상대 주소를 모른다")
	ErrOutdated    = errors.New("상대가 간선 연결을 모르는 옛 판이다")
	ErrUnreachable = errors.New("상대에 닿지 못했다")
	ErrNotEdge     = errors.New("간선이 아니다")
	ErrUnknownNode = errors.New("모르는 노드다")
)

// Hello 는 직접 정보다 (FR-EGM-20). Port 가 0 이면 주소를 싣지 않은 것이다.
type Hello struct {
	Name string `json:"name"`
	Addr string `json:"addr,omitempty"`
	Port int    `json:"port,omitempty"`
}

// Upper 는 간선 연결 위에 얹힌 계층이다 (FR-EGM-5). 간선 계층은 자기 잠금 밖에서만 부른다.
type Upper interface {
	// Frame 은 간선 계층이 모르는 종류의 프레임이다. from 은 받은 연결의 상대다.
	Frame(from string, fr Frame)
	// Linked 는 새 연결이다. 위층은 그 연결로 처음 보낼 줄을 Open 으로 넣어야 한다.
	Linked(fp string)
	// Changed 는 망 그림(연결·온라인·이름)이 바뀌었을 수 있다는 알림이다.
	Changed()
}

// Options 는 간선 계층을 세우는 값이다.
type Options struct {
	Identity edge.Identity
	// Name 은 이 노드의 지금 이름이다.
	Name func() string
	// Hello 는 연결이 열릴 때 보낼 직접 정보다. nil 이면 이름만 싣는다.
	Hello func() Hello
	// Edges 는 지금의 간선이다. 주소를 아는 간선마다 연결을 건다.
	Edges func() []edge.Edge
	// Dial 은 간선 상대에게 간선 연결을 연다. nil 이면 걸지 않는다.
	Dial func(ctx context.Context, t edge.Target) (net.Conn, error)
	// OnHello 는 상대의 hello 다. remoteHost 는 그 연결의 출발지 IP 다(모르면 빈 값).
	OnHello func(fp string, h Hello, remoteHost string)
	// OnHelloSent 는 상대에게 hello 를 다 썼다는 알림이다.
	OnHelloSent func(fp string)
	// OnInvite 는 이 노드에게 온, 열린 간선 초대다.
	OnInvite func(Invite)
	// OnNotEdge 는 상대가 이 노드를 간선이 아니라고(edge_not_edge) 답했다는 알림이다.
	OnNotEdge func(fp string)
	// OnChanged 는 망 그림이나 옛 판 표시가 바뀌었다는 알림이다. 여러 번을 한 번으로 묶는다.
	OnChanged func()
	Now       func() time.Time
}

type outItem struct {
	line []byte
	sent func()
}

// link 는 간선 상대 하나와의 간선 연결이다.
type link struct {
	fp string
	// dialer 는 이 연결을 건 노드의 지문이다. 중복 연결 정리에 쓴다.
	dialer string
	remote string
	conn   net.Conn
	out    chan outItem
	done   chan struct{}
	once   sync.Once
	// helloDone 은 연결이 열릴 때 보낸 hello 를 다 쓰면 닫힌다.
	helloDone chan struct{}
	lastSeen  atomic.Int64
	// open 은 위층이 첫 줄을 넣었는가다 (FR-EGM-6). m.mu 가 지킨다.
	open bool
}

func (l *link) close() {
	l.once.Do(func() {
		close(l.done)
		_ = l.conn.Close()
	})
}

// send 는 줄 하나를 보낼 줄에 넣는다. 가득 차면 연결을 끊는다.
func (l *link) send(it outItem) {
	select {
	case l.out <- it:
	case <-l.done:
	default:
		l.close()
	}
}

func (l *link) writeLoop() {
	for {
		select {
		case <-l.done:
			return
		case it := <-l.out:
			if _, err := l.conn.Write(it.line); err != nil {
				l.close()
				return
			}
			if it.sent != nil {
				it.sent()
			}
		}
	}
}

// dialState 는 간선 하나의 걸기 상태다. 자동 재연결과 Notify 가 함께 쓴다 (FR-ATF-50).
type dialState struct {
	next    time.Time
	wait    time.Duration
	running bool
	// done 은 지금 걸기가 끝나면 닫힌다. err 는 마지막 걸기의 결과다. m.mu 가 지킨다.
	done chan struct{}
	err  error
}

// Mesh 는 이 노드의 간선 계층이다.
type Mesh struct {
	id    edge.Identity
	key   string
	opts  Options
	now   func() time.Time
	pokes chan struct{}
	done  chan struct{}

	pingEvery time.Duration
	deadAfter time.Duration
	maxNodes  int

	mu       sync.Mutex
	upper    Upper
	links    map[string]*link
	dialing  map[string]*dialState
	outdated map[string]bool
	closed   bool
	netState
	inviteState
}

// New 는 간선 계층을 세운다. 연결 유지는 Run 이 한다.
func New(o Options) *Mesh {
	if o.Now == nil {
		o.Now = time.Now
	}
	m := &Mesh{
		id: o.Identity, key: PublicKey(o.Identity), opts: o, now: o.Now,
		pokes: make(chan struct{}, 1), done: make(chan struct{}),
		pingEvery: 15 * time.Second, deadAfter: 45 * time.Second, maxNodes: maxNodes,
		links: map[string]*link{}, dialing: map[string]*dialState{}, outdated: map[string]bool{},
	}
	m.netState = newNetState(o.Now)
	m.inviteState = newInviteState()
	m.mu.Lock()
	m.announceLocked(nil)
	m.mu.Unlock()
	go m.notifyLoop()
	return m
}

// Node 는 이 노드의 지문이다.
func (m *Mesh) Node() string { return m.id.Fingerprint }

// SetUpper 는 위층을 싣는다. 실은 뒤에 열린 연결부터 위층의 첫 줄을 기다린다.
func (m *Mesh) SetUpper(u Upper) {
	m.mu.Lock()
	m.upper = u
	m.mu.Unlock()
}

func (m *Mesh) notifyLoop() {
	for {
		select {
		case <-m.done:
			return
		case <-m.pokes:
			m.mu.Lock()
			up := m.upper
			m.mu.Unlock()
			if up != nil {
				up.Changed()
			}
			if m.opts.OnChanged != nil {
				m.opts.OnChanged()
			}
		}
	}
}

func (m *Mesh) pokeLocked() {
	select {
	case m.pokes <- struct{}{}:
	default:
	}
}

func (m *Mesh) name() string {
	if m.opts.Name == nil {
		return ""
	}
	return m.opts.Name()
}

func (m *Mesh) hello() Hello {
	if m.opts.Hello == nil {
		return Hello{Name: m.name()}
	}
	return m.opts.Hello()
}

func helloLine(h Hello) []byte {
	raw, _ := json.Marshal(h)
	return Encode(Frame{T: FrameHello, B: raw})
}

// Close 는 모든 연결을 닫는다. 그 뒤에는 연결을 받지 않는다.
func (m *Mesh) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	close(m.done)
	links := make([]*link, 0, len(m.links))
	for _, l := range m.links {
		links = append(links, l)
	}
	m.links = map[string]*link{}
	m.mu.Unlock()
	for _, l := range links {
		l.close()
	}
}

// Handler 는 노드 포트의 간선 연결 경로다. 판정은 노드 포트가 이미 했다 — 간선만 닿는다.
func (m *Mesh) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, ok := edge.AcceptUpgrade(w, r, Proto)
		if !ok {
			return
		}
		m.Attach(edge.ClientFingerprint(r), conn, false)
	})
}

func remoteHost(c net.Conn) string {
	a := c.RemoteAddr()
	if a == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(a.String())
	if err != nil {
		return ""
	}
	return host
}

// Attach 는 상대 fp 와의 연결을 붙인다. 같은 상대와 이미 연결이 있으면 하나만 남긴다: 지문이
// 작은 쪽이 건 연결을 남기고, 같으면 새 연결을 남긴다 (FR-EGM-3). 새 연결에는 hello, 자기 net,
// 아는 노드들의 net 을 먼저 넣고 위층을 부른다 (FR-EGM-6).
func (m *Mesh) Attach(fp string, conn net.Conn, dialed bool) {
	l := &link{fp: fp, conn: conn, remote: remoteHost(conn), out: make(chan outItem, outQueue),
		done: make(chan struct{}), helloDone: make(chan struct{})}
	l.dialer = fp
	if dialed {
		l.dialer = m.id.Fingerprint
	}
	l.lastSeen.Store(m.now().UnixNano())
	h := m.hello()
	m.mu.Lock()
	if m.closed || fp == "" || fp == m.id.Fingerprint {
		m.mu.Unlock()
		_ = conn.Close()
		return
	}
	var replaced *link
	if old, ok := m.links[fp]; ok {
		if !m.preferNew(old, l) {
			m.mu.Unlock()
			_ = conn.Close()
			return
		}
		replaced = old
	}
	m.links[fp] = l
	delete(m.outdated, fp)
	up := m.upper
	l.open = up == nil
	go l.writeLoop()
	l.send(outItem{line: helloLine(h), sent: func() {
		close(l.helloDone)
		m.helloSent(fp)
	}})
	m.announceLocked(l)
	l.send(outItem{line: Encode(m.own)})
	for _, r := range m.nodes {
		l.send(outItem{line: Encode(r.raw)})
	}
	m.topologyLocked()
	m.mu.Unlock()
	if replaced != nil {
		replaced.close()
	}
	if up != nil {
		go up.Linked(fp)
	}
	go m.readLoop(l)
}

func (m *Mesh) preferNew(old, l *link) bool {
	lo := min(m.id.Fingerprint, l.fp)
	return old.dialer != lo || l.dialer == lo
}

func (m *Mesh) helloSent(fp string) {
	if m.opts.OnHelloSent != nil {
		m.opts.OnHelloSent(fp)
	}
}

// Open 은 위층이 연결 fp 로 처음 보낼 줄을 넣고, 그 연결을 위층의 Broadcast 에 연다
// (FR-EGM-6). 위층은 자기 잠금 안에서 불러, 그 사이에 다른 줄이 끼지 않게 한다.
func (m *Mesh) Open(fp string, lines [][]byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := m.links[fp]
	if l == nil || l.open {
		return
	}
	for _, line := range lines {
		l.send(outItem{line: line})
	}
	l.open = true
	m.announceLocked(nil)
	m.topologyLocked()
}

// Broadcast 는 위층의 프레임을 skip 을 뺀 모든 열린 연결로 보낸다.
func (m *Mesh) Broadcast(fr Frame, skip string) {
	line := Encode(fr)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.links {
		if l.fp != skip && l.open {
			l.send(outItem{line: line})
		}
	}
}

// Send 는 위층의 프레임을 연결 fp 하나로 보낸다. 열린 연결이 없으면 버린다.
func (m *Mesh) Send(fp string, fr Frame) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l := m.links[fp]; l != nil && l.open {
		l.send(outItem{line: Encode(fr)})
	}
}

// broadcastLocked 는 간선 계층의 줄을 skip 을 뺀 모든 연결로 보낸다. 위층이 열기 전의 연결도
// 받는다 — 간선 계층의 프레임은 위층의 순서와 무관하다.
func (m *Mesh) broadcastLocked(line []byte, skip *link) {
	for _, l := range m.links {
		if l != skip {
			l.send(outItem{line: line})
		}
	}
}

func (m *Mesh) detach(l *link) {
	l.close()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.links[l.fp] != l {
		return
	}
	delete(m.links, l.fp)
	if !m.closed {
		m.announceLocked(nil)
		m.topologyLocked()
	}
}

func (m *Mesh) readLoop(l *link) {
	defer m.detach(l)
	sc := bufio.NewScanner(l.conn)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	for sc.Scan() {
		l.lastSeen.Store(m.now().UnixNano())
		var fr Frame
		if json.Unmarshal(sc.Bytes(), &fr) != nil {
			return
		}
		m.handle(l, fr)
	}
}

func (m *Mesh) handle(from *link, fr Frame) {
	switch fr.T {
	case FramePing:
	case FrameHello:
		var h Hello
		if json.Unmarshal(fr.B, &h) != nil || m.opts.OnHello == nil {
			return
		}
		m.opts.OnHello(from.fp, h, from.remote)
	case FrameNet:
		m.mu.Lock()
		if m.acceptNetLocked(fr) {
			m.broadcastLocked(Encode(fr), from)
			m.topologyLocked()
		}
		m.mu.Unlock()
	case FrameInvite:
		m.mu.Lock()
		inv, ok := m.acceptInviteLocked(fr)
		if ok {
			m.broadcastLocked(Encode(fr), from)
		}
		m.mu.Unlock()
		if inv != nil && m.opts.OnInvite != nil {
			m.opts.OnInvite(*inv)
		}
	default:
		m.mu.Lock()
		up := m.upper
		m.mu.Unlock()
		if up != nil {
			up.Frame(from.fp, fr)
		}
	}
}

// Run 은 연결을 유지한다: 간선마다 연결을 걸고, ping 을 보내고, 조용한 연결과 지워진 간선의
// 연결을 끊는다 (FR-EGM-3). ctx 가 끝나거나 Close 하면 돌아온다.
func (m *Mesh) Run(ctx context.Context) {
	t := time.NewTicker(min(m.pingEvery, redialMin))
	defer t.Stop()
	lastPing := m.now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.done:
			return
		case <-t.C:
		}
		now := m.now()
		if now.Sub(lastPing) >= m.pingEvery {
			lastPing = now
			m.pingAll(now)
		}
		m.dialEdges(ctx, now)
	}
}

func (m *Mesh) pingAll(now time.Time) {
	m.mu.Lock()
	var dead []*link
	for _, l := range m.links {
		if now.Sub(time.Unix(0, l.lastSeen.Load())) > m.deadAfter {
			dead = append(dead, l)
			continue
		}
		l.send(outItem{line: pingLine})
	}
	m.mu.Unlock()
	for _, l := range dead {
		dmlog.Infof(nil, "edge link: %s 에서 %s 동안 받은 것이 없어 끊는다", termtext.Cut(l.fp, termtext.FPShort), m.deadAfter)
		m.detach(l)
	}
}

// Drop 은 간선 fp 의 연결을 바로 닫는다. 간선을 지운 뒤 부른다. 연결이 없으면 아무것도 하지 않는다.
func (m *Mesh) Drop(fp string) {
	m.mu.Lock()
	l := m.links[fp]
	delete(m.outdated, fp)
	m.mu.Unlock()
	if l != nil {
		m.detach(l)
	}
}

func (m *Mesh) edges() map[string]edge.Edge {
	out := map[string]edge.Edge{}
	if m.opts.Edges == nil {
		return out
	}
	for _, e := range m.opts.Edges() {
		out[e.Fingerprint] = e
	}
	return out
}

func (m *Mesh) dialEdges(ctx context.Context, now time.Time) {
	if m.opts.Edges == nil || m.opts.Dial == nil {
		return
	}
	paired := m.edges()
	m.mu.Lock()
	var stale []*link
	for fp, l := range m.links {
		if _, ok := paired[fp]; !ok {
			stale = append(stale, l)
		}
	}
	for fp := range m.dialing {
		if _, ok := paired[fp]; !ok {
			delete(m.dialing, fp)
		}
	}
	for fp, e := range paired {
		// 주소를 모르는 간선(상대의 노드 포트가 닫혀 있었음)에는 걸지 않는다 — 상대가 건다.
		if _, linked := m.links[fp]; linked || e.Addr == "" {
			continue
		}
		d := m.dialStateLocked(fp)
		if d.running || now.Before(d.next) {
			continue
		}
		d.startLocked()
		go m.redial(ctx, e, d)
	}
	m.mu.Unlock()
	for _, l := range stale {
		m.detach(l)
	}
}

func (m *Mesh) dialStateLocked(fp string) *dialState {
	d := m.dialing[fp]
	if d == nil {
		d = &dialState{wait: redialMin}
		m.dialing[fp] = d
	}
	return d
}

func (d *dialState) startLocked() {
	d.running = true
	d.done = make(chan struct{})
}

func (m *Mesh) redial(ctx context.Context, e edge.Edge, d *dialState) error {
	err := m.dial(ctx, e)
	m.mu.Lock()
	d.running = false
	d.err = err
	if err != nil {
		d.next = m.now().Add(d.wait)
		d.wait = min(d.wait*2, redialMax)
	} else {
		d.wait = redialMin
	}
	close(d.done)
	m.mu.Unlock()
	return err
}

// dial 은 간선 e 에 걸어 붙인다. 404 면 옛 판으로 표시하고(FR-EGM-7), edge_not_edge 면 간선을
// 지우라고 알린다.
func (m *Mesh) dial(ctx context.Context, e edge.Edge) error {
	conn, err := m.opts.Dial(ctx, edge.Target{Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint})
	if err == nil {
		m.Attach(e.Fingerprint, conn, true)
		return nil
	}
	var re *edge.RemoteError
	switch {
	case errors.As(err, &re) && re.Code == edge.CodeNotEdge:
		// 지문을 고정한 상대의 서버가 낸 답이라 믿는다 (EDGE_PAIRING_SRS D-EPR-3).
		dmlog.Infof(nil, "edge link: %s 가 이 노드를 간선으로 알지 않는다 — 간선을 지운다", termtext.Cut(e.Fingerprint, termtext.FPShort))
		if m.opts.OnNotEdge != nil {
			m.opts.OnNotEdge(e.Fingerprint)
		}
		return fmt.Errorf("%w: %w", ErrNotEdge, err)
	case errors.As(err, &re) && re.Status == http.StatusNotFound:
		m.MarkOutdated(e.Fingerprint)
		return ErrOutdated
	}
	return fmt.Errorf("%w: %w", ErrUnreachable, err)
}

// MarkOutdated 는 간선 fp 를 옛 판으로 표시한다 (FR-EGM-7). 연결이 맺어지면 지워진다.
func (m *Mesh) MarkOutdated(fp string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.outdated[fp] {
		return
	}
	m.outdated[fp] = true
	m.pokeLocked()
}

// Outdated 는 간선 fp 가 옛 판으로 표시되었는가다.
func (m *Mesh) Outdated(fp string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.outdated[fp]
}

// Linked 는 간선 fp 와의 연결이 열려 있는가다.
func (m *Mesh) Linked(fp string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.links[fp]
	return ok
}

func (m *Mesh) linkCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.links)
}

// HelloAll 은 열린 연결마다 h 를 한 번 보내고, 다 쓰거나 간선마다 wait 이 지날 때까지 기다린다
// (FR-EGM-23). 다시 시도하지 않는다.
func (m *Mesh) HelloAll(h Hello, wait time.Duration) {
	line := helloLine(h)
	m.mu.Lock()
	var waits []chan struct{}
	for fp, l := range m.links {
		done := make(chan struct{})
		waits = append(waits, done)
		l.send(outItem{line: line, sent: func() {
			close(done)
			m.helloSent(fp)
		}})
	}
	m.mu.Unlock()
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for _, done := range waits {
		select {
		case <-done:
		case <-deadline.C:
			return
		}
	}
}

// Notify 는 간선 fp 에게 지금 hello 를 보낸다 (FR-EGM-26). 연결이 열려 있으면 그 연결로 보내고,
// 없으면 다시 걸기 간격을 무시하고 바로 건다 — 연결이 열리면 hello 가 간다.
func (m *Mesh) Notify(ctx context.Context, fp string) error {
	m.mu.Lock()
	l := m.links[fp]
	if l != nil {
		done := make(chan struct{})
		l.send(outItem{line: helloLine(m.hello()), sent: func() {
			close(done)
			m.helloSent(fp)
		}})
		m.mu.Unlock()
		return waitDone(ctx, done)
	}
	m.mu.Unlock()
	e, ok := m.edges()[fp]
	switch {
	case !ok:
		return ErrNotEdge
	case e.Addr == "":
		return ErrAddrUnknown
	case m.opts.Dial == nil:
		return ErrUnreachable
	}
	// 걸고 있는 중이면 그 걸기를 기다린다 — 같은 간선에 두 번 걸지 않는다 (FR-ATF-50).
	m.mu.Lock()
	d := m.dialStateLocked(fp)
	if d.running {
		done := d.done
		m.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return ErrUnreachable
		}
		m.mu.Lock()
		err := d.err
		l = m.links[fp]
		m.mu.Unlock()
		if l == nil && err != nil {
			return err
		}
	} else {
		d.startLocked()
		m.mu.Unlock()
		if err := m.redial(ctx, e, d); err != nil {
			return err
		}
		m.mu.Lock()
		l = m.links[fp]
		m.mu.Unlock()
	}
	if l == nil {
		return ErrUnreachable
	}
	return waitDone(ctx, l.helloDone)
}

func waitDone(ctx context.Context, done <-chan struct{}) error {
	t := time.NewTimer(HelloWait)
	defer t.Stop()
	select {
	case <-done:
		return nil
	case <-t.C:
		return ErrUnreachable
	case <-ctx.Done():
		return ErrUnreachable
	}
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
