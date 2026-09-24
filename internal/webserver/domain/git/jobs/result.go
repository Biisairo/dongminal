package jobs

import "dongminal/internal/webserver/domain/git/query"

// job.go 는 원격 표면이라 자격증명처럼 읽히는 이름을 두지 않는다
// (core 의 정적 부재 검사). undo 토큰은 자격증명이 아니지만 그 검사를 약하게
// 만들지 않으려고 결과 타입을 여기 둔다.

// Result 는 완료 처리가 채우는 잡의 결과다 (§6.3). 잡 자신은 저장소 관측을 모르므로
// 시작한 쪽(OnFinish)이 채운다.
type Result struct {
	Status      *query.Status `json:"status,omitempty"`      // index 잡 — 쓰기 이후 관측
	StatusError string        `json:"statusError,omitempty"` // 사후 재조회 실패
	Partial     bool          `json:"partial,omitempty"`     // 실패 시 before 대비 변화
	Changed     []string      `json:"changed,omitempty"`
	Oid         string        `json:"oid,omitempty"` // commit 성공
	UndoToken   string        `json:"undoToken,omitempty"`
	Path        string        `json:"path,omitempty"` // worktree 잡 성공
	Branch      string        `json:"branch,omitempty"`
}
