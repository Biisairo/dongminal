package browser

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"dongminal/internal/shared/platform"
)

type fakeEngine struct{ path string }

func (f fakeEngine) Find() (string, error) {
	if f.path == "" {
		return "", platform.ErrChromeNotFound
	}
	return f.path, nil
}
func (fakeEngine) InstallHint() string {
	return "Google Chrome 을 설치하세요: https://www.google.com/chrome/"
}
func (fakeEngine) StartPiped(platform.PipedSpec) (*platform.PipedProcess, error) {
	return nil, errors.New("fake")
}
func (fakeEngine) ModIsMeta() bool { return false }

// peerEngine 은 가짜 피어다 — pipe 너머에서 Browser.getVersion 에 product 로 답한다 (TC-BRT-3).
type peerEngine struct{ product string }

func (peerEngine) Find() (string, error) { return "/fake/chrome", nil }
func (peerEngine) InstallHint() string   { return "" }
func (peerEngine) ModIsMeta() bool       { return false }
func (e peerEngine) StartPiped(platform.PipedSpec) (*platform.PipedProcess, error) {
	toR, toW := io.Pipe()
	fromR, fromW := io.Pipe()
	done := make(chan struct{})
	var once sync.Once
	stop := func() error {
		once.Do(func() { close(done); toR.Close(); fromW.Close() })
		return nil
	}
	go func() {
		br := bufio.NewReader(toR)
		for {
			line, err := br.ReadBytes(0)
			if err != nil {
				stop()
				return
			}
			var req struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
			}
			json.Unmarshal(line[:len(line)-1], &req)
			res := map[string]any{}
			if req.Method == "Browser.getVersion" {
				res = map[string]any{"product": e.product, "protocolVersion": "1.3"}
			}
			b, _ := json.Marshal(map[string]any{"id": req.ID, "result": res})
			fromW.Write(append(b, 0))
		}
	}()
	return platform.NewPipedProcess(toW, fromR, 4242, func() error { <-done; return nil }, stop), nil
}
