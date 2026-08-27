package core

import (
	"errors"
	"fmt"
	"path"
	"path/filepath"
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
	// rev-list 는 범위의 커밋 수를 세는 자리다 (FR-GIT-265 의 "영향 커밋 수").
	// log 로 세면 커밋마다 한 줄이 출력 상한을 먹는다 — 세는 것이 목적일 때는
	// --count 가 그 일의 이름이다.
	"rev-list": true,
}

// unsafePrefixes 는 임의 명령 실행 또는 파일 쓰기로 가는 인자들이다. 읽기
// 명령에 붙어도 읽기가 아니게 된다.
var unsafePrefixes = []string{"--upload-pack", "--receive-pack", "--exec-path", "--output", "-o"}

// checkRefFormat* 은 `git check-ref-format` 을 이름 검사 **둘**로 묶는 값이다.
// 그 밖의 형태(`--allow-onelevel`, 여러 이름)를 받지 않는 이유는 그것이 이 패키지가
// 쓰지 않는 동작이고, 받는 형태가 넓어지면 무엇이 검사되는지 말할 수 없게 되기
// 때문이다.
const (
	// CheckRefFormatBranch 는 query 의 브랜치 이름 검사가 붙이는 플래그다
	// (FR-GIT-159).
	CheckRefFormatBranch = "--branch"
	// CheckRefFormatNormalize 는 태그 이름 검사가 붙이는 플래그다 (FR-GIT-260).
	// `--branch` 는 브랜치 이름 규칙이라 태그에 쓸 수 없고, 태그는 전체 ref
	// (`refs/tags/<name>`) 로 물어야 한다.
	CheckRefFormatNormalize = "--normalize"
	checkRefFormatArgs      = 2 // <플래그> <이름>
)

// checkRefFormatFlags 는 받을 수 있는 플래그 전부다. 목록으로 두는 이유는 새 이름
// 검사가 생길 때 허용 형태가 코드 여기저기로 흩어지지 않게 하기 위함이다.
var checkRefFormatFlags = []string{CheckRefFormatBranch, CheckRefFormatNormalize}

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

// guardCheckRefFormatArgs 는 인자를 `<플래그> <name>` 하나로 묶는다. 이름은
// 플래그 다음 인자로 오므로 `-` 로 시작해도 git 이 옵션으로 읽지 않는다
// (git 2.50.1 실측) — 그래도 호출자가 checkRefArg 로 먼저 걸러낸다.
func guardCheckRefFormatArgs(rest []string) error {
	if len(rest) == checkRefFormatArgs {
		for _, f := range checkRefFormatFlags {
			if rest[0] == f {
				return nil
			}
		}
	}
	return fmt.Errorf("%w: check-ref-format 은 %v 중 하나와 이름 하나만 받는다: %q",
		ErrUnsafeArgument, checkRefFormatFlags, rest)
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

// RelPath 는 리포 상대경로를 검증한다 (FR-GIT-62). 워킹 트리 파일을 직접 읽거나
// git 에 경로로 넘기는 자리이므로 여기가 뚫리면 임의 파일 접근이다.
//
// 정규화한 값을 돌려주지 않는다 — git 의 rev 와 워킹 트리 경로가 같은 문자열이어야
// 클라이언트가 보낸 경로와 응답이 짝을 이룬다. 다듬을 여지가 있으면 거부한다.
//
// kind 만 호출자가 갈라 받는다 — diff 와 스테이징이 같은 규칙을 쓰되 서로 다른
// 코드로 답해야 하고, 규칙이 두 벌이면 한쪽만 고쳐져 구멍이 된다.
func RelPath(p string, kind error) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("%w: 경로가 비었다", kind)
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("%w: 절대경로는 받지 않는다: %q", kind, p)
	}
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("%w: NUL 을 포함한 경로", kind)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: 부모 참조가 있다: %q", kind, p)
		}
	}
	if path.Clean(p) != p {
		return "", fmt.Errorf("%w: 정규화되지 않은 경로다: %q", kind, p)
	}
	return p, nil
}

// ErrRefName 은 git 의 ref 이름 규칙을 어긴 이름이다 (FR-GIT-159). 이름 검사는
// 조회(check-ref-format)와 변경(브랜치 생성) 양쪽이 쓰므로 사유도 여기 둔다.
var ErrRefName = errors.New("ref_name_invalid")

// CheckRefArg 는 위치 인자로 들어갈 ref 이름을 본다 (FR-GIT-62). query 의 checkRev 와
// 같은 정신이되 더 좁다 — 옵션처럼 생긴 값과 범위 표현을 인자로 넘기기 전에 막는다.
//
// **규칙 전체를 여기서 판정하지 않는다.** 그것은 check-ref-format 의 일이며, 여기서
// 막는 것은 git 에 넘기는 순간 뜻이 달라지는 값뿐이다.
func CheckRefArg(name, val string) error {
	if strings.TrimSpace(val) == "" {
		return fmt.Errorf("%w: %s 가 비었다", ErrRefName, name)
	}
	if strings.HasPrefix(val, "-") {
		return fmt.Errorf("%w: %s 는 - 로 시작할 수 없다: %q", ErrRefName, name, val)
	}
	if strings.ContainsRune(val, 0) {
		return fmt.Errorf("%w: %s 에 NUL 이 있다", ErrRefName, name)
	}
	if strings.Contains(val, "..") {
		return fmt.Errorf("%w: %s 에 범위 표현(..) 이 있다: %q", ErrRefName, name, val)
	}
	return nil
}
