package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
)

// 묶음 P — 동료 명부의 CLI 절반 (ORCHESTRATION_V2_SRS FR-PAT-5).
//
// 멤버가 다른 멤버에게 직접 말하려면 상대 uuid 를 알아야 하는데, 프리앰블은
// `run member` 시점에 조립되므로 그때 아직 없는 동료를 담을 수 없다. 명부를
// 프리앰블에 박지 않고 **필요할 때 조회**하는 이유는 명부가 승계·이탈로 변하기
// 때문이다 — 박으면 낡는다.

// runPeer 는 명부 한 줄이다. to 는 `dmctl msg --to` 에 그대로 넣는 값이다.
type runPeer struct {
	Role     string `json:"role"`
	MemberID string `json:"memberId"`
	To       string `json:"to"`
	State    string `json:"state"`
	Headless bool   `json:"headless"`
}

// runSubPeers implements `dmctl run peers` (FR-PAT-5). 인자가 없다 — 호출자의
// 정체($DONGMINAL_TOOL_ID)로 소속 Run 을 찾는다.
func runSubPeers(f runFlags, stdout, stderr io.Writer) int {
	q := url.Values{}
	if id := selfToolID(); id != "" {
		q.Set("toolId", id)
	}
	path := "/api/runs/peers"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	raw, code := runGet(path, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var got struct {
		Peers []runPeer `json:"peers"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid peers response: %v\n", err)
		return 1
	}
	if len(got.Peers) == 0 {
		fmt.Fprintln(stdout, "(동료 없음)")
		return 0
	}
	for _, p := range got.Peers {
		fmt.Fprintf(stdout, "role=%s  member=%s  to=%s  state=%s  headless=%v\n",
			p.Role, p.MemberID, p.To, p.State, p.Headless)
	}
	return 0
}
