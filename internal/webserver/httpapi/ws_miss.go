package httpapi

import (
	"context"
	"sync"
	"time"
)

// RECONNECT_STORM_SRS 묶음 S — 없는 도구를 되풀이해 부르는 연결의 봉쇄.
//
// 왜 서버가 이것을 하는가. 원인은 클라이언트에 있고 FR-RCS-1·3·6 이 그것을
// 고쳤다. 그러나 **배포된 클라이언트 수정은 이미 열려 있는 탭에 닿지 않는다** —
// 그 탭은 스스로 회복하지 않고, 사람이 찾아 닫기 전까지 무한히 부하를 만든다
// (실측: 수정 배포·서버 재기동 뒤에도 옛 탭 둘이 초당 217연결). 웹 클라이언트를
// 가진 배포의 항구적 조건이며, 서버만이 그 자리에 있을 수 있다 (D-5 철회).
//
// 거절이 아니라 지연인 이유는 D-6 이다 — upgrade 를 막으면 규약을 지키는
// 클라이언트도 `OpExit` 을 받지 못해 "도구가 사라졌다"는 판정을 세울 수 없다.
// 바르게 행동하는 쪽을 망가뜨려 잘못 행동하는 쪽을 막지 않는다.

const (
	// MissRepeatWindow 는 "되풀이"로 볼 간격이다. 이 창을 지나 다시 온 요청은
	// 첫 미스로 되돌아간다 — 오래 뒤의 정상 요청을 벌하지 않는다.
	MissRepeatWindow = 10 * time.Second

	// MissDelay 는 되풀이된 미스를 늦추는 시간이다. 폭주 실측이 도구당 초당
	// 24연결이었으므로 이 값이 그것을 0.5연결로 내린다 (약 50배).
	MissDelay = 2 * time.Second
)

// missTracker 는 도구 id 별 마지막 미스 시각이다. 제로값이 곧 빈 추적기이므로
// 생성자가 없다 — Server 의 필드로 그대로 쓴다.
type missTracker struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// repeat 는 toolID 가 MissRepeatWindow 안에 이미 미스로 기록됐는지 알리고,
// 시각을 now 로 갱신한다. 첫 미스면 false 다 (FR-RCS-9a).
//
// now 를 인자로 받는 이유는 시간을 검사 가능하게 두기 위해서다 — 창 경계를
// 실제 시계로 시험하면 테스트가 그 창만큼 느려지고 경계에서 흔들린다.
func (m *missTracker) repeat(toolID string, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last == nil {
		m.last = map[string]time.Time{}
	}
	prev, seen := m.last[toolID]
	// FR-RCS-9c: 창을 지난 항목을 버린다. 폭주 중에는 같은 몇 개의 id 만
	// 오가므로 맵이 작고, 이 훑기는 미스 경로에서만 돈다.
	for id, t := range m.last {
		if now.Sub(t) > MissRepeatWindow {
			delete(m.last, id)
		}
	}
	m.last[toolID] = now
	return seen && now.Sub(prev) <= MissRepeatWindow
}

// size 는 추적 중인 항목 수다 (FR-RCS-9c 의 검사용).
func (m *missTracker) size() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.last)
}

// throttleMiss 는 되풀이된 미스만 MissDelay 만큼 늦춘다. ctx 가 끝나면 즉시
// 돌아온다 (FR-RCS-9b) — 서버 종료가 지연에 발목잡히지 않는다.
func (s *Server) throttleMiss(ctx context.Context, toolID string) {
	if !s.misses.repeat(toolID, time.Now()) {
		return
	}
	t := time.NewTimer(MissDelay)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}
