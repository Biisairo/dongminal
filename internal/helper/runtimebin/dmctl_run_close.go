package runtimebin

import (
	"fmt"
	"io"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `dmctl_run.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **`run close` 의 보고서**다 — 무엇을 닫았고 무엇이 남았는가를
// 사람이 읽을 모양으로 찍는다. `dmctl_run.go` 에 남은 것은 서브커맨드의 갈래와
// 인자 해석이며, 보고서의 모양이 바뀌어도 그 갈래는 바뀌지 않는다.

type closeResponse struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Cleanup []struct {
		Role   string `json:"role"`
		ToolID string `json:"toolId"`
		TabID  string `json:"tabId"`
		Live   bool   `json:"live"`
	} `json:"cleanup"`
	Worktrees []runWorktree `json:"worktrees"`
	Swept     bool          `json:"swept"`
	// 묶음 H — 헤드리스 도구의 수명 (FR-HLM-4/5). KeptTools 는 --keep-tools 로
	// 살려 둔 것이고, Orphans 는 그 결과 남은 것이다. 둘은 같은 도구를 가리키지만
	// 하나는 **선택**의 보고이고 하나는 **상태**의 보고다.
	KeptTools []runOrphan `json:"keptTools"`
	Orphans   []runOrphan `json:"orphans"`
	// UX_BATCH6_SRS FR-RUN-9: 서버가 **실제로 닫은** 탭. `Cleanup` 이 대상의
	// 목록이라면 이쪽은 결과의 목록이다.
	ClosedTabs []struct {
		Role   string `json:"role"`
		TabID  string `json:"tabId"`
		Exited bool   `json:"exited"`
		Empty  bool   `json:"empty"`
	} `json:"closedTabs"`
}

// printCloseReport 는 close 의 사람용 보고다 — 닫은 것·남은 것·보존한 것·잔여물 순.
func printCloseReport(stdout io.Writer, rec closeResponse) {
	if rec.Swept {
		fmt.Fprintf(stdout, "run=%s  state=%s  (정리 전용 — 상태는 바꾸지 않았다)\n", rec.ID, rec.State)
	} else {
		fmt.Fprintf(stdout, "run=%s  state=%s\n", rec.ID, rec.State)
	}
	/**
	 * UX_BATCH6_SRS FR-RUN-6·9: **닫는 일은 서버가 이미 했다.**
	 *
	 *   이전 동작: "정리 대상 (에이전트 종료 후 dmctl close-tab --at …)" 를 내고
	 *             조정자가 그 목록대로 쳤다
	 *   새  동작: 무엇을 닫았는지 보고한다. 칠 것이 남지 않는다
	 *   이유:     접수 ⑩·⑬ — 그 절차를 건너뛴 조정자가 탭과 창을 남겼다
	 *
	 * 닫지 못한 것이 있으면 그것만 남긴다 — 조용히 사라지는 자원이 없어야 한다는
	 * 규약은 잔여물·보존 도구와 같다.
	 */
	if len(rec.ClosedTabs) > 0 {
		fmt.Fprintf(stdout, "탭 %d건 정리:\n", len(rec.ClosedTabs))
		for _, c := range rec.ClosedTabs {
			if c.Empty {
				fmt.Fprintf(stdout, "  tabId=%s  (빈 탭)\n", c.TabID)
				continue
			}
			note := ""
			if !c.Exited {
				note = "  (에이전트가 시한 안에 끝나지 않았다)"
			}
			fmt.Fprintf(stdout, "  role=%s  tabId=%s%s\n", c.Role, c.TabID, note)
		}
	}
	printCloseLeftTabs(stdout, rec)
	// 보존은 선택이므로 그 선택을 되짚어 준다 (FR-HLM-4). 보존도 **보고**된다.
	if len(rec.KeptTools) > 0 {
		fmt.Fprintf(stdout, "헤드리스 도구 %d건 보존 (--keep-tools):\n", len(rec.KeptTools))
		for _, o := range rec.KeptTools {
			fmt.Fprintf(stdout, "  role=%s  toolId=%s  memberId=%s\n", o.Role, o.ToolID, o.MemberID)
		}
	}
	printOrphans(stdout, rec.Orphans)
	printCloseResidue(stdout, rec.Worktrees)
}

// printCloseLeftTabs 는 닫히지 않은 채 남은 멤버 탭이다. `--keep-tools` 를 주었거나
// 도구가 이미 죽어 대상에서 빠진 경우이며, 그 사실을 조정자가 알아야 한다.
func printCloseLeftTabs(stdout io.Writer, rec closeResponse) {
	closed := map[string]bool{}
	for _, c := range rec.ClosedTabs {
		closed[c.TabID] = true
	}
	var left []int
	for i, c := range rec.Cleanup {
		if c.TabID != "" && !closed[c.TabID] {
			left = append(left, i)
		}
	}
	if len(left) == 0 {
		return
	}
	fmt.Fprintln(stdout, "남은 탭 (필요하면 dmctl close-tab --at <tabId>):")
	for _, i := range left {
		c := rec.Cleanup[i]
		fmt.Fprintf(stdout, "  role=%s  toolId=%s  tabId=%s  live=%v\n", c.Role, c.ToolID, c.TabID, c.Live)
	}
}

// printCloseResidue 는 잔여물이다 — 조용히 남기지 않는다 (FR-WKT-12). 지운 것은 굳이
// 나열하지 않는다: 목록이 길어지면 정작 남은 것이 묻힌다.
func printCloseResidue(stdout io.Writer, trees []runWorktree) {
	var left []runWorktree
	for _, wt := range trees {
		if !wt.Removed {
			left = append(left, wt)
		}
	}
	if len(left) == 0 {
		return
	}
	fmt.Fprintf(stdout, "잔여물 %d건 (지우지 않았다):\n", len(left))
	for _, wt := range left {
		line := fmt.Sprintf("  %s  branch=%s  사유=%s", wt.Path, wt.Branch, wt.Residue)
		if wt.Detail != "" {
			line += "  (" + wt.Detail + ")"
		}
		fmt.Fprintln(stdout, line)
	}
}

// M8_UNIFIED_SRS D-A-1 (FBE-01 클라이언트 절반): 서버가 요청을 붙잡는 종단은 그 상한에
// 여유를 더한 예산으로 부른다. 상한은 `shared/runwait` — 서버와 같은 수다.
//
// 종전에는 전 서브커맨드가 10초 공용 클라이언트였다. `succeed` 의 정상 경로(요약 작성에
// 수십 초)가 늘 `context deadline exceeded` 로 끝났고, 그동안 서버는 승계를 마쳤다 —
// 재시도가 멤버와 도구를 둘씩 만들었다.
