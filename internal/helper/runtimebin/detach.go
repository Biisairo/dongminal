package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"dongminal/internal/shared/dmenv"
)

const detachHelp = `detach — 현재 도구를 백그라운드로 보내고 탭을 닫는다

사용법:
  detach                        현재 탭의 도구를 백그라운드로 (탭은 닫힘)
  detach --list                 백그라운드 도구 목록
  detach --restore <id>         백그라운드 도구를 현재 분할 칸의 새 탭으로 복귀
  detach --restore <id> --at <uuid>
                                지정한 탭이 속한 분할 칸의 새 탭으로 복귀
  detach -h, --help             이 도움말

--at 은 dmctl list-workspace 의 uuid 를 받는다. 복귀는 분할 칸 단위이므로 좌표의
탭 성분은 무시된다 — 그 탭이 속한 분할 칸이 대상이다. --at 없이 쓰면 브라우저가
현재 포커스한 분할 칸으로 복귀한다.

백그라운드 도구는 계속 실행되지만 어느 탭에도 매이지 않는다. 데몬을 재시작하면
복원되지 않는다 — 복원해도 돌던 작업이 아니라 빈 셸이 되살아날 뿐이다.

이름이 bg 가 아닌 이유: bg 는 zsh/bash 의 작업 제어 빌트인이다.
`

// runDetach implements the `detach` helper (FR-BG-2/6/7).
//
// 전환과 탭 닫기는 하나의 워크스페이스 명령(detachTab)으로 브라우저에 보낸다.
// 두 단계로 나누면 그 사이에 탭이 닫혀 도구가 종료될 수 있다.
// runDetach 는 플래그를 한 번에 모아 해석한다 — --at 이 --restore 앞에 와도
// 같은 결과여야 하므로, 첫 플래그에서 곧바로 반환할 수 없다 (FR-BGR-3).
//
// -l 은 여기서 --list 다. dmctl 은 -l 을 --at 의 단축으로 쓰지만, 기존 detach -l
// 사용을 깨뜨릴 수 없으므로 그 단축은 제공하지 않는다.
func runDetach(args []string, stdout, stderr io.Writer) int {
	doList := false
	restoreID := ""
	at := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			fmt.Fprint(stdout, detachHelp)
			return 0
		case a == "--list" || a == "-l":
			doList = true
		case a == "--restore" || a == "-r":
			if i+1 >= len(args) {
				fmt.Fprintln(stderr, "detach: --restore 는 도구 id 가 필요합니다 (detach --list 로 확인)")
				return 2
			}
			restoreID = args[i+1]
			i++
		case a == "--at":
			if i+1 >= len(args) {
				fmt.Fprintln(stderr, "detach: --at 은 탭 uuid 가 필요합니다 (dmctl list-workspace 로 확인)")
				return 2
			}
			at = args[i+1]
			i++
		case strings.HasPrefix(a, "--at="):
			at = strings.TrimPrefix(a, "--at=")
			if at == "" {
				fmt.Fprintln(stderr, "detach: --at 은 탭 uuid 가 필요합니다 (dmctl list-workspace 로 확인)")
				return 2
			}
		default:
			fmt.Fprintf(stderr, "detach: unknown argument: %s\n", a)
			fmt.Fprint(stderr, detachHelp)
			return 2
		}
	}

	if doList {
		return detachList(stdout, stderr)
	}
	if restoreID != "" {
		return detachRestore(restoreID, at, stdout, stderr)
	}
	// FR-BGR-3: --at 은 복귀 대상을 가리키는 인자다. detach(백그라운드로 보내기)
	// 에는 대상 개념이 없으므로 단독 사용은 오해다 — 조용히 무시하지 않는다.
	if at != "" {
		fmt.Fprintln(stderr, "detach: --at 은 --restore 와 함께만 씁니다")
		return 2
	}

	toolID := selfToolID()
	if toolID == "" {
		fmt.Fprintln(stderr, "detach: "+dmenv.EnvToolID+" 미설정 (dongminal 터미널 안에서 실행해야 합니다)")
		return 1
	}
	return detachPost("detachTab", map[string]any{"toolId": toolID}, stdout, stderr)
}

// detachRestore 는 at 이 비어 있으면 location 을 싣지 않는다 — 기존 호출의
// 동작(브라우저의 현재 포커스 Pane 으로 복귀)을 그대로 유지한다 (FR-BGR-4).
func detachRestore(id, at string, stdout, stderr io.Writer) int {
	args := map[string]any{"toolId": id}
	if at != "" {
		args["location"] = at
	}
	return detachPost("restoreTool", args, stdout, stderr)
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
