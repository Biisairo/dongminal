package httpapi

import (
	"net/http"
	"testing"
)

// RUN_ORCHESTRATION_SRS FR-STA-9 — 동시 대기 상한.
//
// 대기 하나가 서버를 최대 30분 붙잡는다 (FR-STA-2). 상한이 없으면 스크립트 하나가
// 그 자원을 전부 가져가는데, 그것은 공격이 아니라 **루프가 잘못 도는
// 오케스트레이션**으로도 일어난다.

// TC-STA-9a: 상한을 넘는 대기는 429 다.
func TestApiToolStatusWait_OverConcurrencyIs429(t *testing.T) {
	s, _, _ := statusServer(t)
	waitInFlight.Store(waitMaxConcurrent)
	t.Cleanup(func() { waitInFlight.Store(0) })

	code, out := getWait(t, s, "id=p1&for=ready&timeout-ms=100")
	if code != http.StatusTooManyRequests {
		t.Fatalf("code=%d want 429 out=%+v", code, out)
	}
}

// TC-STA-9b: 끝난 대기는 자리를 **돌려준다.** 돌려주지 않으면 상한은 하루 만에
// 영구 거절이 된다 — 누수는 상한 자체보다 나쁘다.
func TestApiToolStatusWait_ReleasesSlot(t *testing.T) {
	s, _, p := statusServer(t)
	p.SetActivity("idle", "", "")

	if code, out := getWait(t, s, "id=p1&for=ready&timeout-ms=100"); code != http.StatusOK {
		t.Fatalf("code=%d out=%+v", code, out)
	}
	if n := waitInFlight.Load(); n != 0 {
		t.Fatalf("대기가 끝났는데 자리가 %d 개 잡혀 있다", n)
	}
}

// 기본값을 지킨다 — 위 테스트가 카운터를 만지므로 그 관례가 값의 회귀를 가릴 수 있다.
func TestWaitMaxConcurrentDefault(t *testing.T) {
	if waitMaxConcurrent != 32 {
		t.Fatalf("상한=%d want 32 (FR-STA-9, 2026-09-11 판정)", waitMaxConcurrent)
	}
}
