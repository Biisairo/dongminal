package httpapi

import (
	"context"
	"time"

	"dongminal/internal/shared/browser"
)

// 느린 링크에 프레임을 맞춘다 (BROWSER_TAB_SRS FR-BRT-94·95, D-BRT-22).
const (
	// frameInflightMax 는 뷰어가 확인하지 않은 프레임의 상한이다.
	frameInflightMax = 2
	qualityStep      = 10
	// qualityMinFPS 아래로 떨어진 채 기다렸으면 품질을 내린다.
	qualityMinFPS  = 30
	qualityTick    = time.Second
	qualityDownGap = time.Second
	qualityUpGap   = 5 * time.Second
)

// qualityCtl 은 탭 하나의 screencast 품질 결정이다. 뷰어마다 1초에 한 번 tick 한다.
type qualityCtl struct {
	q       int
	changed time.Time
	waited  time.Time
}

func newQualityCtl(now time.Time) *qualityCtl {
	return &qualityCtl{q: browser.QualityMax, changed: now}
}

// tick 은 한 뷰어의 지난 1초다 — waited 는 확인을 기다리느라 프레임을 들고 있었는가,
// sent 는 그동안 보낸 프레임 수. 품질이 바뀌었으면 true.
func (c *qualityCtl) tick(now time.Time, waited bool, sent int) bool {
	if waited {
		c.waited = now
		if sent < qualityMinFPS && c.q > browser.QualityMin && now.Sub(c.changed) >= qualityDownGap {
			c.q = max(browser.QualityMin, c.q-qualityStep)
			c.changed = now
			return true
		}
		return false
	}
	if c.q < browser.QualityMax && now.Sub(c.waited) >= qualityUpGap && now.Sub(c.changed) >= qualityUpGap {
		c.q = min(browser.QualityMax, c.q+qualityStep)
		c.changed = now
		return true
	}
	return false
}

// startQuality 는 탭의 첫 뷰어에서 품질을 처음으로 되돌린다 (FR-BRT-95).
func (h *browserHub) startQuality(ctx context.Context, tab string) {
	h.mu.Lock()
	if h.quality == nil {
		h.quality = map[string]*qualityCtl{}
	}
	h.quality[tab] = newQualityCtl(time.Now())
	h.mu.Unlock()
	h.host.Call(ctx, "quality", map[string]any{"tab": tab, "q": browser.QualityMax})
}

// qualityLoop 는 받음을 확인하는 뷰어 하나의 1초 결산이다.
func (h *browserHub) qualityLoop(tab string, v *browserViewer, done <-chan struct{}) {
	tk := time.NewTicker(qualityTick)
	defer tk.Stop()
	for {
		select {
		case <-done:
			return
		case now := <-tk.C:
			v.mu.Lock()
			waited, sent := v.waited, v.sent
			v.waited, v.sent = false, 0
			v.mu.Unlock()
			h.mu.Lock()
			c := h.quality[tab]
			changed := c != nil && c.tick(now, waited, sent)
			q := 0
			if changed {
				q = c.q
			}
			h.mu.Unlock()
			if changed {
				h.host.Call(context.Background(), "quality", map[string]any{"tab": tab, "q": q})
			}
		}
	}
}

// frameAcked 는 뷰어의 받음 확인이다 (FR-BRT-94).
func (v *browserViewer) frameAcked() {
	v.mu.Lock()
	if v.inflight > 0 {
		v.inflight--
	}
	v.mu.Unlock()
	v.signal()
}
