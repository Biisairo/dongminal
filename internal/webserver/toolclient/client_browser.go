package toolclient

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"dongminal/internal/shared/browser"
	"dongminal/internal/shared/toolipc"
)

// 데몬 모드의 브라우저 매니저 표면이다 (BROWSER_TAB_SRS FR-BRT-8). ToolClient 가
// `browser.Host` 를 구현한다 — 직접 모드의 Manager 와 같은 표면이다.

// ErrDaemonNoBrowser 는 지금 붙은 데몬이 브라우저를 모른다는 뜻이다 — 옛 판이다
// (TC-BRT-8). 사용자가 할 일은 데몬을 다시 띄우는 것이다.
var ErrDaemonNoBrowser = errors.New("데몬이 브라우저 탭을 모르는 옛 판입니다 — dongminal start --restart-daemon 으로 데몬을 다시 시작하세요")

// browserCallMax 는 조작 하나의 상한이다. ctx 에 기한이 있으면 그것을 따른다.
const browserCallMax = 65 * time.Second

// Call 은 browser 요청 하나다.
func (pc *ToolClient) Call(ctx context.Context, op string, params any) (json.RawMessage, error) {
	if !pc.HasFeature(toolipc.FeatureBrowser) {
		return nil, ErrDaemonNoBrowser
	}
	raw, err := marshalParams(params)
	if err != nil {
		return nil, err
	}
	within := browserCallMax
	var ms int64
	if dl, ok := ctx.Deadline(); ok {
		within = time.Until(dl)
		// 데몬 쪽 상한은 조금 짧게 — 답이 기한 안에 돌아와야 오류 문구가 산다.
		ms = (within - 500*time.Millisecond).Milliseconds()
		if ms < 1 {
			ms = 1
		}
	}
	res, err := pc.callWithin(toolipc.MethodBrowser, toolipc.BrowserParams{Op: op, Params: raw, TimeoutMs: ms}, within)
	var rpc *toolipc.RPCError
	if errors.As(err, &rpc) {
		// 매니저가 사용자에게 하려던 말이다 — 봉투의 머리말을 떼어 그대로 건넨다.
		return nil, errors.New(rpc.Message)
	}
	return res, err
}

// SetSink 는 browser push 를 받을 곳을 건다.
func (pc *ToolClient) SetSink(f func(browser.Event)) {
	pc.mu.Lock()
	pc.onBrowser = f
	pc.mu.Unlock()
}

func (pc *ToolClient) pushBrowser(m *wireMsg) {
	pc.mu.Lock()
	f := pc.onBrowser
	pc.mu.Unlock()
	if f != nil {
		f(browser.Event{Kind: m.Kind, Tab: m.Tab, Data: m.Data, Info: m.Info})
	}
}

func marshalParams(params any) (json.RawMessage, error) {
	if raw, ok := params.(json.RawMessage); ok {
		return raw, nil
	}
	return json.Marshal(params)
}

var _ browser.Host = (*ToolClient)(nil)
