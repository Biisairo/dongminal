// Package runtimebin은 dongminal 바이너리가 dmctl/edit/download/mdview 등
// 헬퍼 CLI 로도 동작할 수 있게 multi-call dispatch 를 제공한다.
//
// 사용:
//
//	if code, ok := runtimebin.Dispatch(os.Args); ok {
//	    os.Exit(code)
//	}
package runtimebin

import (
	"io"
	"os"
	"path/filepath"
)

type runFunc func(args []string, stdout, stderr io.Writer) int

var commands = map[string]runFunc{
	"dmctl":    runDmctl,
	"edit":     runEdit,
	"download": runDownload,
	"mdview":   runMdview,
}

// HelperNames는 multi-call 로 등록된 helper 이름 목록.
func HelperNames() []string {
	out := make([]string, 0, len(commands))
	for k := range commands {
		out = append(out, k)
	}
	return out
}

// Dispatch는 argv[0] basename 이 helper 이름이면 그 helper 를 실행하고
// (exitCode, true) 를 돌려준다. 그 외에는 (0, false).
func Dispatch(argv []string) (int, bool) {
	if len(argv) == 0 {
		return 0, false
	}
	name := filepath.Base(argv[0])
	fn, ok := commands[name]
	if !ok {
		return 0, false
	}
	return fn(argv[1:], os.Stdout, os.Stderr), true
}
