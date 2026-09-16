package toolhub

import "fmt"

// ExitInfo 는 도구 프로세스가 끝난 사정이다. Code 는 종료 코드다 — 신호로 죽었으면
// -1, 모르면 0. 두 모드가 같은 모양을 나른다: 직접 모드는 ExitObserver 의 인자,
// 데몬 모드는 `exit` push 의 `code`.
type ExitInfo struct {
	Code int `json:"code"`
}

// String 은 사람이 읽을 한 줄이다 — 뷰가 그대로 보인다. 비어 있으면 "".
func (e ExitInfo) String() string {
	if e.Code == 0 {
		return ""
	}
	return fmt.Sprintf("exit %d", e.Code)
}
