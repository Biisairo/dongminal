package runtimebin

import (
	"fmt"
	"io"
)

// 쉘 훅의 진입점이다 — `BROWSER=$DONGMINAL_HOME/bin/open-url`, bash·zsh 의
// `open`/`xdg-open` 함수, `dmctl open-url` (BROWSER_TAB_SRS FR-BRT-70).
//
// 셋 다 `dmctl browser open <url>` 과 **같은 길**로 서버 기기의 Chrome 에 탭을 연다 —
// 호출 칸은 이 도구, 포커스를 옮긴다 (FR-BRT-34). 프로그램이 여는 URL 은 설정과
// 무관하게 언제나 브라우저 탭이다 (FR-BRT-69).
//
//	이전 동작: 뷰어가 서버와 같은 기기면 이 셸이 기본 브라우저를 열고, 원격이면 뷰어에
//	          확인 모달을 띄웠다 (VIEWER_URL_OPEN_SRS)
//	새  동작: 언제나 서버 기기에서 도는 브라우저 탭이다
//	이유:     서버 기기에서 실행되는 것이 요구의 핵심이다 — `localhost` 콜백이 서버로
//	          돌아온다 (BROWSER_TAB_SRS §1.1)

const openURLHelp = `open-url — 서버 기기의 브라우저 탭으로 연다

사용법:
  open-url <url|경로>          하나
  dmctl open-url <url|경로>    같은 동작 (dmctl browser open --focus 와 같다)
`

func runOpenURL(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprint(stdout, openURLHelp)
		return 0
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprint(stderr, openURLHelp)
		return 2
	}
	return browserOpen(args[0], browserFlags{focus: true}, io.Discard, stderr)
}
