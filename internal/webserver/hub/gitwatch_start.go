package hub

import (
	"context"
	"time"
)

// 감시 시동 — 회차를 도는 고루틴 하나 (FR-GPO-13).

/*
StartGitWatch 는 회차를 도는 주체다 (FR-GPO-13).

대상이 없어도 티커는 돈다. 멈췄다 켜는 대신 빈 순회를 하는 이유는, 시작·정지의
경합을 다루는 비용이 500ms 마다의 빈 순회보다 크기 때문이다 — 빈 순회는 맵
하나를 잠그고 길이를 보는 일이다.
*/
func StartGitWatch(w *GitWatcher, stopCh <-chan struct{}) {
	if w == nil {
		return
	}
	go func() {
		t := time.NewTicker(GitWatchInterval)
		defer t.Stop()
		/*
			FR-GDT-10 (`GO-33`): **종료가 진행 중인 회차를 취소한다.**

			  이전 동작: `context.Background()` — 종료 신호가 와도 이미 뜬
			            `git status` 는 끝까지 돌았고, 개별 회차에 시한도 없었다
			  새  동작: 뿌리 컨텍스트를 `stopCh` 에 묶고, 회차마다 그 아래에
			            시한을 건다
			  이유:     `01-go-arch.md GO-33` 이 지적한 그 줄이며, `11 GP-8` 이
			            같은 자리를 감지 비용 쪽에서 다시 지목했다
		*/
		root, cancelRoot := context.WithCancel(context.Background())
		defer cancelRoot()
		w.mu.Lock()
		w.root = root
		w.mu.Unlock()
		go func() {
			<-stopCh
			cancelRoot()
		}()
		for {
			select {
			case <-t.C:
				ctx, cancel := context.WithTimeout(root, GitWatchRoundTimeout)
				w.Tick(ctx)
				cancel()
			case <-stopCh:
				return
			}
		}
	}()
}
