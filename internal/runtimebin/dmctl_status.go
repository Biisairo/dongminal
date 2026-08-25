// 묶음 S 의 CLI 절반이다 (RUN_ORCHESTRATION_SRS §3.2).
//
// 지금까지 에이전트가 "저쪽 도구가 준비됐나"를 알 방법은 read-screen 으로 화면을
// 긁는 것뿐이었다. 훅이 보고한 상태는 서버에 있었지만 브라우저만 읽었다. 두 명령이
// 그 경로를 연다 — status(조회)와 wait(대기).
package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const dmctlStatusHelp = `dmctl status — 도구에서 도는 에이전트의 현재 상태

사용법:
  dmctl status [--at <uuid>] [--json]

  --at <uuid>, -l <uuid>   대상 도구. 생략 시 현재 셸이 속한 도구.
  --json                   서버 응답 JSON 을 그대로 낸다.

state 는 에이전트 훅이 보고한 값이다:
  working   작업 중
  waiting   사용자 입력·권한 확인 대기 (**준비완료가 아니다**)
  done      한 턴을 마쳤다
  idle      세션 시작 직후 등 유휴
  unknown   훅 보고가 없다 (오류가 아니다)

quietMs 는 마지막 출력 이후 경과(ms)이며 -1 은 출력을 관측한 적이 없다는 뜻이다.
`

const dmctlWaitHelp = `dmctl wait — 도구가 조건을 만족할 때까지 기다린다

사용법:
  dmctl wait [--at <uuid>] --for ready|done [--timeout-ms N] [--json]

  --at <uuid>, -l <uuid>   대상 도구. 생략 시 현재 셸이 속한 도구.
  --for ready              지시를 받을 수 있는 상태가 될 때까지
  --for done               한 턴을 마쳤다고 보고할 때까지
  --timeout-ms N           기본 300000(5분), 상한 1800000(30분)
  --json                   서버 응답 JSON 을 그대로 낸다.

대기는 서버가 붙잡는다 — 이 명령은 요청을 한 번만 보낸다. sleep 루프를 짜지 마라.

종료 코드:
  0  조건 충족 (ready / done)
  2  사용법 오류
  1  서버·전송 오류, 또는 대기 중 도구가 사라짐(gone)
  4  타임아웃 — **실패가 아니라 체크포인트다.** 마지막 관측 상태를 함께 출력한다.
     코딩 작업은 15~60분이 예사다. 타임아웃만을 근거로 상대를 종료·재기동하지 마라
  5  blocked — 에이전트가 권한 확인 등 입력을 기다린다. 시간이 지나도 풀리지 않으므로
     사람이나 조정자가 개입해야 한다
`

// statusFlags is the shared parse result of `status` and `wait`.
type statusFlags struct {
	target    string
	cond      string
	timeoutMS int64
	jsonOut   bool
}

// parseStatusFlags handles the `--flag value` / `--flag=value` duality every
// dmctl subcommand shares (FR-DMA-8). wantCond gates the `--for` flag so
// `status --for x` is a usage error rather than a silently ignored argument.
func parseStatusFlags(cmd string, args []string, wantCond bool, stdout, stderr io.Writer) (statusFlags, int, bool) {
	f := statusFlags{}
	help := dmctlStatusHelp
	if wantCond {
		help = dmctlWaitHelp
	}
	take := func(i int, name string) (string, int, bool) {
		if i+1 >= len(args) {
			fmt.Fprintf(stderr, "%s: flag %s requires value\n", cmd, name)
			return "", 0, false
		}
		return args[i+1], 2, true
	}
	for i := 0; i < len(args); {
		a := args[i]
		step := 1
		switch {
		case a == "-h" || a == "--help":
			fmt.Fprint(stdout, help)
			return f, 0, false
		case a == "--json":
			f.jsonOut = true
		case a == "--at" || a == "-l":
			v, n, ok := take(i, a)
			if !ok {
				return f, 2, false
			}
			f.target, step = v, n
		case strings.HasPrefix(a, "--at="):
			f.target = a[len("--at="):]
		case strings.HasPrefix(a, "-l="):
			f.target = a[len("-l="):]
		case wantCond && a == "--for":
			v, n, ok := take(i, a)
			if !ok {
				return f, 2, false
			}
			f.cond, step = v, n
		case wantCond && strings.HasPrefix(a, "--for="):
			f.cond = a[len("--for="):]
		case wantCond && (a == "--timeout-ms" || strings.HasPrefix(a, "--timeout-ms=")):
			raw := ""
			if a == "--timeout-ms" {
				v, n, ok := take(i, a)
				if !ok {
					return f, 2, false
				}
				raw, step = v, n
			} else {
				raw = a[len("--timeout-ms="):]
			}
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n <= 0 {
				fmt.Fprintf(stderr, "%s: --timeout-ms 는 양의 정수여야 한다: %s\n", cmd, raw)
				return f, 2, false
			}
			f.timeoutMS = n
		default:
			fmt.Fprintf(stderr, "%s: unknown argument: %s\n", cmd, a)
			return f, 2, false
		}
		i += step
	}
	if wantCond && f.cond != "ready" && f.cond != "done" {
		fmt.Fprintf(stderr, "%s: --for 는 ready 또는 done 이어야 한다: %q\n", cmd, f.cond)
		return f, 2, false
	}
	if f.target == "" {
		f.target = selfToolID()
	}
	if f.target == "" {
		fmt.Fprintf(stderr, "%s: 대상 도구를 알 수 없다 — --at <uuid> 를 지정하라\n", cmd)
		return f, 2, false
	}
	return f, 0, true
}

