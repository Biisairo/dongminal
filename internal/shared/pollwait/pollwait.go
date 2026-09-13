// Package pollwait 는 "조건이 설 때까지 묻는" 대기 한 벌이다 (M8 D-A-15, GO-27).
//
// 요청 경로(httpapi 의 승계·정리·부착 대기)·데몬 소켓 대기·`start` 의 준비 대기·
// `stop` 의 종료 대기가 전부 이것을 지난다. 종전에는 넷이 각자 `time.Sleep` 루프를
// 적었고, 그중 요청 경로의 것은 ctx 를 보지 않아 끊긴 요청 뒤에도 부작용을 이어
// 갔다 (`GO-12`). 기다리는 것은 시간이 아니라 **사실**이고, 사실이 서면 곧 돌아온다.
package pollwait

import (
	"context"
	"errors"
	"time"
)

// ErrTimeout 은 상한 안에 조건이 서지 않았다는 뜻이다. ctx 가 먼저 끝나면 그
// 오류(`context.Canceled` 등)가 대신 돌아온다 — 둘은 다른 사실이다: 전자는
// "오지 않았다" 이고 후자는 "묻는 쪽이 사라졌다" 다.
var ErrTimeout = errors.New("wait: timeout")

// Until 은 cond 가 참이 될 때까지 every 간격으로 묻는다 — 최대 max 동안.
//
// **ctx 가 끝나면 즉시 돌아온다.** 조건은 먼저 한 번 묻고, 그 뒤 every 마다 묻는다.
// 남은 시간이 every 보다 짧으면 그만큼만 기다린다 — 아주 짧은 상한을 준 호출자가
// 폴링 간격만큼 붙들리면 상한이 상한 노릇을 못 한다.
func Until(ctx context.Context, max, every time.Duration, cond func() bool) error {
	deadline := time.Now().Add(max)
	timer := time.NewTimer(0)
	defer timer.Stop()
	if !timer.Stop() {
		<-timer.C
	}
	for {
		if cond() {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return ErrTimeout
		}
		if remaining > every {
			remaining = every
		}
		timer.Reset(remaining)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
