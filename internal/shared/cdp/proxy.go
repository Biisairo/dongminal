package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// Proxy 는 CDP 프록시로 붙은 외부 도구 하나다 (FR-BRT-22).
//
// **자기 브라우저 세션을 갖는다.** 외부 도구의 브라우저 수준 요청(세션 없는 것)은
// `Target.attachToBrowserTarget` 로 얻은 세션 S 로 보내고, S 로 온 소식은 세션을 떼고
// 건넨다. 그래서 도구가 보기에는 연결을 혼자 쓰는 것과 같다 — 매니저가 이미 건
// `Target.setAutoAttach` 가 도구의 자동 부착을 삼키지 않는다.
type Proxy struct {
	conn    *Conn
	session string
	sink    func([]byte)

	mu     sync.Mutex
	waitID int64
	waitCh chan *Message
	closed bool
}

// proxyHandshakeID 는 세션을 여는 요청의 id 다. 도구의 id 와 섞이지 않게 음수를 쓴다.
const proxyHandshakeID = -1

// OpenProxy 는 외부 도구 하나를 붙인다. sink 는 도구에게 보낼 메시지(JSON)를 받는다.
// onCreated 는 도구가 만든 target 을 알린다 (FR-BRT-44).
func (m *Mux) OpenProxy(ctx context.Context, sink func([]byte), onCreated func(targetID string)) (*Proxy, error) {
	p := &Proxy{sink: sink, waitCh: make(chan *Message, 1), waitID: proxyHandshakeID}
	p.conn = m.Open(ConnOptions{Filter: ExternalFilter, Sink: p.deliver, OwnSession: true, OnCreated: func(id string, _ json.RawMessage) {
		if onCreated != nil {
			onCreated(id)
		}
	}})
	if err := p.conn.Send(&Message{ID: proxyHandshakeID, Method: "Target.attachToBrowserTarget"}); err != nil {
		p.conn.Close()
		return nil, err
	}
	select {
	case msg := <-p.waitCh:
		if msg == nil || msg.Error != nil {
			p.conn.Close()
			if msg != nil {
				return nil, msg.Error
			}
			return nil, ErrClosed
		}
		var r struct {
			SessionID string `json:"sessionId"`
		}
		json.Unmarshal(msg.Result, &r)
		if r.SessionID == "" {
			p.conn.Close()
			return nil, errors.New("cdp: 브라우저 세션을 얻지 못했다")
		}
		p.mu.Lock()
		p.session = r.SessionID
		p.waitID = 0
		p.mu.Unlock()
		return p, nil
	case <-ctx.Done():
		p.conn.Close()
		return nil, ctx.Err()
	}
}

// Session 은 이 도구의 브라우저 세션이다.
func (p *Proxy) Session() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.session
}

func (p *Proxy) deliver(msg *Message) {
	if IsClosed(msg) {
		p.mu.Lock()
		p.closed = true
		ch := p.waitCh
		p.mu.Unlock()
		select {
		case ch <- nil:
		default:
		}
		return
	}
	p.mu.Lock()
	wait, s := p.waitID, p.session
	p.mu.Unlock()
	if wait != 0 && msg.ID == wait {
		p.waitCh <- msg
		return
	}
	if s != "" && msg.SessionID == s {
		msg.SessionID = ""
	}
	b, err := json.Marshal(msg)
	if err == nil {
		p.sink(b)
	}
}

// Send 는 도구가 보낸 메시지 하나다. 세션이 없으면 도구의 브라우저 세션으로 보낸다.
func (p *Proxy) Send(raw []byte) error {
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return err
	}
	if msg.ID <= 0 {
		return errors.New("cdp: id 가 없는 요청")
	}
	if msg.SessionID == "" {
		msg.SessionID = p.Session()
	}
	return p.conn.Send(&msg)
}

// Close 는 도구를 뗀다. 도구가 만든 페이지는 남는다 — 그것은 탭이다.
func (p *Proxy) Close() { p.conn.Close() }
