package runtime

import (
	"encoding/json"
	"path/filepath"
)

// jsonInner 는 값이 **JSON 안에 적혔을 때의 모습**을 준다 — 바깥 따옴표는 뺀다.
//
// 훅 파일의 원문에서 경로를 찾을 때 날것으로 비교하면 안 된다 (FR-WTP-20).
// Windows 경로 `C:\Users\x` 는 JSON 안에서 `C:\\Users\\x` 로 적히므로,
// 원문 대조는 언제나 어긋난다.
func jsonInner(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b[1 : len(b)-1])
}

// helperFile 은 설치된 헬퍼의 **파일 이름**이다. 설치는 확장자를 붙여 깔므로
// (install.go 의 installHelpers) 테스트도 같은 규칙으로 찾아야 한다.
func helperFile(name string) string { return filepath.Base(dmctlLike(name)) }

func dmctlLike(name string) string { return filepath.Join(".", name+exeSuffixForTest()) }