// runDmctlStatus implements FR-STA-1.
func runDmctlStatus(args []string, stdout, stderr io.Writer) int {
	f, code, ok := parseStatusFlags("status", args, false, stdout, stderr)
	if !ok {
		return code
	}
	q := url.Values{}
	q.Set("id", f.target)
	body, code := statusGet(baseURL()+"/api/tools/activity/get?"+q.Encode(), "/api/tools/activity/get", 0, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, body)
		return 0
	}
	var st struct {
		ToolID  string `json:"toolId"`
		Live    bool   `json:"live"`
		State   string `json:"state"`
		Tool    string `json:"tool"`
		Detail  string `json:"detail"`
		QuietMs int64  `json:"quietMs"`
	}
	if err := json.Unmarshal(body, &st); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid status response: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "toolId=%s  live=%v  state=%s%s  quietMs=%d\n",
		st.ToolID, st.Live, st.State, optionalFields(st.Tool, st.Detail), st.QuietMs)
	return 0
}

// runDmctlWait implements FR-STA-2/6/7.
func runDmctlWait(args []string, stdout, stderr io.Writer) int {
	f, code, ok := parseStatusFlags("wait", args, true, stdout, stderr)
	if !ok {
		return code
	}
	q := url.Values{}
	q.Set("id", f.target)
	q.Set("for", f.cond)
	if f.timeoutMS > 0 {
		q.Set("timeoutMs", strconv.FormatInt(f.timeoutMS, 10))
	}
	// 서버가 요청을 붙잡으므로 클라이언트 타임아웃은 서버 상한보다 넉넉해야 한다.
	budget := f.timeoutMS
	if budget <= 0 {
		budget = waitClientDefaultBudgetMS
	}
	body, code := statusGet(baseURL()+"/api/tools/activity/wait?"+q.Encode(),
		"/api/tools/activity/wait", time.Duration(budget)*time.Millisecond+waitClientSlack, stderr)
	if code != 0 {
		return code
	}
	var rec struct {
		ToolID   string `json:"toolId"`
		Status   string `json:"status"`
		Reason   string `json:"reason"`
		State    string `json:"state"`
		Tool     string `json:"tool"`
		Detail   string `json:"detail"`
		QuietMs  int64  `json:"quietMs"`
		WaitedMs int64  `json:"waitedMs"`
	}
	if err := json.Unmarshal(body, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid wait response: %v\n", err)
		return 1
	}
	if f.jsonOut {
		writeRawJSON(stdout, body)
	} else {
		reason := ""
		if rec.Reason != "" {
			reason = "  reason=" + rec.Reason
		}
		fmt.Fprintf(stdout, "status=%s%s  toolId=%s  state=%s%s  waitedMs=%d\n",
			rec.Status, reason, rec.ToolID, rec.State, optionalFields(rec.Tool, rec.Detail), rec.WaitedMs)
	}
	switch rec.Status {
	case "ready", "done":
		return 0
	case "timeout":
		// FR-STA-6: 타임아웃은 실패가 아니다. 그렇게 읽히지 않도록 명시한다.
		fmt.Fprintf(stderr,
			"wait: 타임아웃 — 실패가 아니라 체크포인트다. 마지막 상태 state=%s quietMs=%d. 계속 기다리려면 다시 호출하라.\n",
			rec.State, rec.QuietMs)
		return 4
	case "blocked":
		fmt.Fprintf(stderr,
			"wait: blocked — 에이전트가 입력을 기다린다(state=%s). 시간이 지나도 풀리지 않으니 개입이 필요하다.\n",
			rec.State)
		return 5
	case "gone":
		fmt.Fprintf(stderr, "wait: 대상 도구가 사라졌다 (toolId=%s)\n", rec.ToolID)
		return 1
	}
	fmt.Fprintf(stderr, "dmctl: unknown wait status: %q\n", rec.Status)
	return 1
}

const (
	waitClientDefaultBudgetMS = 300_000
	waitClientSlack           = 10 * time.Second
)

// statusGet performs the GET and maps transport/HTTP failures to exit codes.
// timeout<=0 uses the shared short-lived client.
func statusGet(fullURL, apiPath string, timeout time.Duration, stderr io.Writer) ([]byte, int) {
	var (
		status int
		body   []byte
		err    error
	)
	if timeout > 0 {
		client := &http.Client{Timeout: timeout}
		var resp *http.Response
		resp, err = client.Get(fullURL)
		if err == nil {
			defer resp.Body.Close()
			status = resp.StatusCode
			body, err = io.ReadAll(resp.Body)
		}
	} else {
		status, body, err = httpGet(fullURL)
	}
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return nil, 1
	}
	if status < 200 || status >= 300 {
		printAPIError(stderr, status, apiPath, body)
		return nil, 1
	}
	return body, 0
}

func optionalFields(tool, detail string) string {
	out := ""
	if tool != "" {
		out += "  tool=" + tool
	}
	if detail != "" {
		out += "  detail=" + detail
	}
	return out
}

func writeRawJSON(stdout io.Writer, body []byte) {
	out := strings.TrimRight(string(body), "\n")
	fmt.Fprintln(stdout, out)
}
