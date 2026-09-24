package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// ErrConnClosed 는 통로가 닫힌 뒤의 요청이다.
var ErrConnClosed = errors.New("lsp: connection closed")

// rpcMessage 는 오고 가는 한 통이다.
//
// 요청·응답·알림이 한 구조인 것은 JSON-RPC 가 그렇기 때문이다 — 무엇인지는 어느
// 필드가 있는가로 갈린다: `id` 가 있고 `method` 가 없으면 응답, `method` 가 있고
// `id` 가 없으면 알림이다.
type rpcMessage struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int64 `json:"id,omitempty"`
	Method  string `json:"method,omitempty"`
	Params  any    `json:"params,omitempty"`
}

// rpcIncoming 은 **받는** 한 통이다.
//
// 송신용과 나눈 것은 `params` 한 키를 두 방향이 다른 타입으로 쓰기 때문이다 —
// 보낼 때는 아무 값(`any`)이고 받을 때는 아직 풀지 않은 바이트(`json.RawMessage`)다.
// 한 구조로 합치면 알림의 params 를 읽을 자리가 없어지고, 그러면 진단이 통째로
// 빈 값으로 온다.
//
// REPO_FIX 02 §3A-5: id 는 **원문**으로 받는다 — 서버발 요청의 id 는 문자열일 수
// 있고, 그 응답에 그대로 되실어야 한다. 이전에는 `*int64` 라 문자열 id 요청이
// Unmarshal 단계에서 통째로 버려졌다.
type rpcIncoming struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// rpcReply 는 서버발 요청에 대한 **응답**이다. id 는 받은 원문 그대로다.
type rpcReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
	Error   *rpcError       `json:"error,omitempty"`
}

// requestFunc 는 서버발 요청 하나에 답한다 (§3A-5). err 가 nil 이면 result 를 싣는다.
type requestFunc func(method string, params json.RawMessage) (any, *rpcError)

// errMethodNotFound 는 모르는 서버발 요청의 답이다 (JSON-RPC −32601).
func errMethodNotFound(method string) *rpcError {
	return &rpcError{Code: -32601, Message: "method not found: " + method}
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("lsp: server error %d: %s", e.Code, e.Message)
}

// conn 은 언어 서버 하나와의 JSON-RPC 대화다.
//
// **응답을 `id` 로 매칭하는 것이 이 계층의 존재 이유다.** 순서로 짝지으면 정의
// 이동이 호버의 답을 받고, 그 증상은 "가끔 엉뚱한 데로 뛴다" 로 보인다 — 재현이
// 어렵고 원인을 짚기도 어려운 종류의 고장이다.
type conn struct {
	rwc io.ReadWriteCloser

	// wmu 는 쓰기를 직렬화한다. 프레임 둘이 섞여 나가면 그 뒤가 전부 어긋난다.
	wmu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan rpcIncoming
	closed  bool
	// dead 는 읽기 루프가 죽은 이유다. 닫힌 뒤의 요청이 이것을 사유로 받는다.
	dead error

	onNotify  func(method string, params json.RawMessage)
	onRequest requestFunc
	done      chan struct{}
}

