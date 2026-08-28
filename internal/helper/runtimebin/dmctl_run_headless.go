package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
)

// 묶음 H — 헤드리스 멤버의 CLI 절반 (ORCHESTRATION_V2_SRS §3.2.2).
//
// 헤드리스 멤버는 탭을 점유하지 않는다. 관찰이 필요한 순간에만 attach 로 탭에
// 붙이고, 끝나면 detach 로 되돌린다. 부착·분리는 멤버의 `state`·`outcome`·컨텍스트
// 관측을 **바꾸지 않는다** (FR-HLM-8) — 관찰 행위가 관찰 대상을 바꾸지 않는다.

// runSubAttach implements `dmctl run attach --member <uuid> [--at <탭 uuid>]`
// (FR-HLM-6). --at 이 없으면 브라우저의 현재 포커스 분할 칸에 새 탭을 만든다.
func runSubAttach(f runFlags, stdout, stderr io.Writer) int {
	if f.member == "" {
		fmt.Fprintln(stderr, "run attach: --member 는 필수다 (run member 가 낸 uuid)")
		return 2
	}
	body := map[string]any{"memberId": f.member}
	if f.at != "" {
		body["location"] = f.at
	}
	return runAttachPost("/api/runs/attach", body, "부착", stdout, stderr)
}

// runSubDetach implements `dmctl run detach --member <uuid>` (FR-HLM-7).
// 탭은 닫히고 도구는 산다 — 에이전트 프로세스는 죽지 않는다.
func runSubDetach(f runFlags, stdout, stderr io.Writer) int {
	if f.member == "" {
		fmt.Fprintln(stderr, "run detach: --member 는 필수다 (run member 가 낸 uuid)")
		return 2
	}
	// --at 은 부착 대상을 가리키는 인자다. 분리에는 대상 개념이 없으므로 단독
	// 사용은 오해다 — 조용히 무시하지 않는다 (기존 detach 헬퍼의 FR-BGR-3 과
	// 같은 규약).
	if f.at != "" {
		fmt.Fprintln(stderr, "run detach: --at 은 run attach 와 함께만 쓴다")
		return 2
	}
	return runAttachPost("/api/runs/detach", map[string]any{"memberId": f.member}, "분리", stdout, stderr)
}

// memberToolID resolves a member uuid to its live toolId (FR-HLM-11).
//
// **접합면에는 toolId 만 넘긴다.** 멤버 uuid 를 `id` 에 섞으면 ResolveStrict 가
// 라벨·uuid·toolId 를 가르는 규약(FR-IDU-1/4)에 네 번째 종류가 생긴다 — 그러면
// workspace 계층이 Run 도메인을 알아야 하고 의존 방향이 뒤집힌다. 그래서 해석은
// 여기서, 서버에 가기 **전에** 끝낸다.
//
// 조회에 프리앰블 종단을 쓰는 이유는 그것이 **멤버 uuid 하나로 부르는 유일한
// 종단**이기 때문이다 (FR-PRE-1). 본문이 함께 오지만 버린다 — 왕복 하나를 더
// 만드는 것보다 낫다.
func memberToolID(memberID string, stderr io.Writer) (string, int) {
	q := url.Values{}
	q.Set("member", memberID)
	raw, code := runGet("/api/runs/preamble?"+q.Encode(), stderr)
	if code != 0 {
		return "", code
	}
	var got struct {
		ToolID string `json:"toolId"`
		Role   string `json:"role"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid member response: %v\n", err)
		return "", 1
	}
	if got.ToolID == "" {
		// 도구 없는 멤버는 기다릴 대상이 없다. 조용히 현재 셸로 떨어지면 엉뚱한
		// 도구의 상태를 그 멤버의 것으로 읽는다.
		fmt.Fprintf(stderr, "dmctl: 멤버 %s (role=%s) 에 도구가 없다\n", memberID, got.Role)
		return "", 1
	}
	return got.ToolID, 0
}

// runAttachPost 는 부착·분리의 공통 절반이다. 둘의 응답은 같은 멤버 뷰이고,
// 사람이 읽을 한 줄도 같다 — 달라지는 것은 동사뿐이다.
func runAttachPost(path string, body map[string]any, verb string, stdout, stderr io.Writer) int {
	raw, code := runPost(path, body, stderr)
	if code != 0 {
		return code
	}
	var m runMember
	if err := json.Unmarshal(raw, &m); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid %s response: %v\n", path, err)
		return 1
	}
	// tabId 를 낸다 — 부착 직후 조정자가 read-screen·close-tab 에 쓸 값이고,
	// 분리 후에는 비어 있는 것이 곧 "화면에 없다"의 확인이다.
	fmt.Fprintf(stdout, "%s  member=%s  role=%s  toolId=%s  tabId=%s  state=%s\n",
		verb, m.ID, m.Role, m.ToolID, m.TabID, m.State)
	return 0
}
