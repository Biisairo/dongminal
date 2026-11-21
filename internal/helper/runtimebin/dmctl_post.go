package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"

	"dongminal/internal/shared/apipath"
)

// 이 파일은 `/api/commands` 왕복이다 — 액션 하나를 보내고 결과를 종료 코드로 옮긴다.

// dmctlHTTPResult 는 `/api/commands` 계열 POST 한 번의 결과를 dmctl 의 종료 코드로
// 옮긴다 (DRIFT_RECLAIM_SRS FR-DRC-11). 판정은 httpExit 의 것이고(FR-RDG-20), 이 계열의
// 규칙은 commandRule 이다 — 400 미만이 성공이고, 거절은 서버 본문을 그대로 싣는다.
//
// echo 는 **성공** 본문을 stdout 으로 되실을지다. notify 는 되싣지 않는다 — 훅에서
// 불리므로 성공을 조용히 지나야 한다.
func dmctlHTTPResult(rule exitRule, status int, resp []byte, err error, echo bool, stdout, stderr io.Writer) int {
	if _, code, ok := httpExit(status, resp, err, stderr, rule); !ok {
		return code
	}
	if echo {
		stdout.Write(resp)
		fmt.Fprintln(stdout)
	}
	return 0
}

// commandRule 은 dmctlHTTPResult 를 쓰는 종단의 규칙이다. prefix 는 연결 실패 줄의 머리다.
func commandRule(prefix string) exitRule {
	return exitRule{prefix: prefix, ok: below400, refuse: refuseWith(rawRefusal)}
}

func dmctlPost(action string, args map[string]any, stdout, stderr io.Writer) int {
	return dmctlPostRaw(action, args, stdout, stderr)
}

// dmctlPostRaw 는 `/api/commands` 에 action 하나를 보낸다. args 는 JSON 으로 옮길 수
// 있는 무엇이든 된다 — `send` 는 사용자가 준 JSON 을 해석 없이 싣는다.
func dmctlPostRaw(action string, args any, stdout, stderr io.Writer) int {
	return dmctlPostRawCapture(action, args, stdout, stderr, nil)
}

// dmctlPostRawCapture 는 dmctlPostRaw 와 같고, 응답 본문을 out 에 남긴다(nil 이면 버린다).
func dmctlPostRawCapture(action string, args any, stdout, stderr io.Writer, out *[]byte) int {
	body := map[string]any{"action": action, "args": args}
	status, resp, err := httpPostJSON(baseURL()+apipath.Commands, body)
	if out != nil {
		*out = resp
	}
	if code := dmctlHTTPResult(commandRule("dmctl"), status, resp, err, true, stdout, stderr); code != 0 {
		return code
	}
	return dmctlDelivery("dmctl", resp, stderr)
}

// dmctlDelivery 는 `/api/commands` 응답의 **배달 사실**을 종료 코드로 옮긴다
// (M8_UNIFIED_SRS D-A-2, 10-func-backend FBE-02).
//
//	이전 동작: HTTP 200 이면 exit 0 — 브라우저가 없어도(`delivered:0`), 생성 명령이
//	          아무것도 만들지 못했어도(`timedOut:true`)
//	새  동작: `delivered==0` 이면 exit 1, 생성 명령이 `timedOut` 이면 exit 1. 본문은
//	          그대로 stdout 에 남는다
//	이유:     헬프의 팀 구성 절차(`new-tab` → `run member --at <새 uuid>`)가 exit 0 을
//	          "만들어졌다" 로 읽는다. 같은 종단의 `detach` 는 이미 이렇게 판정한다
//
// 판정은 필드가 **있을 때만**이다 — 그 필드를 모르는 응답을 0 으로 읽어 실패로
// 만들지 않는다. 모른다와 없다는 다르다. prefix 는 문구의 머리다(`detach` 도 이것을 쓴다).
func dmctlDelivery(prefix string, resp []byte, stderr io.Writer) int {
	var got struct {
		Delivered *int  `json:"delivered"`
		TimedOut  *bool `json:"timedOut"`
	}
	if json.Unmarshal(resp, &got) != nil || got.Delivered == nil {
		return 0
	}
	if *got.Delivered == 0 {
		fmt.Fprintln(stderr, prefix+": 구독 중인 브라우저가 없습니다 — 페이지를 새로고침하세요")
		return 1
	}
	if got.TimedOut != nil && *got.TimedOut {
		fmt.Fprintln(stderr, prefix+": 브라우저가 결과를 답하지 않았습니다 — 만들어지지 않았을 수 있습니다. list-workspace 로 확인하세요")
		return 1
	}
	return 0
}

func dmctlSend(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: dmctl send <action> [json-args]")
		return 2
	}
	action := args[0]
	var payload any = map[string]any{}
	if len(args) >= 2 && args[1] != "" {
		if err := json.Unmarshal([]byte(args[1]), &payload); err != nil {
			fmt.Fprintf(stderr, "dmctl: invalid json args: %v\n", err)
			return 2
		}
	}
	return dmctlPostRaw(action, payload, stdout, stderr)
}
