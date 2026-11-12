package httpapi

import (
	"sync"
	"time"
)

// browserInputs 는 PC 브라우저가 도구마다 마지막으로 입력한 시각이다
// (TELEGRAM_BRIDGE_SRS FR-TGB-53). 터미널 질의 답(DA·CPR·포커스 보고)도 OpInput 으로
// 오지만 사람이 그 창 앞에 있다는 뜻이므로 함께 센다. 메모리에만 둔다.
type browserInputs struct {
	mu sync.Mutex
	at map[string]time.Time
}

func (b *browserInputs) mark(toolID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.at == nil {
		b.at = map[string]time.Time{}
	}
	b.at[toolID] = time.Now()
}

func (b *browserInputs) last(toolID string) time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.at[toolID]
}

// LastBrowserInput 은 PC 브라우저에서 그 도구에 마지막으로 입력한 시각이다. 없으면 영값.
func (s *Server) LastBrowserInput(toolID string) time.Time {
	return s.browserIn.last(toolID)
}
