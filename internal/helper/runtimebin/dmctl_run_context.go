package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// 묶음 C — 컨텍스트 예산과 승계의 CLI 절반 (ORCHESTRATION_V2_SRS FR-CBG-*).
//
// 서버는 등급과 경고까지만 낸다. 멤버를 교체할지 정하고 그 절차를 부르는 것은
// **조정자**다 — 서버가 에이전트를 대신 판단하지 않는다.

// succeedResponse 는 POST /api/runs/succeed 의 응답이다.
type succeedResponse struct {
	Member struct {
		runMember
		Preamble string `json:"preamble"`
	} `json:"member"`
	PrevMemberID string `json:"prevMemberId"`
	PrevState    string `json:"prevState"`
	HasSummary   bool   `json:"hasSummary"`
}

// runSubSucceed implements
// `dmctl run succeed --member <uuid> (--at <탭> | --headless) [--model <m>] [--timeout-ms N]`
// (FR-CBG-9). 인수인계 요약을 매개로 같은 역할·brief·worktree 를 물려준다.
//
// 이 명령은 **오래 걸릴 수 있다.** 이전 멤버에게 요약을 청하고 기다리기 때문이며,
// 기다리는 상한이 --timeout-ms 다. 무응답 멤버를 교체하는 것이 승계의 본래
// 쓰임이므로, 시한을 넘겨도 실패가 아니라 요약 없는 승계로 성공한다.
func runSubSucceed(f runFlags, stdout, stderr io.Writer) int {
	if f.member == "" {
		fmt.Fprintln(stderr, "run succeed: --member 는 필수다 (승계당할 멤버의 uuid)")
		return 2
	}
	if f.at == "" && !f.headless {
		fmt.Fprintln(stderr, "run succeed: --at <탭 uuid> 또는 --headless 중 하나가 필요하다 — 새 멤버가 들어앉을 자리다")
		return 2
	}
	if f.at != "" && f.headless {
		fmt.Fprintln(stderr, "run succeed: --at 과 --headless 는 함께 쓸 수 없다. 새 멤버는 탭에 앉거나 헤드리스이거나 둘 중 하나다")
		return 2
	}
	body := map[string]any{
		"memberId": f.member, "at": f.at, "headless": f.headless, "toolId": selfToolID(),
	}
	if f.timeoutMs != "" {
		ms, err := strconv.Atoi(f.timeoutMs)
		if err != nil || ms < 0 {
			fmt.Fprintf(stderr, "run succeed: --timeout-ms 는 0 이상의 정수여야 한다: %q\n", f.timeoutMs)
			return 2
		}
		body["timeoutMs"] = ms
	}
	raw, code := runPost("/api/runs/succeed", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var resp succeedResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid succeed response: %v\n", err)
		return 1
	}
	m := resp.Member
	line := fmt.Sprintf("succeeded  prev=%s (%s)  →  member=%s  role=%s  toolId=%s  tabId=%s",
		resp.PrevMemberID, resp.PrevState, m.ID, m.Role, m.ToolID, m.TabID)
	if m.Worktree != nil && m.Worktree.Path != "" {
		line += fmt.Sprintf("  worktree=%s", m.Worktree.Path)
	}
	fmt.Fprintln(stdout, line)
	// 인수인계가 실제로 있었는지를 **명시한다.** 없는 것을 없다고 말하지 않으면
	// 조정자가 후임에게 있지도 않은 맥락을 전제한 지시를 준다 (V-CBG-7).
	if resp.HasSummary {
		fmt.Fprintln(stdout, "  인수인계 요약 있음 — 새 멤버의 프리앰블에 실렸다")
	} else {
		fmt.Fprintln(stdout, "  인수인계 요약 없음 — 이전 멤버가 답하지 않았다. 프리앰블에 그 사실이 적혀 있다")
	}
	if m.Worktree != nil && m.Worktree.Path != "" {
		fmt.Fprintln(stdout, "  작업 트리는 새로 만들지 않았다 — 이전 멤버의 트리를 그대로 쓴다")
	}
	// 이전 멤버의 도구는 살아 있다 (FR-CBG-12). 정리는 조정자의 몫이며, 그
	// 사실을 여기서 말하지 않으면 아무도 치우지 않는다.
	fmt.Fprintln(stdout, "  이전 멤버의 도구는 그대로 살아 있다 — 인수인계를 다 읽었으면 /exit → close-tab 으로 정리해라")
	launch := "dmctl run launch --member " + m.ID
	if f.model != "" {
		launch += " --model " + f.model
	}
	fmt.Fprintf(stdout, "  다음: %s\n", launch)
	return 0
}

// runSubHandoff implements `dmctl run handoff [--member <uuid>] --summary -`
// (FR-CBG-9 의 1단계 응답). 승계 대상 멤버가 **자기 자신에 대해서만** 호출한다 —
// 발신자 정체 기반 권한이며, --member 는 대조용이라 생략이 정상이다.
func runSubHandoff(f runFlags, stdin io.Reader, stdout, stderr io.Writer) int {
	// 요약은 보통 여러 줄이다. 값 - 는 stdin 을 뜻하며 --brief·msg 와 같은
	// 규약이다. 지목하지 않았으면 읽지 않는다 — 읽으면 파이프 없는 호출이 멈춘다.
	if f.summary == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "run handoff: stdin 읽기 실패: %v\n", err)
			return 2
		}
		f.summary = strings.TrimRight(string(data), "\n")
	}
	if strings.TrimSpace(f.summary) == "" {
		fmt.Fprintln(stderr, "run handoff: --summary 는 필수다 (무엇을 했는가 / 어디까지 왔는가 / 다음에 무엇을 / 함정)")
		return 2
	}
	body := map[string]any{"summary": f.summary, "toolId": selfToolID()}
	if f.member != "" {
		body["memberId"] = f.member
	}
	raw, code := runPost("/api/runs/handoff", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var resp struct {
		MemberID string `json:"memberId"`
		Len      int    `json:"len"`
	}
	_ = json.Unmarshal(raw, &resp)
	fmt.Fprintf(stdout, "handoff  member=%s  %d바이트를 남겼다 — 후임의 프리앰블에 실린다\n", resp.MemberID, resp.Len)
	return 0
}
