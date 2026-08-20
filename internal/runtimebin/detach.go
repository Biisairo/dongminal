package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

const detachHelp = `detach — 현재 도구를 백그라운드로 보내고 탭을 닫는다

사용법:
  detach                   현재 탭의 도구를 백그라운드로 (탭은 닫힘)
  detach --list            백그라운드 도구 목록
  detach --restore <id>    백그라운드 도구를 현재 분할 칸의 새 탭으로 복귀
  detach -h, --help        이 도움말

백그라운드 도구는 계속 실행되지만 어느 탭에도 매이지 않는다. 데몬을 재시작하면
복원되지 않는다 — 복원해도 돌던 작업이 아니라 빈 셸이 되살아날 뿐이다.

이름이 bg 가 아닌 이유: bg 는 zsh/bash 의 작업 제어 빌트인이다.
`

// runDetach implements the `detach` helper (FR-BG-2/6/7).
//
// 전환과 탭 닫기는 하나의 워크스페이스 명령(detachTab)으로 브라우저에 보낸다.
// 두 단계로 나누면 그 사이에 탭이 닫혀 도구가 종료될 수 있다.
func runDetach(args []string, stdout, stderr io.Writer) int {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			fmt.Fprint(stdout, detachHelp)
			return 0
		case "--list", "-l":
			return detachList(stdout, stderr)
		case "--restore", "-r":
			if i+1 >= len(args) {
				fmt.Fprintln(stderr, "detach: --restore 는 도구 id 가 필요합니다 (detach --list 로 확인)")
				return 2
			}
			return detachRestore(args[i+1], stdout, stderr)
		default:
			fmt.Fprintf(stderr, "detach: unknown argument: %s\n", args[i])
			fmt.Fprint(stderr, detachHelp)
			return 2
		}
	}

	toolID := os.Getenv("DONGMINAL_TOOL_ID")
	if toolID == "" {
		fmt.Fprintln(stderr, "detach: DONGMINAL_TOOL_ID 미설정 (dongminal 터미널 안에서 실행해야 합니다)")
		return 1
	}
	return detachPost("detachTab", map[string]any{"toolId": toolID}, stdout, stderr)
}

func detachRestore(id string, stdout, stderr io.Writer) int {
	return detachPost("restoreTool", map[string]any{"toolId": id}, stdout, stderr)
}

func detachPost(action string, args map[string]any, stdout, stderr io.Writer) int {
	status, body, err := httpPostJSON(baseURL()+"/api/commands",
		map[string]any{"action": action, "args": args})
	if err != nil {
		fmt.Fprintf(stderr, "detach: %v\n", err)
		return 1
	}
	if status < 200 || status >= 300 {
		fmt.Fprintf(stderr, "detach: 서버 오류 %d: %s\n", status, string(body))
		return 1
	}
	var resp struct {
		Delivered int `json:"delivered"`
	}
	json.Unmarshal(body, &resp)
	if resp.Delivered == 0 {
		fmt.Fprintln(stderr, "detach: 구독 중인 브라우저가 없습니다 — 페이지를 새로고침하세요")
		return 1
	}
	return 0
}

func detachList(stdout, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + "/api/tools/background")
	if err != nil {
		fmt.Fprintf(stderr, "detach: %v\n", err)
		return 1
	}
	if status < 200 || status >= 300 {
		fmt.Fprintf(stderr, "detach: 서버 오류 %d\n", status)
		return 1
	}
	var resp struct {
		Background []struct {
			ToolID string `json:"toolId"`
			Name   string `json:"name"`
			Cwd    string `json:"cwd"`
			Since  int64  `json:"since"`
		} `json:"background"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		fmt.Fprintf(stderr, "detach: 응답 파싱 실패: %v\n", err)
		return 1
	}
	if len(resp.Background) == 0 {
		fmt.Fprintln(stdout, "백그라운드 도구 없음")
		return 0
	}
	for _, b := range resp.Background {
		fmt.Fprintf(stdout, "  toolId=%s  name=%q  cwd=%s\n", b.ToolID, b.Name, b.Cwd)
	}
	return 0
}
