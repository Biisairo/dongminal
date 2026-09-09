package platform

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// errSnapFail 은 조회 실패를 흉내 내는 표지다. 테스트 전용이므로 여기 산다.
var errSnapFail = errors.New("snapshot failed")

// Windows 의 프로세스 조회는 짧은 수명의 캐시를 지난다
// (HOST_PARITY_SRS 묶음 D-2, FR-HPR-12·13).
//
// 종전에는 `HasChildren` 이 부를 때마다 전체 프로세스를 열거했다. 유휴 감시가
// 1초마다 도구 수만큼 부르므로 도구 20개면 초당 20회 전수 열거였다 (§2.4).
//
// build tag 가 없다 — 캐시의 판단은 OS API 가 아니므로 어느 호스트에서도
// 검증된다 (platform 패키지 머리말 §4.2).

func TestSnapCacheServesWithinTTL(t *testing.T) {
	// V-HPR-8
	calls := 0
	now := time.Unix(0, 0)
	c := &snapCache{
		ttl: 2 * time.Second,
		now: func() time.Time { return now },
		load: func() ([]procEntry, error) {
			calls++
			return []procEntry{{pid: 1, ppid: 0, name: "init"}}, nil
		},
	}
	if _, err := c.get(); err != nil {
		t.Fatal(err)
	}
	now = now.Add(1900 * time.Millisecond)
	if _, err := c.get(); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("스냅샷을 %d 번 떴다 — 수명 안에서는 한 번이어야 한다", calls)
	}
	now = now.Add(200 * time.Millisecond)
	if _, err := c.get(); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("수명이 지났는데 다시 뜨지 않았다 (calls=%d)", calls)
	}
}

// 실패는 캐시하지 않는다 — 한 번의 실패가 수명 내내 이어지면 안 된다.
func TestSnapCacheDoesNotCacheFailure(t *testing.T) {
	calls := 0
	now := time.Unix(0, 0)
	c := &snapCache{
		ttl: 2 * time.Second,
		now: func() time.Time { return now },
		load: func() ([]procEntry, error) {
			calls++
			if calls == 1 {
				return nil, errSnapFail
			}
			return []procEntry{{pid: 7}}, nil
		},
	}
	if _, err := c.get(); err == nil {
		t.Fatal("첫 조회는 실패해야 한다")
	}
	got, err := c.get()
	if err != nil {
		t.Fatalf("두 번째 조회가 실패를 물려받았다: %v", err)
	}
	if len(got) != 1 || got[0].pid != 7 {
		t.Fatalf("got = %v", got)
	}
}

// 동시에 들어온 조회가 스냅샷을 겹쳐 뜨지 않는다 (FR-HPR-13).
func TestSnapCacheSingleFlight(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	now := time.Unix(0, 0)
	c := &snapCache{
		ttl: time.Second,
		now: func() time.Time { return now },
		load: func() ([]procEntry, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			time.Sleep(10 * time.Millisecond)
			return []procEntry{{pid: 1}}, nil
		},
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.get()
		}()
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("스냅샷을 %d 번 떴다 — 겹쳐 뜨면 안 된다", calls)
	}
}
