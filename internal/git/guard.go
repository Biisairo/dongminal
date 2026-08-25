package git

import (
	"fmt"
	"strings"
)

// readCommands 는 M1 이 실행할 수 있는 git 하위 명령 전부다.
// **여기 없는 것은 실행되지 않는다.** M1 에 파괴적 경로를 만들지 않는 것이
// 목적이며(FR-GIT-7), 목록을 늘리는 것은 해당 마일스톤의 일이다.
var readCommands = map[string]bool{
	"rev-parse": true, "status": true, "diff": true, "diff-tree": true,
	"diff-index": true, "show": true, "log": true, "for-each-ref": true,
	"cat-file": true, "ls-files": true, "symbolic-ref": true,
}

// unsafePrefixes 는 임의 명령 실행 또는 파일 쓰기로 가는 인자들이다. 읽기
// 명령에 붙어도 읽기가 아니게 된다.
var unsafePrefixes = []string{"--upload-pack", "--receive-pack", "--exec-path", "--output", "-o"}

// guardArgs 는 인자 배열을 검사한다 (FR-GIT-2, 7).
//
// **하위 명령이 먼저 온다.** git 전역 옵션(-c, --exec-path, --upload-pack 등)은
// 임의 실행 경로가 되므로 이 패키지는 아예 받지 않는다.
func guardArgs(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: 인자가 없다", ErrUnsafeArgument)
	}
	if strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("%w: git 전역 옵션은 받지 않는다: %q", ErrUnsafeArgument, args[0])
	}
	if !readCommands[args[0]] {
		return fmt.Errorf("%w: %q 는 읽기 허용 목록에 없다", ErrWriteCommand, args[0])
	}
	for _, a := range args {
		if strings.ContainsRune(a, 0) {
			return fmt.Errorf("%w: NUL 을 포함한 인자", ErrUnsafeArgument)
		}
		for _, p := range unsafePrefixes {
			if strings.HasPrefix(a, p) {
				return fmt.Errorf("%w: %q 는 임의 실행·파일 쓰기 경로다", ErrUnsafeArgument, a)
			}
		}
	}
	return nil
}
