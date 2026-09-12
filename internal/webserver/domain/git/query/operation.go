package query

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// 진행 중 작업 (GIT_ACTIONS_SRS §3.1 / FR-GIT-251).
//
// merge·rebase·cherry-pick·revert 는 충돌하면 **중간 상태**를 남기고 멈춘다. 그
// 상태가 무엇인지 보이지 않으면 사용자는 GUI 안에 갇힌다 — 무엇을 하다 멈췄는지
// 모르면 계속할지 중단할지 고를 수 없다. 그래서 이 판정이 다른 묶음의 전제다.
//
// **git 을 실행하지 않는다.** 표식은 gitdir 안의 파일·디렉터리이고 존재 여부가
// 그대로 답이다 (preflight 가 이미 쓰는 근거, FR-GIT-86).

// 작업 종류. 클라이언트가 이 문자열로 분기하므로 한 자리에 둔다.
const (
	OpNone       = ""
	OpMerge      = "merge"
	OpRebase     = "rebase"
	OpCherryPick = "cherry-pick"
	OpRevert     = "revert"
	// GIT_DETECT_TIER_SRS FR-GDT-19 (`11 GP-18`): **`git am` 은 리베이스가
	// 아니다.**
	//
	//   이전 동작: `rebase-apply` 디렉터리를 `rebase` 로만 읽었다. `git am` 도
	//             그 디렉터리를 만들므로 화면은 "리베이스가 진행 중입니다" 라
	//             적고 출구 버튼이 `git rebase --continue/--abort` 를 냈다 —
	//             **`git am` 진행 중에 그 명령은 맞지 않는다**
	//   새  동작: `rebase-apply/applying` 이 있으면 `am` 이다
	//   이유:     git 자신이 `wt-status.c` 에서 같은 판정을 한다 (D-GDT-6)
	OpAm = "am"
	// FR-GDT-18 (`11 GP-11g`): bisect 는 감지·표시·출구가 **전부 없었다.**
	// 화면에는 detached HEAD 로만 보이고 나갈 길이 없다.
	OpBisect = "bisect"
)

// 리베이스의 진행 위치를 담은 파일. 백엔드가 둘이라 이름도 둘이다 (git 2.50.1).
const (
	rebaseMergeMsgNum = "msgnum"
	rebaseMergeEnd    = "end"
	rebaseApplyNext   = "next"
	rebaseApplyLast   = "last"
)

// operationMarkers 는 표식과 작업 종류의 대응이며 **이 표가 유일한 근거다** —
// preflight 의 차단 판정(inProgressChecks)도 여기서 이름을 받는다. 두 벌로 두면
// 한쪽만 고쳐져, 커밋은 막히는데 출구는 안 보이는 상태가 된다.
//
// **순서가 우선순위다.** git 은 리베이스를 sequencer 로 돌리므로 리베이스 중의
// 충돌은 CHERRY_PICK_HEAD 를 함께 남긴다 — 뒤집으면 "리베이스 중"이 "체리픽 중"으로
// 보이고, 사용자는 `cherry-pick --abort` 를 눌러 리베이스를 깬다.
var operationMarkers = []struct {
	kind  string
	names []string
}{
	// `am` 이 `rebase` 보다 앞이다 — 둘 다 `rebase-apply` 를 만들고, 더 좁은
	// 판정(`applying` 이 함께 있다)이 먼저 서야 한다 (FR-GDT-19).
	{OpAm, []string{filepath.Join(rebaseApplyDir, rebaseApplying)}},
	{OpRebase, []string{rebaseMergeDir, rebaseApplyDir}},
	{OpCherryPick, []string{cherryPickHeadFile}},
	{OpRevert, []string{revertHeadFile}},
	{OpMerge, []string{mergeHeadFile}},
	// bisect 는 **맨 뒤다.** 위의 어느 것도 진행 중이 아닐 때만 "bisect 중" 이
	// 그 저장소의 상태다 — bisect 중의 체크아웃이 충돌을 남기면 그 충돌이 먼저다.
	{OpBisect, []string{bisectLogFile}},
}

// markersOf 는 한 종류의 표식 이름들이다. preflight 가 자기 차단 목록을 세울 때
// 이것을 부른다 — 파일 이름을 두 곳에 적지 않는다.
func markersOf(kind string) []string {
	for _, m := range operationMarkers {
		if m.kind == kind {
			return m.names
		}
	}
	return nil
}

// Operation 은 지금 저장소에 남아 있는 중간 상태다 (FR-GIT-251).
type Operation struct {
	Kind string `json:"kind"` // none("") | merge | rebase | cherry-pick | revert
	// At·Total 은 리베이스의 "몇 번째 중"이다. 알 수 없으면 0 이며, 그것은 오류가
	// 아니다 — 위치 파일은 백엔드와 단계에 따라 없을 수 있다.
	At    int `json:"at,omitempty"`
	Total int `json:"total,omitempty"`
}

func (o Operation) InProgress() bool { return o.Kind != OpNone }

// DetectOperation 은 gitdir 의 표식만 읽는다.
func DetectOperation(gitDir string) Operation {
	for _, m := range operationMarkers {
		if !anyExists(gitDir, m.names) {
			continue
		}
		op := Operation{Kind: m.kind}
		// 진행 위치는 두 백엔드가 같은 파일 이름을 쓴다 — `am` 도 `rebase-apply`
		// 의 `next`/`last` 에 자기 위치를 적는다.
		if m.kind == OpRebase || m.kind == OpAm {
			op.At, op.Total = rebaseProgress(gitDir)
		}
		return op
	}
	return Operation{Kind: OpNone}
}

// rebaseProgress 는 "몇 번째 중"을 읽는다. 전체 수를 얻지 못하면 위치도 뜻이
// 없으므로 둘 다 0 이다 — 반쪽짜리 진행 표시는 없는 것보다 나쁘다.
func rebaseProgress(gitDir string) (at, total int) {
	for _, b := range []struct{ dir, at, total string }{
		{rebaseMergeDir, rebaseMergeMsgNum, rebaseMergeEnd},
		{rebaseApplyDir, rebaseApplyNext, rebaseApplyLast},
	} {
		if t := readNum(filepath.Join(gitDir, b.dir, b.total)); t > 0 {
			return readNum(filepath.Join(gitDir, b.dir, b.at)), t
		}
	}
	return 0, 0
}

// readNum 은 한 줄짜리 숫자 파일을 읽는다. 없거나 숫자가 아니면 0 이다 — 진행
// 표시 때문에 관측 전체가 실패해서는 안 된다.
func readNum(p string) int {
	body, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(body)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}
