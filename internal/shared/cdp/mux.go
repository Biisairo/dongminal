// Package cdp 는 Chrome DevTools Protocol 을 pipe 위에서 말한다 (BROWSER_TAB_SRS
// FR-BRT-20·21·24).
//
// 표준 라이브러리만 쓴다 — `chromedp`·`cdproto` 를 들이지 않는다 (§1.1 제약). 쓰는
// 메서드만 호출부가 이름으로 부른다.
//
// ── 구조 ──
//
// pipe 하나에 **여러 클라이언트**가 탄다 — 브라우저 매니저 자신과 CDP 프록시로 붙은
// 외부 도구 N 개다. Chrome 이 보기에는 연결이 하나이므로, id 공간을 나누는 것은 이
// 패키지의 몫이다:
//
//	클라이언트 A {id:1} ─┐                ┌─ {id:1} → A
//	클라이언트 B {id:1} ─┼─ Mux {id:7,8} ─┼─ {id:1} → B
//	                     └── pipe(NUL) ───┘
//
// 이벤트는 받을 자격이 있는 클라이언트에게만 간다 — 세션 이벤트는 그 세션을 붙인
// 클라이언트에, 브라우저 수준 이벤트는 그 도메인을 부른 적 있는 클라이언트에.
package cdp

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
)

// ErrClosed 는 pipe 가 닫혀 더 보낼 수 없다는 뜻이다.
var ErrClosed = errors.New("cdp: 연결이 닫혔다")

// Message 는 CDP 와이어 메시지 하나다. 요청·응답·이벤트가 같은 모양을 나눠 쓴다.
type Message struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *Error          `json:"error,omitempty"`
}

// Error 는 CDP 오류 응답이다.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return "cdp: " + e.Message }

// Filter 는 클라이언트의 요청을 Chrome 에 보내기 전에 본다. 오류를 돌려주면 그
// 요청은 보내지지 않고 그 오류가 응답으로 간다 (FR-BRT-24).
type Filter func(c *Conn, m *Message) error

// Mux 는 pipe 하나를 여러 클라이언트에 나눠 준다.
type Mux struct {
	w   io.Writer
	wmu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]pendingReq // 전역 id → 원래 요청자
	conns   map[*Conn]struct{}
	// sessions 는 세션 id → 그 세션의 이벤트를 받을 클라이언트다.
	sessions map[string]map[*Conn]struct{}
	closed   bool
	onClose  func(error)
}

type pendingReq struct {
	c      *Conn
	origID int64
	method string
	params json.RawMessage
}

// NewMux 는 r·w 위의 다중화기를 만든다. 읽기는 Run 이 한다.
func NewMux(w io.Writer) *Mux {
	return &Mux{w: w, pending: map[int64]pendingReq{}, conns: map[*Conn]struct{}{},
		sessions: map[string]map[*Conn]struct{}{}}
}

// OnClose 는 pipe 가 끊겼을 때 한 번 불린다. Run 전에 건다.
func (m *Mux) OnClose(f func(error)) { m.onClose = f }

// Run 은 r 에서 NUL 로 끝나는 메시지를 읽어 나눠 준다. r 이 끝나면 돌아오고,
// 모든 클라이언트의 대기 중 요청이 ErrClosed 로 끝난다.
func (m *Mux) Run(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<16)
	var err error
	for {
		var raw []byte
		raw, err = br.ReadBytes(0)
		if err != nil {
			break
		}
		raw = raw[:len(raw)-1]
		var msg Message
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		m.dispatch(&msg)
	}
	m.shutdown(err)
}

func (m *Mux) shutdown(err error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	conns := make([]*Conn, 0, len(m.conns))
	for c := range m.conns {
		conns = append(conns, c)
	}
	m.pending = map[int64]pendingReq{}
	m.mu.Unlock()
	for _, c := range conns {
		c.fail()
	}
	if m.onClose != nil {
		m.onClose(err)
	}
}

// Closed 는 pipe 가 이미 끊겼는가다.
func (m *Mux) Closed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closed
}

