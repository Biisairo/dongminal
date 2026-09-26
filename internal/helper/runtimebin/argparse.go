package runtimebin

import (
	"fmt"
	"io"
	"strings"
)

// argSpec 은 dmctl 서브커맨드 하나의 인자 표다 (OPTIMIZE_REFACTOR_SRS FR-OPT-9-2 · SHR-15).
// 값 플래그는 `--k v` 와 `--k=v` 를 모두 받는다. `-h`·`--help` 는 그 자리에서 멈춘다.
type argSpec struct {
	// help 는 run 이 `-h`·`--help` 에 stdout 으로 쓰는 것이다.
	help string
	// vals 는 값을 받는 플래그다. 설정자가 오류를 내면 그 자리에서 멈춘다 — 앞에서부터
	// 읽으므로 어느 오류를 먼저 말하는지는 인자 순서가 정한다.
	vals  map[string]func(string) error
	bools map[string]*bool
	// rest 가 있으면 플래그가 아닌 인자와 `--` 뒤를 모두 여기 모은다. 이때 `-h`·`--help`
	// 는 호출자(최상위 도움말)의 몫이라 건너뛰고, `-` 로 시작하는 모르는 것은 오류다.
	rest *[]string
	// strictEq 이면 `--k=` 처럼 값이 빈 등호 형은 모르는 인자다.
	strictEq bool
}

type argErrKind int

const (
	argNeedsValue argErrKind = iota + 1
	argUnknown
	argInvalid
)

// argError 는 파싱을 멈춘 인자다. argInvalid 이면 err 가 설정자의 오류다.
type argError struct {
	kind argErrKind
	arg  string
	err  error
}

func setStr(p *string) func(string) error {
	return func(v string) error {
		*p = v
		return nil
	}
}

func isHelpArg(a string) bool { return a == "-h" || a == "--help" }

// parse 는 인자를 앞에서부터 읽는다. help 가 참이면 도움말 인자를 만나 멈췄다.
func (s argSpec) parse(args []string) (help bool, e *argError) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if isHelpArg(a) {
			if s.rest != nil {
				continue
			}
			return true, nil
		}
		if s.rest != nil && a == "--" {
			*s.rest = append(*s.rest, args[i+1:]...)
			return false, nil
		}
		if p, ok := s.bools[a]; ok {
			*p = true
			continue
		}
		if set, ok := s.vals[a]; ok {
			if i+1 >= len(args) {
				return false, &argError{kind: argNeedsValue, arg: a}
			}
			i++
			if err := set(args[i]); err != nil {
				return false, &argError{kind: argInvalid, arg: a, err: err}
			}
			continue
		}
		if eq := strings.IndexByte(a, '='); eq > 0 && !(s.strictEq && eq == len(a)-1) {
			if set, ok := s.vals[a[:eq]]; ok {
				if err := set(a[eq+1:]); err != nil {
					return false, &argError{kind: argInvalid, arg: a[:eq], err: err}
				}
				continue
			}
		}
		if s.rest != nil && !strings.HasPrefix(a, "-") {
			*s.rest = append(*s.rest, a)
			continue
		}
		return false, &argError{kind: argUnknown, arg: a}
	}
	return false, nil
}

// run 은 parse 에 dmctl 서브커맨드의 공통 응답을 입힌다: 도움말은 stdout 에 쓰고 0,
// 오류는 `<prefix>: …` 를 stderr 에 쓰고 2. proceed 가 참일 때만 호출자가 계속한다.
func (s argSpec) run(prefix string, args []string, stdout, stderr io.Writer) (code int, proceed bool) {
	help, e := s.parse(args)
	if help {
		fmt.Fprint(stdout, s.help)
		return 0, false
	}
	if e == nil {
		return 0, true
	}
	switch e.kind {
	case argNeedsValue:
		fmt.Fprintf(stderr, "%s: flag %s requires value\n", prefix, e.arg)
	case argInvalid:
		fmt.Fprintf(stderr, "%s: %v\n", prefix, e.err)
	default:
		fmt.Fprintf(stderr, "%s: unknown argument: %s\n", prefix, e.arg)
	}
	return 2, false
}
