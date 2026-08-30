// Package testpath 는 테스트가 OS 마다 달라지는 전제를 **분기 없이** 다루게
// 한다 (WINDOWS_TEST_PARITY_SRS FR-WTP-10·11).
//
// 왜 일반 패키지인가: `_test.go` 안에 둔 도우미는 그 패키지 밖으로 나가지
// 않는다. 이 도우미가 필요한 곳이 12개 패키지에 걸쳐 있으므로 공유 가능한
// 자리여야 한다. 프로덕션 코드는 이 패키지를 쓰지 않는다.
//
// 왜 `runtime.GOOS` 를 쓰지 않는가: 그것은 `scripts/check-seams.sh` 가 금지하는
// 분기이고(CROSS_PLATFORM_SRS FR-XBD-3), 금지의 취지는 테스트에도 그대로
// 적용된다 — OS 이름으로 가르기 시작하면 대상이 늘 때마다 갈래가 는다.
package testpath

import (
	"encoding/json"
	"path/filepath"
	"sync"
)

// volumeRoot 는 이 호스트에서 절대경로가 시작하는 자리다.
//
//	POSIX    "/"
//	Windows  "C:\"   (현재 볼륨)
//
// `filepath.Abs(string(filepath.Separator))` 한 번으로 둘 다 얻는다 — Windows
// 에서 `\work\repo` 는 **절대경로가 아니다**(볼륨이 없다). 그것이 이 패키지가
// 있는 이유이자, 테스트가 `"/work/repo"` 리터럴을 쓰다 깨진 이유다.
var volumeRoot = sync.OnceValue(func() string {
	root, err := filepath.Abs(string(filepath.Separator))
	if err != nil {
		return string(filepath.Separator)
	}
	return root
})

// Abs 는 조각들을 이어 **OS 형태의 절대경로**를 만든다.
//
//	testpath.Abs("work", "repo")
//	  POSIX    /work/repo
//	  Windows  C:\work\repo
//
// 실재하지 않아도 된다 — 이 패키지는 경로를 만들 뿐 파일시스템을 보지 않는다.
func Abs(seg ...string) string {
	return filepath.Join(append([]string{volumeRoot()}, seg...)...)
}

// Root 는 볼륨 루트 자신이다. "파일시스템 루트" 를 거부하는지 보는 테스트가 쓴다.
func Root() string { return volumeRoot() }

// JSONQuote 는 값을 **JSON 문자열 리터럴로** 만든다 — 바깥 따옴표까지 포함한다.
//
// 테스트가 경로를 담은 본문을 문자열 결합으로 만들 때 이것을 거쳐야 한다
// (WINDOWS_TEST_PARITY_SRS FR-WTP-20). Windows 경로를 날것으로 끼우면
// `C:\Users` 의 `\U` 가 유효하지 않은 JSON 이스케이프가 되어 본문 전체가
// 깨진다 — 오류가 파싱 단계에서 나므로 정작 검사하려던 것은 시작도 못 한다.
func JSONQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err) // string 은 marshal 에 실패하지 않는다
	}
	return string(b)
}

// JSONInner 는 값이 **JSON 안에 적혔을 때의 모습**이다 — 바깥 따옴표는 뺀다.
// 응답이나 파일의 원문에서 경로를 찾을 때 쓴다. 날것으로 대조하면 Windows 의
// 백슬래시가 이스케이프돼 있어 언제나 어긋난다.
func JSONInner(s string) string {
	q := JSONQuote(s)
	return q[1 : len(q)-1]
}
