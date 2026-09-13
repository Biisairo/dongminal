package dmenv

import (
	"os"
	"strconv"
	"time"
)

// 이 파일은 **운영 튜닝 변수**의 이름과 읽는 규칙이다 (M8 `GO-41`). 종전에는
// 셋이 `toolhub`·`hub` 에 흩어져 각자 파싱했다 — 규칙(빈 값·정수 아님·범위 밖
// 이면 기본값)이 세 벌이면 한 벌만 고쳐진다.

const (
	// EnvAttentionIdleMS 는 L2 유휴 알람의 문턱(ms)이다. 0 이면 L2 를 끈다.
	EnvAttentionIdleMS = "DONGMINAL_ATTENTION_IDLE_MS"
	// EnvAttentionBell 은 맨 BEL 을 주의 신호로 볼지다 — "1" 이면 켠다.
	EnvAttentionBell = "DONGMINAL_ATTENTION_BELL"
	// EnvCmdResultTimeoutMS 는 커맨드 결과 long-poll 의 상한(ms)이다 (NFR-RCR-1).
	EnvCmdResultTimeoutMS = "DONGMINAL_CMD_RESULT_TIMEOUT_MS"
)

// MillisEnv 는 밀리초 정수 변수를 읽는다. 비었거나 정수가 아니거나 min 미만이면
// def 다 — 잘못 준 값이 조용히 0 이 되지 않는다.
func MillisEnv(name string, def time.Duration, min int) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min {
		return def
	}
	return time.Duration(n) * time.Millisecond
}

// FlagEnv 는 "1" 일 때만 참이다. 다른 값은 전부 거짓 — 켜는 값은 하나다.
func FlagEnv(name string) bool { return os.Getenv(name) == "1" }
