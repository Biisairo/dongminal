package runtimebin

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const mdviewHelp = `사용법:
  mdview <path>    Markdown 파일을 뷰어 탭으로 열기
  mdview -h       도움말

환경변수:
  DONGMINAL_HOST — 서버 호스트 (기본 127.0.0.1)
  DONGMINAL_PORT — 서버 포트 (기본 58146)
`

func runMdview(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, mdviewHelp)
		return 0
	}
	switch args[0] {
	case "-h", "--help":
		fmt.Fprint(stdout, mdviewHelp)
		return 0
	}

	target := args[0]
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		fmt.Fprintf(stderr, "mdview: 파일 없음: %s\n", target)
		return 1
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		fmt.Fprintf(stderr, "mdview: 경로 변환 실패: %v\n", err)
		return 1
	}
	name := filepath.Base(abs)

	url := baseURL() + "/api/commands"
	body := map[string]any{
		"action": "openMdTab",
		"args":   map[string]any{"name": name, "filePath": abs},
	}
	_, resp, err := httpPostJSON(url, body)
	if err != nil {
		fmt.Fprintf(stderr, "mdview: 서버 연결 실패 (port=%s)\n", currentPort())
		return 1
	}
	stdout.Write(resp)
	fmt.Fprintln(stdout)
	return 0
}
