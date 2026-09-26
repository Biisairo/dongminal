package ipc

import (
	"context"
	"time"

	"dongminal/internal/shared/browser"
	"dongminal/internal/shared/toolipc"
)

// 브라우저 매니저의 IPC 면이다 (BROWSER_TAB_SRS FR-BRT-8). PTY 와 같은 자리에 산다 —
// 데몬이 소유하므로 웹 서버를 다시 띄워도 페이지와 탭 대응이 살아남는다.

// browserCallTimeout 은 조작 하나의 상한이다. 프로필 브라우저를 처음 띄우는 조작이
// 가장 길다.
const browserCallTimeout = 60 * time.Second

// SetBrowser 는 매니저를 싣는다. 소식은 지금 붙어 있는 연결로 나간다.
func (ps *PanedServer) SetBrowser(m *browser.Manager) {
	ps.mu.Lock()
	ps.browser = m
	ps.mu.Unlock()
	m.SetSink(func(e browser.Event) {
		ps.mu.Lock()
		c := ps.currConn
		ps.mu.Unlock()
		if c != nil {
			c.pushBrowser(e)
		}
	})
}

// browserCall 은 browser 요청 하나다. **입력과 CDP 프록시 메시지는 읽기 루프 안에서**
// 부른다 — 곧바로 돌아오므로 빠르고, 도착 순서가 곧 보내는 순서다(CDP 는 순서가 뜻을
// 갖는다). 나머지는 읽기 루프 밖에서 돈다 — 브라우저를 띄우는 조작이 다른 도구의 입력을
// 막지 않는다. 상한은 부른 쪽이 준 시간(`timeoutMs`)이 있으면 그것이다.
func (pc *panedConn) browserCall(req *toolipc.PanedRequest) {
	p, perr := decodeParams[toolipc.BrowserParams](req)
	if perr != nil {
		pc.enqueue(*perr, false)
		return
	}
	m := pc.browser
	run := func() interface{} {
		if m == nil {
			return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeMethodNotFound, Message: "browser manager not configured"}}
		}
		within := browserCallTimeout
		if p.TimeoutMs > 0 {
			within = time.Duration(p.TimeoutMs) * time.Millisecond
		}
		ctx, cancel := context.WithTimeout(context.Background(), within)
		defer cancel()
		res, err := m.Call(ctx, p.Op, p.Params)
		if err != nil {
			return errResp(req, toolipc.CodeServer, err)
		}
		return okResp(req, res)
	}
	if p.Op == "input" || p.Op == "proxySend" {
		pc.enqueue(run(), false)
		return
	}
	// `go pc.enqueue(run(), false)` 로 쓰면 안 된다 — go 문의 인자는 부르는 고루틴에서
	// 먼저 평가되므로 run 이 읽기 루프 안에서 돈다 (실측: Page.navigate 가 hello 를 막아
	// 연결이 끊겼다).
	go func() { pc.enqueue(run(), false) }()
}

// pushBrowser 는 매니저의 소식이다. 프레임은 떨어뜨릴 수 있다 — 다음 프레임이 메운다.
// 나머지(상태·닫힘·생성)는 떨어뜨리지 않는다.
func (pc *panedConn) pushBrowser(e browser.Event) {
	ev := toolipc.BrowserEvent{Event: toolipc.EventBrowser, Kind: e.Kind, Tab: e.Tab, Data: e.Data, Info: e.Info}
	pc.enqueue(ev, e.Kind == browser.EvFrame)
}