func (m *Mux) dispatch(msg *Message) {
	if msg.ID != 0 {
		m.mu.Lock()
		p, ok := m.pending[msg.ID]
		delete(m.pending, msg.ID)
		if ok && msg.Error == nil {
			m.noteResponse(p, msg)
		}
		m.mu.Unlock()
		if ok {
			msg.ID = p.origID
			p.c.deliver(msg)
		}
		return
	}
	for _, c := range m.recipients(msg) {
		c.deliver(msg)
	}
}

// noteResponse 는 응답이 세션·컨텍스트의 주인을 바꾸는 경우를 적는다. m.mu 아래.
func (m *Mux) noteResponse(p pendingReq, msg *Message) {
	switch p.method {
	case "Target.attachToTarget", "Target.attachToBrowserTarget":
		var r struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(msg.Result, &r) == nil && r.SessionID != "" {
			m.addOwner(r.SessionID, p.c)
		}
	case "Target.createBrowserContext":
		var r struct {
			BrowserContextID string `json:"browserContextId"`
		}
		if json.Unmarshal(msg.Result, &r) == nil && r.BrowserContextID != "" {
			p.c.mu.Lock()
			p.c.contexts[r.BrowserContextID] = struct{}{}
			p.c.mu.Unlock()
		}
	case "Target.createTarget":
		if p.c.onCreated != nil {
			var r struct {
				TargetID string `json:"targetId"`
			}
			if json.Unmarshal(msg.Result, &r) == nil && r.TargetID != "" {
				go p.c.onCreated(r.TargetID, p.params)
			}
		}
	}
}

func (m *Mux) addOwner(session string, c *Conn) {
	set := m.sessions[session]
	if set == nil {
		set = map[*Conn]struct{}{}
		m.sessions[session] = set
	}
	set[c] = struct{}{}
}

// recipients 는 이벤트 하나를 받을 클라이언트다 (FR-BRT-21).
func (m *Mux) recipients(msg *Message) []*Conn {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*Conn
	if msg.SessionID != "" {
		for c := range m.sessions[msg.SessionID] {
			out = append(out, c)
		}
	} else {
		dom := domainOf(msg.Method)
		for c := range m.conns {
			c.mu.Lock()
			_, ok := c.domains[dom]
			c.mu.Unlock()
			if ok {
				out = append(out, c)
			}
		}
	}
	switch msg.Method {
	case "Target.attachedToTarget":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(msg.Params, &p) == nil && p.SessionID != "" {
			for _, c := range out {
				m.addOwner(p.SessionID, c)
			}
		}
	case "Target.detachedFromTarget":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(msg.Params, &p) == nil && p.SessionID != "" {
			// 떼어진 세션의 소식은 그 세션의 주인도 받는다 — 브라우저 수준으로 왔더라도.
			for c := range m.sessions[p.SessionID] {
				if !containsConn(out, c) {
					out = append(out, c)
				}
			}
			delete(m.sessions, p.SessionID)
		}
	}
	return out
}

func containsConn(cs []*Conn, c *Conn) bool {
	for _, x := range cs {
		if x == c {
			return true
		}
	}
	return false
}

func domainOf(method string) string {
	if i := strings.IndexByte(method, '.'); i > 0 {
		return method[:i]
	}
	return method
}

// send 는 클라이언트의 요청 하나를 전역 id 로 바꿔 보낸다.
func (m *Mux) send(c *Conn, msg *Message) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	m.nextID++
	gid := m.nextID
	m.pending[gid] = pendingReq{c: c, origID: msg.ID, method: msg.Method, params: msg.Params}
	m.mu.Unlock()
	if msg.SessionID == "" && !c.ownSession {
		c.mu.Lock()
		c.domains[domainOf(msg.Method)] = struct{}{}
		c.mu.Unlock()
	}
	out := *msg
	out.ID = gid
	b, err := json.Marshal(&out)
	if err != nil {
		m.mu.Lock()
		delete(m.pending, gid)
		m.mu.Unlock()
		return err
	}
	b = append(b, 0)
	m.wmu.Lock()
	_, err = m.w.Write(b)
	m.wmu.Unlock()
	if err != nil {
		m.mu.Lock()
		delete(m.pending, gid)
		m.mu.Unlock()
		return ErrClosed
	}
	return nil
}

