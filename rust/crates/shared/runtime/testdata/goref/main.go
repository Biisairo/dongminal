// goref 는 Rust 포팅의 설치 결과를 Go 와 비교하는 참조 프로그램이다 (FR-RSP-13).
// dm-shared-runtime 의 시험이 격리 실행으로 빌드해 부른다. testdata 아래라 `./...` 에 들지 않는다.
package main

import (
	"fmt"
	"os"

	"dongminal/internal/shared/runtime"
)

func main() {
	if err := runtime.Install(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