// newConn 은 통로 하나 위에 대화를 세우고 읽기 루프를 띄운다. onRequest 가 nil 이면
// 서버발 요청에 모두 −32601 로 답한다.
func newConn(rwc io.ReadWriteCloser, onNotify func(string, json.RawMessage), onRequest requestFunc) *conn {
	c := &conn{
		rwc:       rwc,
		pending:   map[int64]chan rpcIncoming{},
		onNotify:  onNotify,
		onRequest: onRequest,
		done:      make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// readLoop 은 통로가 끊길 때까지 프레임을 읽는다.
//
// 끊기면 **대기 중인 요청을 모두 풀어 준다** (FR-LSP-20). 풀지 않으면 그 세션의
// 모든 요청이 영원히 매달리고, 사용자에게는 "아무 일도 일어나지 않음" 으로 보인다.
func (c *conn) readLoop() {
	r := bufio.NewReader(c.rwc)
	var cause error
	for {
		body, err := readFrame(r)
		if err != nil {
			cause = err
			break
		}
		var m rpcIncoming
		if err := json.Unmarshal(body, &m); err != nil {
			// 한 통이 깨진 것은 통로가 끊긴 것과 다르다 — 넘기고 계속 읽는다.
			continue
		}
		hasID := len(m.ID) > 0 && string(m.ID) != "null"
		// 알림: method 가 있고 id 가 없다. 싣고 있는 것은 `params` 다 —
		// `result` 로 읽으면 진단이 통째로 빈 값으로 온다.
		if m.Method != "" && !hasID {
			if c.onNotify != nil {
				c.onNotify(m.Method, m.Params)
			}
			continue
		}
		// REPO_FIX 02 §3A-5: method 와 id 가 함께 있으면 **서버발 요청**이다.
		//
		//	이전 동작: 응답으로 보고 id 로 매칭했다 — 대기 중인 Call 과 id 가 같으면
		//	          그 Call 이 엉뚱한 답을 받았고, 서버는 답을 기다리며 멈췄다
		//	새  동작: 요청으로 분류해 답한다(알려진 것은 최소 응답, 그 밖은 −32601)
		//	이유:     `workspace/configuration` 에 답하지 않으면 멈추는 서버가 있다 (#18)
		//
		// 답은 읽기 루프 밖에서 쓴다 — 서버가 stdin 을 읽지 않는 동안 쓰기가 막혀도
		// 읽기 루프(진단·응답)는 계속 돈다.
		if m.Method != "" {
			go c.answer(m.ID, m.Method, m.Params)
			continue
		}
		if !hasID {
			continue
		}
		var id int64
		if json.Unmarshal(m.ID, &id) != nil {
			continue // 우리가 보낸 id 는 숫자뿐이다 — 아닌 것은 주인이 없다
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
	c.fail(cause)
}

// fail 은 통로를 죽은 것으로 표시하고 대기자를 모두 풀어 준다.
//
// **둘이 동시에 들어온다.** `readLoop` 의 끝과 `Close` 가 각각 부르며, 통로를
// 닫아도 읽기 루프가 곧바로 깨지 않는 구현에서는 그 둘이 겹친다.
//
// 그래서 "처음인가" 의 판정과 `done` 닫기가 **같은 잠금 아래** 있어야 한다.
// 종전에는 밖에서 `select`/`default` 로 보고 밖에서 닫았고, 둘이 함께 default 를
// 보면 둘 다 닫아 `close of closed channel` 로 죽었다 — `go test -race` 가
// 간헐적으로 잡았다. `c.dead` 는 여기서만 쓰이므로 그것이 곧 처음의 표식이다.
func (c *conn) fail(cause error) {
	c.mu.Lock()
	first := c.dead == nil
	if first {
		if cause == nil {
			cause = ErrConnClosed
		}
		c.dead = cause
	}
	// 사유도 잠금 아래에서 뜬다 — 밖에서 `c.dead` 를 읽으면 그것 자체가 경쟁이다.
	dead := c.dead
	waiters := c.pending
	c.pending = map[int64]chan rpcIncoming{}
	if first {
		close(c.done)
	}
	c.mu.Unlock()

	for _, ch := range waiters {
		// 버퍼가 1 이므로 아무도 읽지 않아도 막히지 않는다 (ctx 로 먼저 나간
		// 호출자의 자리가 그것이다).
		ch <- rpcIncoming{Error: &rpcError{Code: -32000, Message: dead.Error()}}
	}
}

// answer 는 서버발 요청 하나에 답한다. 통로가 죽었으면 쓰기가 실패할 뿐이다.
func (c *conn) answer(id json.RawMessage, method string, params json.RawMessage) {
	var result any
	rerr := errMethodNotFound(method)
	if c.onRequest != nil {
		result, rerr = c.onRequest(method, params)
	}
	reply := rpcReply{JSONRPC: "2.0", ID: id, Result: result, Error: rerr}
	if rerr != nil {
		reply.Result = nil
	}
	b, err := json.Marshal(reply)
	if err != nil {
		return
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = writeFrame(c.rwc, b)
}

// Call 은 요청을 보내고 그 응답을 기다린다.
//
// `ctx` 가 끝나면 기다림을 놓는다 (FR-LSP-52) — 언어 서버가 답하지 않아도 종단이
// 멎지 않아야 한다. 그때 그 id 의 자리는 치운다: 두고 나면 늦게 온 응답이 아무도
// 읽지 않는 채널에 갇힌다.
func (c *conn) Call(ctx context.Context, method string, params any, result any) error {
	c.mu.Lock()
	if c.closed || c.dead != nil {
		err := c.dead
		if err == nil {
			err = ErrConnClosed
		}
		c.mu.Unlock()
		return err
	}
	c.nextID++
	id := c.nextID
	ch := make(chan rpcIncoming, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.send(rpcMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		_, waiting := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		// §3A-5: 응답 전에 빠질 때만 서버에 취소를 알린다 — 계산을 멈추게 한다.
		// 이전 동작: 기다림만 놓았다 — 서버는 버려진 계산을 끝까지 했다.
		// 호출자를 막지 않는다 — 서버가 stdin 을 읽지 않으면 쓰기가 막힌다.
		if waiting {
			go func() { _ = c.Notify("$/cancelRequest", map[string]any{"id": id}) }()
		}
		return ctx.Err()
	case m := <-ch:
		if m.Error != nil {
			return m.Error
		}
		if result == nil || len(m.Result) == 0 {
			return nil
		}
		return json.Unmarshal(m.Result, result)
	}
}

// Notify 는 응답을 기다리지 않는 통보다 (`didOpen`·`didChange` 가 그것이다).
//
// `id` 를 싣지 않는 것이 규칙이다 — 실으면 서버가 응답을 보내고, 아무도 그것을
// 기다리지 않으므로 읽기 루프가 주인 없는 응답을 버리게 된다.
func (c *conn) Notify(method string, params any) error {
	c.mu.Lock()
	if c.closed || c.dead != nil {
		err := c.dead
		if err == nil {
			err = ErrConnClosed
		}
		c.mu.Unlock()
		return err
	}
	c.mu.Unlock()
	return c.send(rpcMessage{JSONRPC: "2.0", Method: method, Params: params})
}

func (c *conn) send(m rpcMessage) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return writeFrame(c.rwc, b)
}

// Close 는 통로를 닫는다. 대기 중인 요청은 readLoop 의 끝에서 풀린다.
func (c *conn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	err := c.rwc.Close()
	// 통로를 닫아도 읽기 루프가 곧바로 깨지 않는 구현이 있다 — 여기서도 풀어 준다.
	c.fail(ErrConnClosed)
	return err
}
