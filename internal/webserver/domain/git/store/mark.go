package store

import (
	"fmt"
	"hash/fnv"
	"strconv"

	"dongminal/internal/webserver/domain/git/query"
)

// REPO_FIX 04 §3A-0 X5: hub/gitwatch.go 에서 옮겼다 — git_changed 방송과 status 응답이
// 같은 함수로 관측 식별자를 만든다.

// Mark 는 관측 하나를 비교 가능한 한 줄로 접는다.
//
// **무엇이 바뀌면 알려야 하는가** 의 정의다. signature 는 `.git` 의 변화를,
// 파일 수와 그 목록의 해시는 작업 트리의 변화를 잡는다. 브랜치·ahead/behind 는
// 화면 머리글이 그것으로 서므로 함께 본다.
//
// 파일 목록 전체를 문자열로 잇지 않는 이유는 수천 개일 수 있기 때문이다 —
// 이름과 상태만 순서대로 접는다. 순서는 `git status` 가 정하므로 결정적이다.
func Mark(o Observation) string {
	h := fnv.New64a()
	fmt.Fprintf(h, "%s|%s|%s|%t|%d|%d|",
		o.Signature.Value, o.Status.Oid, o.Status.Branch, o.Status.Detached,
		o.Status.Ahead, o.Status.Behind)
	// GIT_DETECT_TIER_SRS FR-GDT-17 (`11 GP-11e`): **진행 중 작업도 근거다.**
	//
	//   이전 동작: `Operation` 이 빠져 있었다. `cherry-pick --quit` 처럼 표식만
	//             사라지는 조작은 HEAD 도 index 도 파일 목록도 건드리지 않으므로
	//             obsMark 가 그대로였고, "진행 중" 바가 화면에 굳은 채 남았다
	//   새  동작: 종류와 진행 위치를 싣는다
	//   이유:     그 바는 관측을 딛는 화면이고, 관측의 근거에 없는 것은 화면에서
	//             갱신되지 않는다 (FR-RPT-2 의 서버 쪽 짝이다)
	fmt.Fprintf(h, "%s:%d/%d|", o.Status.Operation.Kind, o.Status.Operation.At, o.Status.Operation.Total)
	// Conflicts 가 빠져 있었다. 머지가 멈춘 동안 사용자가 손대는 것이 바로 그
	// 파일들인데, 그 변화만 방송이 잡지 못해 30초 안전망까지 화면이 낡았다.
	for _, g := range [][]query.FileEntry{
		o.Status.Staged, o.Status.Changes, o.Status.Untracked, o.Status.Conflicts,
	} {
		fmt.Fprintf(h, "#%d", len(g))
		for _, f := range g {
			fmt.Fprintf(h, "%s:%s:%s;", f.Path, f.XY, f.Sub)
		}
	}
	return strconv.FormatUint(h.Sum64(), 36)
}
