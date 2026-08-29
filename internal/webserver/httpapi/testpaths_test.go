package httpapi

import (
	"encoding/json"

	"dongminal/internal/shared/testpath"
)

// 테스트가 쓰는 절대경로다. 리터럴("/tmp/repo")을 쓰면 **Windows 에서
// 절대경로가 아니게 되어** 경로 가드에 걸린다 — 이 저장소의 가드는
// filepath.IsAbs 를 쓰고, 그것은 OS 의존이다
// (WINDOWS_TEST_PARITY_SRS §2.2, FR-WTP-10).
//
// 입력과 기대값을 **같은 함수**로 만드는 것이 요점이다 (FR-WTP-12) —
// 한쪽만 바꾸면 Windows 에서 다시 어긋난다.
var (
	absRepo = testpath.Abs("repo")
)

// jsonQ 는 값을 **JSON 문자열 리터럴로** 만든다 — 따옴표까지 포함한다.
//
// 테스트가 경로를 담은 본문을 문자열 결합으로 만들 때 이것을 거쳐야 한다
// (FR-WTP-20). Windows 경로를 날것으로 끼우면 `C:\Users` 의 `\U` 가 유효하지
// 않은 JSON 이스케이프가 되어 본문 전체가 깨진다.
func jsonQ(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

var (
	qRepo = jsonQ(absRepo)
)
