package ipc

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"dongminal/internal/shared/browser"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// blockEngine 은 기동이 풀릴 때까지 멈추는 엔진이다 — 오래 걸리는 조작의 대역.
type blockEngine struct{ release chan struct{} }

func (e blockEngine) Find() (string, error) { return "/x/chrome", nil }
func (blockEngine) InstallHint() string     { return "" }
func (e blockEngine) StartPiped(platform.PipedSpec) (*platform.PipedProcess, error) {
	<-e.release
	return nil, errors.New("fake")
}
func (blockEngine) ModIsMeta() bool { return false }

// BROWSER_TAB_SRS FR-BRT-8: 브라우저 조작은 **읽기 루프 밖에서** 돈다. 브라우저를 띄우는
// 긴 조작이 걸려 있어도 같은 연결의 hello 는 곧바로 답해야 한다 — 막히면 서버의 생존
// 확인이 연결을 끊는다 (실측 결함: `go f(run())` 가 run 을 읽기 루프에서 돌렸다).
func TestBrowserCallDoesNotBlockReadLoop(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	eng := blockEngine{release: make(chan struct{})}
	defer close(eng.release)
	m := browser.New(browser.Config{Home: t.TempDir(), Engine: eng, Euid: func() int { return 1000 }})
	pc := newTestConn(pm)
	pc.browser = m
	params, _ := json.Marshal(toolipc.BrowserParams{Op: "open", Params: json.RawMessage(`{"tab":"t","url":"about:blank"}`)})
	done := make(chan struct{})
	go func() {
		pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodBrowser, Params: params})
		pc.dispatch(&toolipc.PanedRequest{ID: 2, Method: toolipc.MethodHello, Params: json.RawMessage(`{}`)})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("브라우저 조작이 읽기 루프를 막았다")
	}
}
