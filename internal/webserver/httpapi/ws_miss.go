package httpapi

import (
	"context"
	"log"
	"sync"
	"time"

	"dongminal/internal/shared/toolhub"
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

// CONNECTIVITY_RESILIENCE_SRS 묶음 A — 폭주의 **종식**.
//
// 위의 지연은 규모를 30배 낮췄으나 멎히지는 못했다 (§2.1: 초당 95 → 3). 이유는
// 하나다 — `onclose` 가 클라이언트에서 재연결의 유일한 계기이므로, **소켓을 닫는
// 한 재연결은 반드시 다시 온다.** 지연은 주기를 늘릴 뿐이고, 거절은 오히려
// 주기를 줄인다(옛 탭의 백오프는 자라지 못한다). 고리를 끊는 자리는 닫지 않는
// 것 하나뿐이다 (D-2).
//
// 이것은 D-6 을 뒤집지 않는다 — `OpExit` 은 **여전히 보낸다** (D-1).
const (
	// MissHoldAfter 는 붙잡기로 넘어가는 창 안 횟수다. 규약을 지키는
	// 클라이언트는 첫 통보 한 번으로 판정을 끝내므로 여기에 닿지 않는다.
	MissHoldAfter = 5

	// MissHoldMax 는 한 연결을 붙잡아 두는 최대 시간이다. 사람이 탭을 닫을
	// 시간이면 충분하다.
	MissHoldMax = 10 * time.Minute

	// MissHoldLimit 은 동시에 붙잡는 연결의 상한이다. 상한이 없으면 방어가
	// 새로운 고갈이 된다 (FR-CNR-4).
	MissHoldLimit = 64
)

// missTracker 는 도구 id 별 마지막 미스 시각과 창 안 횟수다. 제로값이 곧 빈
// 추적기이므로 생성자가 없다 — Server 의 필드로 그대로 쓴다.
type missTracker struct {
	mu   sync.Mutex
	last map[string]time.Time
	// FR-CNR-1: 창 안의 횟수. 마지막 시각만으로는 "되풀이인가" 밖에 답하지
	// 못해 임계를 둘 수 없다.
	hits map[string]int
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
	m.prune(now)
	m.last[toolID] = now
	return seen && now.Sub(prev) <= MissRepeatWindow
}

// count 는 창 안에서 toolID 가 몇 번째 미스인지 답하고 시각을 갱신한다
// (FR-CNR-1). 창을 지나 다시 온 것은 1 이다 — 오래 뒤의 정상 요청이 옛 폭주의
// 횟수를 물려받지 않는다.
func (m *missTracker) count(toolID string, now time.Time) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last == nil {
		m.last = map[string]time.Time{}
	}
	if m.hits == nil {
		m.hits = map[string]int{}
	}
	prev, seen := m.last[toolID]
	fresh := seen && now.Sub(prev) <= MissRepeatWindow
	m.prune(now)
	n := 1
	if fresh {
		n = m.hits[toolID] + 1
	}
	m.last[toolID] = now
	m.hits[toolID] = n
	return n
}

// prune 은 창을 지난 항목을 버린다 (FR-RCS-9c). 폭주 중에는 같은 몇 개의 id 만
// 오가므로 맵이 작고, 이 훑기는 미스 경로에서만 돈다.
//
// 호출자가 자물쇠를 쥔 상태로 부른다.
func (m *missTracker) prune(now time.Time) {
	for id, t := range m.last {
		if now.Sub(t) > MissRepeatWindow {
			delete(m.last, id)
			delete(m.hits, id)
		}
	}
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

// holdMiss 는 임계를 넘은 도구의 연결을 **붙잡는다** (FR-CNR-2·3·4·6).
//
// 돌아오면 호출자는 소켓을 닫는다. 그러므로 **여기서 돌아오지 않는 동안이 곧
// 소켓이 열려 있는 시간**이고, 그 사이 클라이언트에는 `onclose` 가 서지 않아
// 재연결의 계기가 없다 (D-2).
//
// **읽기가 필요한 이유** (FR-CNR-6 개정). upgrade 로 hijack 된 뒤에는
// `r.Context()` 가 클라이언트 절단으로 취소되지 **않는다** — net/http 가 그
// 연결을 더는 관리하지 않기 때문이다. 실측으로 확인했다: curl 이 끊은 뒤에도
// `hold=4` 가 그대로였다. 읽기만이 절단을 알려주므로, 붙잡는 동안 읽되 내용은
// 버린다. 그러지 않으면 닫힌 탭이 10분씩 자리를 먹고 상한(64)이 차서 방어가
// 무력해진다.
//
// conn 이 nil 이면 읽지 않는다 — 붙잡기의 시간·상한 규칙만 시험하는 테스트가
// 소켓 없이 부른다.
//
// true 는 "붙잡았다" 이고 false 는 "임계 이하이거나 자리가 없다" 이다. 어느
// 쪽이든 호출자의 다음 동작은 같다 — 이 값은 로그와 검사를 위한 것이다.
func (s *Server) holdMiss(ctx context.Context, toolID string, conn *toolhub.SafeConn) bool {
	if s.misses.count(toolID, time.Now()) < MissHoldAfter {
		return false
	}
	// FR-CNR-4: 상한을 넘으면 붙잡지 않고 종전 동작으로 내려간다. 먼저 늘린 뒤
	// 넘었으면 되돌린다 — 검사와 증가 사이의 창을 없애는 것이 두 연산을 나누는
	// 것보다 싸다.
	if n := s.holds.Add(1); n > MissHoldLimit {
		s.holds.Add(-1)
		return false
	}
	defer s.holds.Add(-1)

	// FR-CNR-7: 이 방어가 언제 몇 개를 붙잡았는지가 §2.1 의 지표와 함께 읽혀야 한다.
	log.Printf("ws hold tool=%s held=%d", toolID, s.holds.Load())
	t := time.NewTimer(MissHoldMax)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	case <-connGone(conn):
	}
	log.Printf("ws hold released tool=%s held=%d", toolID, s.holds.Load()-1)
	return true
}

// connGone 은 연결이 끊기면 닫히는 채널을 준다. 읽은 것은 버린다 — 도구가
// 없으므로 오는 것에 뜻이 없고, 우리가 알고 싶은 것은 **읽기가 실패하는 순간**
// 하나다.
//
// conn 이 nil 이면 영영 닫히지 않는 채널이다. 고루틴도 만들지 않는다.
func connGone(conn *toolhub.SafeConn) <-chan struct{} {
	if conn == nil {
		return nil
	}
	ch := make(chan struct{})
	go func() {
		defer close(ch)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	return ch
}
