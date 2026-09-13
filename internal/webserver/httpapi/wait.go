package httpapi

import (
	"context"
	"errors"
	"time"
)

// errWaitTimeout 은 상한 안에 조건이 서지 않았다는 뜻이다. ctx 가 먼저 끝나면
// 그 오류(`context.Canceled` 등)가 대신 돌아온다 — 둘은 다른 사실이다: 전자는
// "오지 않았다" 이고 후자는 "묻는 쪽이 사라졌다" 다.
var errWaitTimeout = errors.New("wait: timeout")

// pollUntil 은 cond 가 참이 될 때까지 every 간격으로 묻는다 — 최대 max 동안.
//
// **ctx 가 끝나면 즉시 돌아온다** (M8 `GO-12` · FBE-01 서버측). 종전의 대기는
// `time.Sleep` 위에 있어 요청이 끊겨도(dmctl 의 시한, 브라우저의 이탈) 서버는
// 상한까지 자고 나서 부작용(승계·정리)을 이어 갔다 — 실패로 보고된 승계가 실제로는
// 성공해 있고 재시도가 멤버를 이중으로 만드는 것이 그 결과였다. 요청 경로의
// 대기는 전부 이 함수를 지난다 (`handlers_status.go` 의 `wait` 가 본이다).
//
// 조건은 먼저 한 번 묻고, 그 뒤 every 마다 묻는다. 남은 시간이 every 보다 짧으면
// 그만큼만 기다린다 — 아주 짧은 상한을 준 호출자가 폴링 간격만큼 붙들리면 상한이
// 상한 노릇을 못 한다.
func pollUntil(ctx context.Context, max, every time.Duration, cond func() bool) error {
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
			return errWaitTimeout
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
