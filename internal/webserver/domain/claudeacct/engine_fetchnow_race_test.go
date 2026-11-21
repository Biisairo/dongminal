package claudeacct

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-50: 겹친 새로 고침은 한 번만 조회한다.
// 이전에는 간격 검사를 busy 잠금 밖에서 해, 둘 다 통과한 뒤 차례로 조회했다.
func TestEngineFetchNowOverlapFetchesOnce(t *testing.T) {
	e, eng, api := newEngineEnv(t)
	clockAt(e, eng)
	eng.busy.Lock() // 주기 조회가 도는 중인 것처럼 둘을 잠금 앞에 세운다
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = eng.FetchNow(context.Background(), "id1")
		}(i)
	}
	time.Sleep(100 * time.Millisecond)
	eng.busy.Unlock()
	wg.Wait()

	if n := api.count("usage:at-a"); n != 1 {
		t.Fatalf("조회 %d번 want 1: %v", n, api.calls)
	}
	tooSoon := 0
	for _, err := range errs {
		if errors.Is(err, ErrTooSoon) {
			tooSoon++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if tooSoon != 1 {
		t.Fatalf("ErrTooSoon %d건 want 1: %v", tooSoon, errs)
	}
}
