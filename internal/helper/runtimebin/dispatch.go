// Package runtimebin은 dongminal 바이너리가 dmctl/edit/download/detach 등
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
	"strings"
)

type runFunc func(args []string, stdout, stderr io.Writer) int

var commands = map[string]runFunc{
	"dmctl":    runDmctl,
	"edit":     runEdit,
	"download": runDownload,
	"detach":   runDetach,
}

// HelperNames는 multi-call 로 등록된 helper 이름 목록.
func HelperNames() []string {
	out := make([]string, 0, len(commands))
	for k := range commands {
		out = append(out, k)
	}
	return out
}

// HelperName은 argv[0] 에서 실행 파일의 이름을 뽑는다.
//
// **확장자를 뗀다.** Windows 의 실행 파일은 `dmctl.exe` 이고 설치도 그 이름으로
// 깐다(`install.go` 의 `name+ExeSuffix()`) — basename 을 그대로 표에서 찾으면
// **어떤 helper 도 걸리지 않는다.** 그러면 dmctl 이 본 CLI 로 떨어져 사용법만
// 찍고, 에이전트 훅(`dmctl activity`)과 알림(`dmctl notify`)이 통째로 죽는다
// (러너 실측: 터미널에 dongminal 의 사용법이 떴다).
//
// 확장자는 **실행 파일의 것만** 뗀다. `.exe` 가 아닌 점은 이름의 일부일 수 있다.
func HelperName(arg0 string) string {
	name := filepath.Base(arg0)
	for _, ext := range []string{".exe", ".com", ".bat", ".cmd"} {
		if strings.EqualFold(filepath.Ext(name), ext) {
			return name[:len(name)-len(ext)]
		}
	}
	return name
}

// Dispatch는 argv[0] basename 이 helper 이름이면 그 helper 를 실행하고
// (exitCode, true) 를 돌려준다. 그 외에는 (0, false).
func Dispatch(argv []string) (int, bool) {
	if len(argv) == 0 {
		return 0, false
	}
	fn, ok := commands[HelperName(argv[0])]
	if !ok {
		return 0, false
	}
	return fn(argv[1:], os.Stdout, os.Stderr), true
}
