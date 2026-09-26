package cdp

import (
	"encoding/json"
	"errors"
)

// ErrSwallow 는 "보내지 않고 빈 성공으로 답한다" 는 표식이다.
var ErrSwallow = errors.New("cdp: swallowed")

// ExternalFilter 는 CDP 프록시로 붙은 외부 도구의 요청을 거른다 (FR-BRT-24).
// 수명·다운로드·파일 선택·남의 임시 컨텍스트는 매니저가 소유한다.
func ExternalFilter(c *Conn, m *Message) error {
	switch m.Method {
	case "Browser.close", "Browser.crash", "Browser.crashGpuProcess":
		return errors.New(m.Method + " 은 dongminal 이 소유합니다 — 탭을 닫으세요")
	case "Browser.setDownloadBehavior":
		// Playwright 는 컨텍스트마다 이것을 부르고 실패하면 컨텍스트를 만들지 못한다 —
		// 보내지 않고 성공으로 답한다. 다운로드 경로는 dongminal 이 소유한다 (FR-BRT-80).
		return ErrSwallow
	case "Page.setInterceptFileChooserDialog":
		var p struct {
			Enabled bool `json:"enabled"`
		}
		if json.Unmarshal(m.Params, &p) == nil && !p.Enabled {
			// 가로채기는 dongminal 이 켜 둔다 (FR-BRT-81) — 끄는 요청은 삼킨다.
			return ErrSwallow
		}
	case "Target.disposeBrowserContext":
		var p struct {
			BrowserContextID string `json:"browserContextId"`
		}
		if json.Unmarshal(m.Params, &p) != nil || !c.OwnsContext(p.BrowserContextID) {
			return errors.New("다른 클라이언트가 만든 컨텍스트는 없앨 수 없습니다")
		}
	}
	return nil
}
