package runtimebin

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const editHelp = `사용법:
  edit <path>        편집기 탭으로 파일 열기
  edit -h, --help    이 도움말
`

func runEdit(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, editHelp)
		return 0
	}
	switch args[0] {
	case "-h", "--help":
		fmt.Fprint(stdout, editHelp)
		return 0
	}

	target := args[0]
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		fmt.Fprintf(stderr, "edit: 파일 없음: %s\n", target)
		return 1
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		fmt.Fprintf(stderr, "edit: 경로 변환 실패: %v\n", err)
		return 1
	}
	name := filepath.Base(abs)

	url_ := baseURL() + "/api/commands"
	body := map[string]any{
		"action": "openEditorTab",
		"args":   map[string]any{"name": name, "filePath": abs},
	}
	_, resp, err := httpPostJSON(url_, body)
	if err != nil {
		fmt.Fprintf(stderr, "edit: 서버 연결 실패 (port=%s)\n", currentPort())
		return 1
	}
	stdout.Write(resp)
	fmt.Fprintln(stdout)
	return 0
}
