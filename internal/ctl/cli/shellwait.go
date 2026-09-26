package cli

import (
	"errors"
	"time"
)

// shellQuietFor 는 "셸이 프롬프트를 그렸다" 로 볼 조건이다 — 출력이 오고 이만큼 조용하면
// 준비된 것으로 본다. 고정 대기를 쓰지 않는 이유는 대상마다 셸 기동 시간이 다르고
// 고정 대기가 실제로 플레이크를 냈기 때문이다 (FR-E2K-2). pwsh 는 PSReadLine 을 올리는
// 데 초 단위가 걸려, 300ms 뒤에 넣은 입력이 통째로 사라진 실측이 있다.
const shellQuietFor = 700 * time.Millisecond

// shellPoll 은 waitQuiet 가 다시 보는 간격이다. 검사가 낮춰 쓴다.
var shellPoll = 100 * time.Millisecond

var (
	// errNothingDrawn 은 limit 안에 아무 것도 그려지지 않았다는 뜻이다.
	errNothingDrawn = errors.New("셸이 아무 것도 그리지 않았다")
	// errNotQuiet 은 그린 것은 있으나 limit 안에 조용해지지 않았다는 뜻이다.
	errNotQuiet = errors.New("셸 출력이 조용해지지 않았다")
)

// waitQuiet 는 무언가 그려지고(n>0) 마지막 변화 뒤 quiet 만큼 지날 때까지 기다린다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-9-2 · SHR-18). snapshot 이 오류를 내면 그것을 그대로
// 돌려주며 멈춘다. limit 을 넘기면 errNothingDrawn 또는 errNotQuiet 이다 — 그것을
// 실패로 볼지는 호출자가 정한다.
func waitQuiet(snapshot func() (n int, lastChange time.Time, err error), limit, quiet time.Duration) error {
	deadline := time.Now().Add(limit)
	drawn := false
	for {
		n, last, err := snapshot()
		if err != nil {
			return err
		}
		if n > 0 {
			drawn = true
			if time.Since(last) >= quiet {
				return nil
			}
		}
		if !time.Now().Before(deadline) {
			if drawn {
				return errNotQuiet
			}
			return errNothingDrawn
		}
		time.Sleep(shellPoll)
	}
}

// changeTracker 는 폴링으로 얻은 화면의 마지막 변화 시각을 기억한다 — 스냅숏만 주는
// 출처(HTTP 조회·스트림 사본)를 waitQuiet 의 snapshot 으로 옮긴다.
type changeTracker struct {
	last string
	at   time.Time
}

func (c *changeTracker) observe(s string) (int, time.Time) {
	if s != c.last {
		c.last, c.at = s, time.Now()
	}
	return len(c.last), c.at
}
