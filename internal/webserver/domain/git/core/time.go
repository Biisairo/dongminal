package core

import (
	"strconv"
	"strings"
)

// unixSecToMilli 는 초를 ms 로 옮기는 배수다. 상수로 못박는다 — 자리마다 1000 이
// 흩어지면 무엇이 초이고 무엇이 ms 인지 읽을 수 없다.
const unixSecToMilli = 1000

// UnixSecToMilli 는 %at·%ct 의 초를 ms 로 옮긴다. 읽지 못하면 0 이다 — 시각이 없는
// 커밋은 있을 수 없지만, 그 사실이 목록을 못 보일 이유는 아니다.
func UnixSecToMilli(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return n * unixSecToMilli
}