// Conn 은 Mux 위의 클라이언트 하나다. 자기 id 공간을 갖는다.
type Conn struct {
	mux    *Mux
	filter Filter
	sink   func(*Message)
	// onCreated 는 이 클라이언트가 만든 target 을 알린다 (FR-BRT-44).
	onCreated func(targetID string, params json.RawMessage)

	ownSession bool

	mu       sync.Mutex
	domains  map[string]struct{}
	contexts map[string]struct{} // 이 클라이언트가 만든 browserContext
	closed   bool
}

// ConnOptions 는 클라이언트 하나의 성질이다.
type ConnOptions struct {
	// Sink 는 응답과 이벤트를 받는다. 읽기 고루틴에서 불리므로 막지 않는다.
	Sink func(*Message)
	// Filter 가 있으면 요청마다 먼저 본다.
	Filter Filter
	// OnCreated 는 이 클라이언트의 `Target.createTarget` 이 성공했을 때 불린다.
	OnCreated func(targetID string, params json.RawMessage)
	// OwnSession 이면 루트 연결의 브라우저 수준 이벤트를 받지 않는다 — 자기 브라우저
	// 세션으로만 말하는 클라이언트(Proxy)다. 받으면 매니저의 부착이 도구에 샌다.
	OwnSession bool
}

// Open 은 새 클라이언트를 붙인다.
func (m *Mux) Open(o ConnOptions) *Conn {
	c := &Conn{mux: m, sink: o.Sink, filter: o.Filter, onCreated: o.OnCreated, ownSession: o.OwnSession,
		domains: map[string]struct{}{}, contexts: map[string]struct{}{}}
	m.mu.Lock()
	m.conns[c] = struct{}{}
	closed := m.closed
	m.mu.Unlock()
	if closed {
		c.closed = true
	}
	return c
}

// Send 는 요청 하나를 보낸다. 응답은 Sink 로 온다 — id 는 보낸 그대로다.
// 필터가 거절하면 Chrome 에 보내지 않고 오류 응답을 Sink 로 준다.
func (c *Conn) Send(msg *Message) error {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if c.filter != nil {
		if err := c.filter(c, msg); err != nil {
			if errors.Is(err, ErrSwallow) {
				c.deliver(&Message{ID: msg.ID, SessionID: msg.SessionID, Result: json.RawMessage(`{}`)})
				return nil
			}
			c.deliver(&Message{ID: msg.ID, SessionID: msg.SessionID, Error: &Error{Code: -32000, Message: err.Error()}})
			return nil
		}
	}
	return c.mux.send(c, msg)
}

// OwnsContext 는 이 클라이언트가 그 browserContext 를 만들었는가다.
func (c *Conn) OwnsContext(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.contexts[id]
	return ok
}

// Close 는 클라이언트를 뗀다. 그 클라이언트의 대기 중 요청은 버린다.
func (c *Conn) Close() {
	m := c.mux
	m.mu.Lock()
	delete(m.conns, c)
	for id, p := range m.pending {
		if p.c == c {
			delete(m.pending, id)
		}
	}
	for s, set := range m.sessions {
		delete(set, c)
		if len(set) == 0 {
			delete(m.sessions, s)
		}
	}
	m.mu.Unlock()
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
}

func (c *Conn) deliver(msg *Message) {
	if c.sink != nil {
		c.sink(msg)
	}
}

// fail 은 pipe 가 끊겼을 때 클라이언트를 닫는다. Sink 에 id 0 의 빈 메시지를
// 주지 않는다 — Client 가 자기 대기열을 스스로 비운다 (closed 신호).
func (c *Conn) fail() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.deliver(&Message{Method: closedMethod})
}

// closedMethod 는 연결이 끊겼음을 Sink 에 알리는 내부 표식이다. Chrome 은 이
// 이름을 쓰지 않는다.
const closedMethod = "dongminal.closed"

// IsClosed 는 m 이 연결 끊김 표식인가다.
func IsClosed(m *Message) bool { return m.Method == closedMethod }
