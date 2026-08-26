package core

import (
	"fmt"
	"strings"
)

// readCommands 는 읽기 경로가 실행할 수 있는 git 하위 명령 전부다.
// **여기 없는 것은 실행되지 않는다** (FR-GIT-7).
//
// writeCommands 와 교집합이 없어야 한다 (FR-GIT-95) — 겹치면 어느 경로로도 실행
// 가능한 명령이 생긴다. 그래서 symbolic-ref 는 여기 없다: 읽기에는
// `rev-parse --abbrev-ref` 로 충분하고, ref 를 옮기는 것은 쓰기 경로의 일이다.
// check-ref-format 은 저장소를 읽지도 쓰지도 않는 순수 검사다 (FR-GIT-159) —
// 이름 규칙을 우리가 다시 구현하지 않기 위한 유일한 수단이다.
var readCommands = map[string]bool{
	"rev-parse": true, "status": true, "diff": true, "diff-tree": true,
	"diff-index": true, "show": true, "log": true, "for-each-ref": true,
	"cat-file": true, "ls-files": true, "config": true, "check-ref-format": true,
}

// unsafePrefixes 는 임의 명령 실행 또는 파일 쓰기로 가는 인자들이다. 읽기
// 명령에 붙어도 읽기가 아니게 된다.
var unsafePrefixes = []string{"--upload-pack", "--receive-pack", "--exec-path", "--output", "-o"}

// checkRefFormat* 은 `git check-ref-format` 을 브랜치 이름 검사 하나로 묶는 값이다.
// 다른 형태(`--normalize`, `--allow-onelevel`, 여러 이름)를 받지 않는 이유는 그것이
// 이 패키지가 쓰지 않는 동작이고, 받는 형태가 넓어지면 무엇이 검사되는지 말할 수
// 없게 되기 때문이다.
const (
	checkRefFormatBranch = "--branch"
	checkRefFormatArgs   = 2 // --branch <name>
)

// configReadFlags 는 `git config` 를 읽기로 유지하는 플래그다. 값이 필요한 것은
// `--type=bool` 처럼 `=` 형태로만 받는다 — 값을 별도 인자로 받으면 그것이 플래그의
// 값인지 설정할 값인지 가릴 수 없다.
var configReadFlags = []string{"--get", "--get-all", "--list", "--type"}

// guardArgs 는 읽기 경로의 인자 배열을 검사한다 (FR-GIT-2, 7).
func guardArgs(args []string) error {
	if err := guardCommon(args, readCommands, "읽기"); err != nil {
		return err
	}
	switch args[0] {
	case "config":
		return guardConfigArgs(args[1:])
	case "check-ref-format":
		return guardCheckRefFormatArgs(args[1:])
	}
	return nil
}

// guardCheckRefFormatArgs 는 인자를 `--branch <name>` 하나로 묶는다. 이름은
// `--branch` 다음 인자로 오므로 `-` 로 시작해도 git 이 옵션으로 읽지 않는다
// (git 2.50.1 실측) — 그래도 호출자가 checkRefArg 로 먼저 걸러낸다.
func guardCheckRefFormatArgs(rest []string) error {
	if len(rest) != checkRefFormatArgs || rest[0] != checkRefFormatBranch {
		return fmt.Errorf("%w: check-ref-format 은 %s 와 이름 하나만 받는다: %q",
			ErrUnsafeArgument, checkRefFormatBranch, rest)
	}
	return nil
}

// guardCommon 은 허용 목록만 다른 공통 검사다. 읽기·쓰기 두 경로가 이 함수를
// 나눠 쓴다 — 한쪽만 고쳐지면 다른 쪽이 구멍이 된다.
//
// **하위 명령이 먼저 온다.** git 전역 옵션(-c, --exec-path, --upload-pack 등)은
// 임의 실행 경로가 되므로 이 패키지는 아예 받지 않는다.
//
// 허용 목록을 NUL·인자 검사보다 먼저 본다 — `status\x00` 같은 값은 "목록에 없는
// 하위 명령" 이며, 그 사실이 인자의 문제보다 앞선다.
func guardCommon(args []string, allowed map[string]bool, list string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: 인자가 없다", ErrUnsafeArgument)
	}
	if strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("%w: git 전역 옵션은 받지 않는다: %q", ErrUnsafeArgument, args[0])
	}
	if !allowed[args[0]] {
		return fmt.Errorf("%w: %q 는 %s 허용 목록에 없다", ErrWriteCommand, args[0], list)
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

// guardConfigArgs 는 `git config` 를 읽기로 한정한다. `git config user.name x` 는
// 설정을 쓰는 호출이므로 읽기 경로로 흘러선 안 된다 — 값 인자는 키 하나뿐이다.
func guardConfigArgs(rest []string) error {
	keys := 0
	for _, a := range rest {
		if strings.HasPrefix(a, "-") {
			if !configReadFlag(a) {
				return fmt.Errorf("%w: git config 의 %q 는 읽기 플래그가 아니다", ErrUnsafeArgument, a)
			}
			continue
		}
		keys++
	}
	if keys > 1 {
		return fmt.Errorf("%w: git config 는 키 하나만 읽는다: %q", ErrUnsafeArgument, rest)
	}
	return nil
}

func configReadFlag(a string) bool {
	for _, f := range configReadFlags {
		if a == f || strings.HasPrefix(a, f+"=") {
			return true
		}
	}
	return false
}
