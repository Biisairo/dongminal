package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// TAB_NAME_DELIVERY_SRS 묶음 C: rename 은 반영을 확인하고, 반영되지 않으면 다시 보낸다.
//
//	이전 동작: 배달되면 exit 0 — 브라우저의 저장이 409 로 버려져 이름이 사라져도 몰랐다
//	새  동작: 서버 워크스페이스에 이름이 남았는지 확인한다. 없으면 다시 보내고, 상한까지
//	          남지 않으면 exit 1
//	이유:     `renameTab` 은 결과를 기다리지 않는 방송이고, 409 를 받은 저장은 다시
//	          시도하지 않는다(FR-WSC-1). 이슈 트리의 사슬 이름이 그 틈으로 사라졌다

// FR-TND-12: 확인 창 · 확인 간격 · 전송 상한. 앞의 둘은 시험이 줄인다.
var (
	renameConfirmWindow   = 1500 * time.Millisecond
	renameConfirmInterval = 100 * time.Millisecond
)

const renameMaxSends = 3

// renameWant 는 반영의 조건이다 (FR-TND-11).
type renameWant struct {
	tabID  string
	name   string
	window bool
	auto   bool
}

func dmctlRenameConfirmed(action string, args map[string]any, want renameWant, stdout, stderr io.Writer) int {
	out := stdout
	for range renameMaxSends {
		if code := dmctlPost(action, args, out, stderr); code != 0 {
			return code
		}
		// FR-TND-16: 호출자는 stdout 을 응답 하나로 읽는다.
		out = io.Discard
		applied, known := waitRenameApplied(want)
		if applied || !known {
			return 0
		}
	}
	target := fmt.Sprintf("이름 %q", want.name)
	if want.auto {
		target = "자동 이름"
	}
	fmt.Fprintf(stderr, "dmctl: %s 이 반영되지 않았습니다 (탭 %s, %d번 보냄) — 다른 화면의 저장과 겹쳤을 수 있습니다\n",
		target, want.tabID, renameMaxSends)
	return 1
}

// waitRenameApplied 는 확인 창 안에서 반영을 기다린다. known 이 거짓이면 판정할 수
// 없는 서버다 (FR-TND-14).
func waitRenameApplied(want renameWant) (applied, known bool) {
	deadline := time.Now().Add(renameConfirmWindow)
	for {
		applied, known = renameApplied(want)
		if applied || !known || !time.Now().Before(deadline) {
			return applied, known
		}
		time.Sleep(renameConfirmInterval)
	}
}

// renameApplied 는 `/api/state` 한 번으로 판정한다. 조회 실패는 미반영이다 (FR-TND-15).
func renameApplied(want renameWant) (applied, known bool) {
	status, body, err := httpGet(baseURL() + "/api/state")
	if err != nil || status != http.StatusOK {
		return false, true
	}
	var state struct {
		Workspace *wsTree `json:"workspace"`
	}
	if json.Unmarshal(body, &state) != nil {
		return false, true
	}
	if state.Workspace == nil {
		return false, false
	}
	for _, w := range state.Workspace.Windows {
		var panes []*wsLayout
		collectPanes(w.Layout, &panes)
		for _, p := range panes {
			for _, t := range p.Tabs {
				if t.ID == want.tabID {
					return renameMatches(want, w, t), true
				}
			}
		}
	}
	return false, true
}

func renameMatches(want renameWant, w wsWindow, t wsTab) bool {
	switch {
	case want.window:
		return w.Name == want.name
	case want.auto:
		return t.Name == defaultTabName && t.NameSource != nameSourceManual
	default:
		return t.Name == want.name && t.NameSource == nameSourceManual
	}
}
