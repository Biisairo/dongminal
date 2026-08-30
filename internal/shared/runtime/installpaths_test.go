package runtime

import (
	"path/filepath"
)

// helperFile 은 설치된 헬퍼의 **파일 이름**이다. 설치는 확장자를 붙여 깔므로
// (install.go 의 installHelpers) 테스트도 같은 규칙으로 찾아야 한다.
func helperFile(name string) string { return filepath.Base(dmctlLike(name)) }

func dmctlLike(name string) string { return filepath.Join(".", name+exeSuffixForTest()) }
