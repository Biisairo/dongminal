package toolclient

import (
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/toolipc"

	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"
)

// RPC — 줄 단위 JSON 의 읽기 루프, 응답 배달, 요청·알림 쓰기와 시한 (DAEMON_SPLIT_SRS FR-14).

// wireMsg 는 데몬이 보내는 줄 하나의 모든 모양이다 — 응답(id·result·error)과
// push(event 와 그 필드). 한 번의 Decode 로 끝낸다 (IPC-13). 종전에는 RawMessage 로
// 받고, 구분하려고 한 번, 처리하려고 또 한 번 해석한 뒤 base64 를 따로 풀었다.
// []byte 필드는 encoding/json 이 표준 base64 로 푼다.
type wireMsg struct {
	ID     *int64               `json:"id"`
	Result json.RawMessage      `json:"result"`
	Error  *toolipc.PanedErrObj `json:"error"`

	Event string `json:"event"`
	Tool  string `json:"tool"`
	Data  []byte `json:"data"`
	End   int64  `json:"end"`
	Code  int    `json:"code"`
	Cols  uint16 `json:"cols"`
	Rows  uint16 `json:"rows"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	// Value 는 record push 의 값이다 (FR-ARD-12). 줄마다 새 wireMsg 이므로 덮이지 않는다.
	Value json.RawMessage `json:"value"`
	// Method·Body 는 report push 다 (AGENT_RECORD_DAEMON_SRS §3.2a).
	Method string          `json:"method"`
	Body   json.RawMessage `json:"body"`
	// Reason·Agent 는 attn push 다 (§3.3a).
	Reason string             `json:"reason"`
	Agent  toolhub.AgentState `json:"agent"`
	// Paired·Removed 는 edges push 다 (PEER_DAEMON_SRS §3.5a, EDGE_PAIRING_SRS FR-EPR-5).
	Paired  *toolipc.EdgeRef `json:"paired"`
	Removed *toolipc.EdgeRef `json:"removed"`
	ByPeer  bool             `json:"byPeer"`
	Invited *toolipc.EdgeRef `json:"invited"`
	// ChatKind·Chat 은 chat push 다 (PEER_CHAT_SRS §3.11).
	ChatKind string            `json:"chatKind"`
	Chat     *chatwire.Message `json:"chat"`
}

// readLoop decodes responses and push events for a single connection. On
// connection death it signals connLost so the supervisor can reconnect.
func (pc *ToolClient) readLoop(conn net.Conn, cd chan struct{}) {
	dec := json.NewDecoder(conn)
	for {
		// 줄마다 새 값이다 — Result 는 RawMessage 라 재사용하면 앞 응답의 바이트를
		// 덮는다.
		var m wireMsg
		err := dec.Decode(&m)
		if err != nil && !isValueError(err) {
			if !pc.stopped.Load() {
				dmlog.Infof(nil, "toolclient read: %v", err)
			}
			break
		}
		if m.Event != "" {
			if err == nil {
				pc.handlePush(&m)
			}
			// 해석 못 한 push 는 버린다 — 종전에도 그 push 만 버려졌다.
			continue
		}
		if m.ID != nil {
			pc.handleResponse(*m.ID, &m, err)
		}
	}
	pc.connLost(cd)
}

// isValueError 는 줄 하나의 **값**이 틀렸을 뿐 스트림은 온전한 오류인가다. 그때
// Decoder 는 그 줄을 이미 다 읽었으므로 다음 줄로 넘어갈 수 있다. 문법 오류·I/O
// 오류는 스트림이 깨진 것이다.
func isValueError(err error) bool {
	var typ *json.UnmarshalTypeError
	var b64 base64.CorruptInputError
	return errors.As(err, &typ) || errors.As(err, &b64)
}

// connLost closes connDone exactly once and fails all pending calls for the
// dead connection so blocked callers return promptly (FR-14).
func (pc *ToolClient) connLost(cd chan struct{}) {
	pc.mu.Lock()
	select {
	case <-cd:
		pc.mu.Unlock()
		return // already handled
	default:
	}
	close(cd)
	pending := pc.pending
	pc.pending = make(map[int64]chan rpcReply)
	pc.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}

// dropIfCurrent closes the live socket only if it still matches cd, forcing
// readLoop to error out and the supervisor to reconnect.
func (pc *ToolClient) dropIfCurrent(cd chan struct{}) {
	pc.mu.Lock()
	if pc.connDone == cd && pc.conn != nil {
		pc.conn.Close()
	}
	pc.mu.Unlock()
}

// handleResponse delivers a response to the waiting caller. decodeErr 는 봉투를
// 해석하지 못한 사정이다 — 호출자는 시한까지 매달리지 않고 그것을 받는다.
func (pc *ToolClient) handleResponse(id int64, m *wireMsg, decodeErr error) {
	pc.mu.Lock()
	ch := pc.pending[id]
	delete(pc.pending, id)
	pc.mu.Unlock()
	if ch == nil {
		return
	}
	r := rpcReply{result: m.Result, err: decodeErr}
	if r.err == nil && m.Error != nil {
		r.err = &toolipc.RPCError{Code: m.Error.Code, Message: m.Error.Message}
	}
	ch <- r
}

// outRequest 는 보내는 요청이다. params 를 따로 Marshal 해 RawMessage 로 싣지
// 않는다 — Encode 가 한 번에 부호화하고, 실패하면 아무것도 쓰지 않는다.
type outRequest struct {
	ID     int64  `json:"id"`
	Method string `json:"method"`
	Params any    `json:"params"`
}

// notifyRequest 는 응답 없는 알림이다 (FR-OPT-2-2). id 가 없다 — 데몬은 답하지 않고
// 이쪽은 기다릴 자리(pending)를 만들지 않는다.
type notifyRequest struct {
	Method string `json:"method"`
	Params any    `json:"params"`
}

// notify 는 알림 한 줄을 쓴다. 실패는 버린다 — 쓰기 실패는 readLoop 가 연결의 끝으로
// 보고 재접속이 잇는다. 알림을 쓰는 자리(WS 중계)는 종전에도 결과를 버렸다.
func (pc *ToolClient) notify(method string, params any) {
	pc.mu.Lock()
	enc := pc.enc
	pc.mu.Unlock()
	if enc == nil {
		return
	}
	pc.writeMu.Lock()
	_ = enc.Encode(notifyRequest{Method: method, Params: params})
	pc.writeMu.Unlock()
}

// call sends a request and blocks until the response arrives, the connection
// is lost, the call times out (FR-14), or the client closes.
func (pc *ToolClient) call(method string, params any) (json.RawMessage, error) {
	return pc.callWithin(method, params, toolCallTimeout)
}

// callT 는 call 의 결과를 R 로 한 번 읽는다 (FR-OPT-2-6). 결과가 없거나 null 이면
// R 의 제로값이다 — 필드를 모르는 옛 데몬과 같은 뜻이다.
func callT[R any](pc *ToolClient, method string, params any) (R, error) {
	return callWithinT[R](pc, method, params, toolCallTimeout)
}

func callWithinT[R any](pc *ToolClient, method string, params any, within time.Duration) (R, error) {
	var r R
	raw, err := pc.callWithin(method, params, within)
	if err != nil || len(raw) == 0 {
		return r, err
	}
	err = json.Unmarshal(raw, &r)
	return r, err
}

// callWithin 은 시한을 따로 받는 call 이다 — 데몬 쪽에서 유예를 기다리는
// `terminate` 처럼 기본 시한보다 오래 걸리는 것이 정상인 호출의 자리.
//
// 오류 문구의 `paned` 는 데몬의 옛 이름이지만 **바꾸지 않는다** (REFACTOR3_GO_STRUCT_SRS
// FR-RGS-6) — 이 문구는 toolio·chat·WS 오류 본문에 그대로 실려 나가는 와이어다.
func (pc *ToolClient) callWithin(method string, params any, within time.Duration) (json.RawMessage, error) {
	pc.mu.Lock()
	if pc.enc == nil {
		pc.mu.Unlock()
		return nil, fmt.Errorf("toolclient not connected")
	}
	id := pc.nextID
	pc.nextID++
	ch := make(chan rpcReply, 1)
	pc.pending[id] = ch
	cd := pc.connDone
	enc := pc.enc
	pc.mu.Unlock()

	pc.writeMu.Lock()
	err := enc.Encode(outRequest{ID: id, Method: method, Params: params})
	pc.writeMu.Unlock()
	if err != nil {
		// 부호화 실패(IPC-22)든 쓰기 실패든 호출자에게 돌려준다. 종전에는 Marshal
		// 오류를 버려 params 가 null 로 나갔다.
		pc.mu.Lock()
		delete(pc.pending, id)
		pc.mu.Unlock()
		return nil, err
	}

	// 호출마다 타이머를 만들고 **돌아갈 때 멈춘다** (M8 `GO-35`). time.After 는
	// 시한이 다 될 때까지 회수되지 않아 고빈도 list 에서 5초짜리 타이머가 쌓였다.
	timeout := time.NewTimer(within)
	defer timeout.Stop()
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("paned connection lost")
		}
		// 성공과 오류는 readLoop 가 **한 번에** 갈랐다 (M8 D-A-16). 오류 응답도
		// `id` 를 가지므로, 성공으로 먼저 읽으면 오류가 "결과 없음" 으로 뭉개진다.
		return r.result, r.err
	case <-cd:
		return nil, fmt.Errorf("paned connection lost")
	case <-timeout.C:
		// 시한 초과에 연결 전체를 끊는 것은 **설계다** (REFACTOR3_GO_STRUCT_SRS FR-RGS-8
		// 검토 결과 유지). DAEMON_SPLIT_SRS FR-14 가 "close 하고 재연결로 전이" 를 요구하고,
		// ping 은 호출이 걸려 있으면 건너뛰므로 이 시한이 무응답 데몬을 찾는 유일한 수단이다.
		// 옛 데몬은 요청을 읽기 루프 안에서 처리하므로, 한 호출이 시한을 넘기면 그 연결의
		// 뒤 호출도 같이 막혀 있다. 호출만 버리면 모든 호출이 하나씩 시한을 다 기다린다.
		pc.mu.Lock()
		delete(pc.pending, id)
		pc.mu.Unlock()
		pc.dropIfCurrent(cd)
		return nil, fmt.Errorf("paned call %q timed out", method)
	case <-pc.closed:
		return nil, fmt.Errorf("toolclient closed")
	}
}
