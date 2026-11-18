package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
)

// runSubRecover 는 `dmctl run recover` 다 (RUN_RECOVERY_SRS FR-RRC-24). 판정과 재개는 서버가
// 한다 — 이 명령은 요청을 보내고 대상마다 한 줄을 낸다. 재개한 대상이 있으면 0, 없으면 1, 요청 오류는 2 다.
func runSubRecover(f runFlags, stdout, stderr io.Writer) int {
	switch {
	case f.run == "":
		fmt.Fprintln(stderr, "run recover: --run 은 필수다")
		return 2
	case f.member != "" && f.coord:
		fmt.Fprintln(stderr, "run recover: --member 와 --coordinator 는 함께 줄 수 없다")
		return 2
	case f.force && f.member == "" && !f.coord:
		fmt.Fprintln(stderr, "run recover: --force 는 --member 나 --coordinator 와 함께일 때만 받는다")
		return 2
	}
	body := map[string]any{"runId": f.run}
	if f.member != "" {
		body["memberId"] = f.member
	}
	if f.coord {
		body["coordinator"] = true
	}
	if f.force {
		body["force"] = true
	}
	// 요청이 닿지 않았거나 서버가 거절했으면 요청 오류다 — "재개한 대상 없음"(1)과 가른다.
	raw, code := runPost("/api/runs/recover", body, stderr)
	if code != 0 {
		return 2
	}
	var resp struct {
		Results []struct {
			Target     string `json:"target"`
			MemberID   string `json:"memberId"`
			Outcome    string `json:"outcome"`
			Reason     string `json:"reason"`
			NeedsForce bool   `json:"needsForce"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid recover response: %v\n", err)
		return 1
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
	}
	resumed := 0
	for _, r := range resp.Results {
		if r.Outcome == "resumed" {
			resumed++
		}
		if r.NeedsForce {
			fmt.Fprintf(stderr, "run recover: %s %s — 셸에 에이전트가 없는지 판정하지 못했다. 화면을 확인했으면 --force 로 다시 부른다\n",
				r.Target, r.MemberID)
		}
		if f.jsonOut {
			continue
		}
		who := r.Target
		if r.MemberID != "" {
			who += " " + r.MemberID
		}
		fmt.Fprintf(stdout, "%s  %s", who, r.Outcome)
		if r.Reason != "" {
			fmt.Fprintf(stdout, "  %s", r.Reason)
		}
		fmt.Fprintln(stdout)
	}
	if resumed == 0 {
		return 1
	}
	return 0
}
