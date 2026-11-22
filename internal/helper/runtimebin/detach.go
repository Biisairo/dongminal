package runtimebin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"dongminal/internal/shared/apipath"
	"dongminal/internal/shared/dmenv"
)

const detachHelp = `detach — 현재 도구를 백그라운드로 보내고 탭을 닫는다

사용법:
  detach                        현재 탭의 도구를 백그라운드로 (탭은 닫힘)
  detach --run <명령>           백그라운드에 새 도구를 만들어 그 명령을 돌린다
  detach --run <명령> --cwd <경로>
                                그 명령을 이 디렉터리에서 돌린다
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

--run 으로 만든 도구는 **그 명령이 곧 프로세스**다. 명령이 끝나면 도구가 죽고
백그라운드 목록에서 사라진다 — 대화형 셸이 남아 기다리지 않는다. 명령 자체는 그
호스트의 셸에 넘어가므로 파이프·리디렉션은 그대로 쓸 수 있고, 끝난 뒤에도 자리를
남기려면 그것까지 명령에 적는다 (예: npm test; exec $SHELL).

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
// detachFlags 는 detach 의 인자다.
type detachFlags struct {
	doList    bool
	restoreID string
	at        string
	// UX_BATCH6_SRS FR-BGP-3: 돌릴 명령과 그 자리. 빈 문자열과 "주지 않았다" 를
	// 가르기 위해 플래그 유무를 따로 든다 — `--run ''` 는 오류이지 무동작이 아니다.
	runCmd string
	hasRun bool
	cwd    string
}

// detachNeedsValue 는 값이 빠진 플래그마다 무엇을 줘야 하는지 말한다 — detach 의 안내는
// 일반 문구(`flag X requires value`)보다 자세하다. `-r` 도 `--restore` 로 말한다(종전과 같다).
var detachNeedsValue = map[string]string{
	"--run":     "--run 은 실행할 명령이 필요합니다",
	"--cwd":     "--cwd 는 경로가 필요합니다",
	"--restore": detachRestoreNeedsID,
	"-r":        detachRestoreNeedsID,
	"--at":      detachAtNeedsUUID,
}

const (
	detachRestoreNeedsID = "--restore 는 도구 id 가 필요합니다 (detach --list 로 확인)"
	detachAtNeedsUUID    = "--at 은 탭 uuid 가 필요합니다 (dmctl list-workspace 로 확인)"
)

// parseDetachFlags 는 argSpec 하나다 (QUALITY_GO_SRS FR-QG-53 · PROD3 DM-5). 오류 문구는
// detach 의 것(값이 빠진 플래그마다의 안내, 모르는 인자 뒤의 도움말)을 그대로 쓴다. 바뀐 것
// 둘은 SRS §5 다 — `--restore=ID`·`-r=ID` 를 받고, `--at ""` 를 `--at=` 처럼 거절한다.
func parseDetachFlags(args []string, stdout, stderr io.Writer) (detachFlags, int, bool) {
	var f detachFlags
	spec := argSpec{
		help: detachHelp,
		vals: map[string]func(string) error{
			"--run": func(v string) error {
				f.runCmd, f.hasRun = v, true
				return nil
			},
			"--cwd":     setStr(&f.cwd),
			"--restore": setStr(&f.restoreID),
			"-r":        setStr(&f.restoreID),
			"--at": func(v string) error {
				if v == "" {
					return errors.New(detachAtNeedsUUID)
				}
				f.at = v
				return nil
			},
		},
		bools: map[string]*bool{"--list": &f.doList, "-l": &f.doList},
	}
	help, e := spec.parse(args)
	switch {
	case help:
		fmt.Fprint(stdout, detachHelp)
		return f, 0, false
	case e == nil:
		return f, 0, true
	case e.kind == argNeedsValue:
		fmt.Fprintln(stderr, "detach: "+detachNeedsValue[e.arg])
	case e.kind == argInvalid:
		fmt.Fprintf(stderr, "detach: %v\n", e.err)
	default:
		fmt.Fprintf(stderr, "detach: %s\n", unknownArg(e.arg))
		fmt.Fprint(stderr, detachHelp)
	}
	return f, 2, false
}

func runDetach(args []string, stdout, stderr io.Writer) int {
	f, code, proceed := parseDetachFlags(args, stdout, stderr)
	if !proceed {
		return code
	}
	doList, restoreID, at, runCmd, hasRun, cwd := f.doList, f.restoreID, f.at, f.runCmd, f.hasRun, f.cwd

	if hasRun {
		if strings.TrimSpace(runCmd) == "" {
			fmt.Fprintln(stderr, "detach: --run 은 실행할 명령이 필요합니다")
			return 2
		}
		if doList || restoreID != "" || at != "" {
			fmt.Fprintln(stderr, "detach: --run 은 --list·--restore·--at 과 함께 쓸 수 없습니다")
			return 2
		}
		return detachRun(runCmd, cwd, stdout, stderr)
	}
	if cwd != "" {
		// --cwd 는 --run 의 인자다. 단독 사용은 오해이므로 조용히 무시하지 않는다
		// (--at 과 같은 규약, FR-BGR-3).
		fmt.Fprintln(stderr, "detach: --cwd 는 --run 과 함께만 씁니다")
		return 2
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
	status, body, err := httpPostJSON(baseURL()+apipath.Commands,
		map[string]any{"action": action, "args": args})
	if _, code, ok := httpExit(status, body, err, stderr, detachRule(true)); !ok {
		return code
	}
	// REFACTOR3_DEDUP_GO_SRS FR-RDG-26 (DM-F3). 이전: 본문을 풀지 못하거나 `delivered` 가
	// 없어도 0 으로 읽어 "브라우저 없음" 으로 1. 새: dmctlDelivery 의 규칙 — 모르면 0.
	// 이유: 같은 종단(`/api/commands`)의 배달 판정이 두 벌이었다.
	return dmctlDelivery("detach", body, stderr)
}

// detachRule 은 detach 의 응답 해석이다. withBody 면 거절 줄에 서버 본문을 싣는다.
func detachRule(withBody bool) exitRule {
	return exitRule{prefix: "detach", refuse: refuseWith(func(w io.Writer, status int, body []byte) {
		if withBody {
			fmt.Fprintf(w, "detach: 서버 오류 %d: %s\n", status, string(body))
			return
		}
		fmt.Fprintf(w, "detach: 서버 오류 %d\n", status)
	})}
}

/**
 * detachRun 은 백그라운드에 도구를 만들어 명령 하나를 돌린다 (FR-BGP-3).
 *
 * 브라우저를 거치지 않는다 — 만드는 것이 **탭 없는 도구**이므로 화면에 자리를
 * 잡을 필요가 없고, 그래서 `detachPost` 의 "구독 중인 브라우저가 없습니다" 도
 * 여기에는 해당하지 않는다. 종단은 헤드리스 생성이 쓰는 그것이다.
 */
func detachRun(cmdline, cwd string, stdout, stderr io.Writer) int {
	body := map[string]any{"command": cmdline}
	if cwd != "" {
		body["cwd"] = cwd
	}
	status, raw, err := httpPostJSON(baseURL()+apipath.ToolsHeadless, body)
	if _, code, ok := httpExit(status, raw, err, stderr, detachRule(true)); !ok {
		return code
	}
	var resp struct {
		ToolID string `json:"toolId"`
	}
	json.Unmarshal(raw, &resp)
	fmt.Fprintf(stdout, "background  toolId=%s  cmd=%s\n", resp.ToolID, cmdline)
	fmt.Fprintln(stdout, "  명령이 끝나면 이 도구는 스스로 사라진다 — detach --list 로 확인")
	return 0
}

func detachList(stdout, stderr io.Writer) int {
	status, body, err := httpGet(baseURL() + apipath.ToolsBackground)
	if _, code, ok := httpExit(status, body, err, stderr, detachRule(false)); !ok {
		return code
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
