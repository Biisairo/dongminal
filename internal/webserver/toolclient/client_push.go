package toolclient

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"

	"encoding/base64"
	"encoding/json"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `client.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **daemon 이 밀어 보내는 것**(push)이다. `client.go` 에 남은 것은
// 연결의 수명(dial·supervise·readLoop·재접속)과 요청/응답이며, 둘은 서로 다른
// 방향이다 — 저쪽은 우리가 묻고 이쪽은 저쪽이 말한다.

func (pc *ToolClient) handlePush(event string, raw json.RawMessage) {
	switch event {
	case "output":
		pc.pushOutput(raw)
	case "fg":
		pc.pushForeground(raw)
	case "exit":
		pc.pushExit(raw)
	case "size":
		pc.pushSize(raw)
	}
}

// pushSize 는 `size` push 다 — PTY 크기가 바뀌었다 (M9_SRS FR-M9-3 ②).
//
// **출력과 같은 채널로 보낸다.** 크기가 바뀐 뒤의 출력은 새 폭 기준이므로, 채널을
// 나누면 둘이 경쟁해 어긋난 폭으로 해석되는 창이 생긴다 — 그 어긋남이 이 요구가
// 없애려는 것 자체다. `readLoop` 한 고루틴이 push 를 순서대로 처리하므로 이
// 채널에 들어가는 순서가 곧 데몬이 낸 순서다.
//
// **`output` 과 같이 떨어뜨린다** — 막으면 `readLoop` 가 서고, 그 루프는 모든
// 도구의 push 를 나른다. 느린 브라우저 하나가 나머지 전부를 멎게 하는 자리를
// 만들지 않는다(pushOutput 이 default 를 쓰는 것과 같은 근거).
//
// 대가는 기록해 둔다: 크기 통보를 잃은 클라이언트는 **어긋난 채로 남고 스스로
// 낫지 않는다.** 출력 청크와 달리 다음 청크가 메워 주지 않으며, 그 값을 다시
// 말하는 자리는 다음 접속의 snapshot 뿐이다. 그래서 떨어뜨림을 조용히 세지 않고
// **한 건도 남김없이** 로그로 올린다 — output 쪽은 256건마다 한 줄이다.
func (pc *ToolClient) pushSize(raw json.RawMessage) {
	var ev struct {
		Tool string `json:"tool"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	if ev.Cols == 0 || ev.Rows == 0 {
		return
	}
	pc.invalidateList()
	sz := &toolhub.TermSize{Cols: ev.Cols, Rows: ev.Rows}
	var dropped int64
	pc.subMu.RLock()
	for ch := range pc.subbers[ev.Tool] {
		select {
		case ch <- OutChunk{Size: sz}:
		default:
			dropped = pc.dropped.Add(1)
		}
	}
	pc.subMu.RUnlock()
	if dropped > 0 {
		dmlog.Warnf(nil, "toolclient: WS size push dropped tool=%s cols=%d rows=%d (slow browser?)", ev.Tool, ev.Cols, ev.Rows)
	}
}

// pushOutput 은 `output` push 다 — 해석층(onOutput)에 한 번, 구독한 브라우저마다 한 번.
func (pc *ToolClient) pushOutput(raw json.RawMessage) {
	var ev struct {
		Tool string `json:"tool"`
		Data string `json:"data"`
		// End 는 이 청크의 끝 절대 오프셋이다 (TERMINAL_RESUME_SRS FR-TRS-15).
		// 이 필드를 보내지 않는 옛 데몬에서는 0 으로 읽히고, 그때 받는 쪽은
		// 겹침 제거를 건너뛴다 — 지금 동작과 같아질 뿐 나빠지지 않는다.
		End int64 `json:"end"`
		// Kind 는 도구의 종류다 (M8_UNIFIED_SRS D-C-10). 여기서 목록으로 되물으면
		// 그 RPC 의 응답을 읽을 고루틴이 바로 이 readLoop 라 시한까지 막힌다.
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	data, err := base64.StdEncoding.DecodeString(ev.Data)
	if err != nil {
		return
	}
	// Attention/activity detection: once per chunk, in this single readLoop
	// goroutine — independent of WS subscribers (FR-15, §6.2).
	pc.mu.Lock()
	onOutput := pc.onOutput
	pc.mu.Unlock()
	if onOutput != nil {
		onOutput(ev.Tool, toolhub.ToolKind(ev.Kind), data, ev.End)
	}
	// Dispatch to per-tool output channels. Non-blocking: a single slow
	// WS subscriber must never stall readLoop (which serves every tool).
	// Drops are counted/logged rather than silently lost (FR-18).
	//
	// 순회는 **락 안에서** 한다. 종전에는 락 안에서 map 을 꺼내고 밖에서
	// 돌았는데, 꺼낸 것은 사본이 아니라 map 그 자체다 — 그 사이 브라우저
	// 하나가 붙거나 떨어지면(Subscribe·unsubscribe) Go 런타임이 프로세스를
	// 죽인다: `concurrent map iteration and map write`. recover 로 잡히는
	// 종류가 아니고, 서버가 통째로 사라진다.
	//
	// 락을 잡은 채 보내도 막히지 않는다 — 아래 send 는 default 가 있어
	// 언제나 즉시 떨어진다. 로그만 락 밖으로 미룬다(I/O 라 길다).
	var dropped int64
	pc.subMu.RLock()
	for ch := range pc.subbers[ev.Tool] {
		select {
		case ch <- OutChunk{Data: data, End: ev.End}:
		default:
			dropped = pc.dropped.Add(1)
		}
	}
	pc.subMu.RUnlock()
	if dropped == 1 || (dropped > 0 && dropped%256 == 0) {
		dmlog.Warnf(nil, "toolclient: WS output backpressure tool=%s dropped=%d (slow browser?)", ev.Tool, dropped)
	}
}

// pushForeground 는 `fg` push 다 — 전경 이름이 바뀌었다.
func (pc *ToolClient) pushForeground(raw json.RawMessage) {
	var ev struct {
		Tool string `json:"tool"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	pc.invalidateList()
	pc.mu.Lock()
	cb := pc.onForeground
	pc.mu.Unlock()
	if cb != nil {
		cb(ev.Tool, ev.Name)
	}
}

// pushExit 은 `exit` push 다 — 구독자를 닫고 전역 종료 콜백을 부른다.
func (pc *ToolClient) pushExit(raw json.RawMessage) {
	var ev struct {
		Tool   string   `json:"tool"`
		Code   int      `json:"code"`
		Stderr []string `json:"stderr"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	pc.invalidateList()
	// Signal every WS subscriber of this tool so it can send toolhub.OpExit and
	// tear down (parity with direct-mode tool.kill). Closing + removing
	// under subMu means no concurrent output dispatch sends on a closed chan.
	pc.subMu.Lock()
	subs := pc.subbers[ev.Tool]
	delete(pc.subbers, ev.Tool)
	pc.subMu.Unlock()
	for _, exitCh := range subs {
		close(exitCh)
	}
	// Global exit callback (activity cleanup). Buffer if not yet wired —
	// SetOnExit 가 재생한다.
	pc.mu.Lock()
	onExit := pc.onExit
	if onExit == nil {
		pc.earlyPushes = append(pc.earlyPushes, earlyPush{tool: ev.Tool, info: toolhub.ExitInfo{Code: ev.Code, Stderr: ev.Stderr}})
	}
	pc.mu.Unlock()
	if onExit != nil {
		onExit(ev.Tool, toolhub.ExitInfo{Code: ev.Code, Stderr: ev.Stderr})
	}
}

// call sends a request and blocks until the response arrives, the connection
