package cdp

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// DefaultTimeout 은 제한 시간이 없는 요청의 상한이다 (FR-BRT-20).
const DefaultTimeout = 30 * time.Second

// Client 는 Conn 위의 요청·응답 상관이다 — 매니저 자신이 쓰는 쪽이다.
type Client struct {
	conn *Conn

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan *Message
	closed  bool
	onEvent func(*Message)
}

// NewClient 는 mux 에 클라이언트 하나를 붙인다. onEvent 는 이벤트마다 읽기
// 고루틴에서 불린다 — 오래 걸리는 일은 넘겨서 한다.
func NewClient(m *Mux, onEvent func(*Message)) *Client {
	c := &Client{pending: map[int64]chan *Message{}, onEvent: onEvent}
	c.conn = m.Open(ConnOptions{Sink: c.handle})
	return c
}

func (c *Client) handle(msg *Message) {
	if IsClosed(msg) {
		c.mu.Lock()
		c.closed = true
		for id, ch := range c.pending {
			delete(c.pending, id)
			close(ch)
		}
		c.mu.Unlock()
		if c.onEvent != nil {
			c.onEvent(msg)
		}
		return
	}
	if msg.ID != 0 {
		c.mu.Lock()
		ch := c.pending[msg.ID]
		delete(c.pending, msg.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
		return
	}
	if c.onEvent != nil {
		c.onEvent(msg)
	}
}

// Call 은 요청 하나를 보내고 결과를 기다린다. session 이 비면 브라우저 수준이다.
// ctx 에 기한이 없으면 DefaultTimeout 이 걸린다.
func (c *Client) Call(ctx context.Context, session, method string, params any) (json.RawMessage, error) {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		raw = b
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, DefaultTimeout)
		defer cancel()
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrClosed
	}
	c.nextID++
	id := c.nextID
	ch := make(chan *Message, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.conn.Send(&Message{ID: id, Method: method, Params: raw, SessionID: session}); err != nil {
		c.drop(id)
		return nil, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, ErrClosed
		}
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-ctx.Done():
		c.drop(id)
		return nil, ctx.Err()
	}
}

func (c *Client) drop(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// Close 는 클라이언트를 뗀다.
func (c *Client) Close() { c.conn.Close() }

// Fire 는 답을 기다리지 않는 요청이다 — 읽기 고루틴 안에서 보낼 때 쓴다(거기서 답을
// 기다리면 그 답을 읽을 고루틴이 없다). 답은 버려진다.
func (c *Client) Fire(session, method string, params any) {
	var raw json.RawMessage
	if params != nil {
		raw, _ = json.Marshal(params)
	}
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	c.mu.Unlock()
	c.conn.Send(&Message{ID: id, Method: method, Params: raw, SessionID: session})
}
