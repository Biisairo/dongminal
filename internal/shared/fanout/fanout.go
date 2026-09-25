// Package fanout 은 상한 있는 병렬 반복 한 벌이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-7-4).
//
// git 핀 관측·핀 목록 조립·감시 회차가 같은 `세마포어 + WaitGroup` 을 각자 적고
// 있었다. 한 벌이어야 "몇 개까지 한꺼번에 띄울 것인가" 의 규칙이 갈라지지 않는다.
package fanout

import (
	"context"
	"sync"
)

// Each 는 i ∈ [0, n) 마다 fn(i) 를 부르되 동시에 도는 것은 limit 개까지다.
//
// ctx 가 끝나면 **남은 것을 시작하지 않는다.** 이미 시작한 것은 끝까지 기다린다 —
// 반환 뒤에 fn 이 도는 일은 없다. limit 이 1 보다 작으면 1 이다.
func Each(ctx context.Context, limit, n int, fn func(i int)) {
	sem := make(chan struct{}, max(limit, 1))
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		// 자리를 얻은 **뒤에** 본다 — 자리를 기다리는 동안 끝난 ctx 도 잡는다.
		sem <- struct{}{}
		if ctx.Err() != nil {
			<-sem
			break
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}
