package apierr

import (
	"fmt"
	"net/http"
	"testing"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/domain/wsentry"
)

// /api/runs/* 의 sentinel → (status, code) 전수. 리팩터 **전** `writeRunError`
// 의 19-case switch 를 그대로 옮겨 온 것이다 (§4.1 V3).
//
// 이 표면의 코드는 sentinel 의 메시지 그 자체다 — 원본이 `err.Error()` 를 실었고
// 그 계약을 유지한다.
func TestRunsTableMatchesPreRefactorBehavior(t *testing.T) {
	cases := []struct {
		sentinel error
		status   int
	}{
		{run.ErrUnknownRun, http.StatusNotFound},
		{run.ErrSenderNotMember, http.StatusForbidden},
		{run.ErrUnknownMember, http.StatusNotFound},
		{run.ErrRunMemberMismatch, http.StatusForbidden},
		{run.ErrRunClosed, http.StatusConflict},
		{run.ErrRunOpen, http.StatusConflict},
		{run.ErrAlreadyReported, http.StatusConflict},
		{run.ErrToolAlreadyMember, http.StatusConflict},
		{run.ErrMemberAttached, http.StatusConflict},
		{run.ErrMemberNotAttached, http.StatusConflict},
		{run.ErrUnreportedMembers, http.StatusConflict},
		{run.ErrInvalidArgument, http.StatusBadRequest},
		// 격리 실패는 사유를 뭉뚱그리지 않는다 (FR-WKT-11).
		{worktree.ErrNotRepo, http.StatusBadRequest},
		{worktree.ErrGitMissing, http.StatusBadRequest},
		{worktree.ErrUnsafeArgument, http.StatusBadRequest},
		{worktree.ErrUnsafePath, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.sentinel.Error(), func(t *testing.T) {
			status, code, ok := Runs.Lookup(fmt.Errorf("%w: 세부", c.sentinel))
			if !ok {
				t.Fatalf("%v 에 규칙이 없다", c.sentinel)
			}
			if status != c.status {
				t.Errorf("상태 %d, want %d", status, c.status)
			}
			// 이 표면의 계약: 코드 == sentinel 의 메시지.
			if code != c.sentinel.Error() {
				t.Errorf("코드 %q, want %q (sentinel 메시지)", code, c.sentinel.Error())
			}
		})
	}
	if len(cases) != len(Runs) {
		t.Errorf("표가 %d 줄인데 Runs 테이블은 %d 줄 — 검사되지 않는 규칙이 있다",
			len(cases), len(Runs))
	}
}

// **같은 sentinel 이 표면에 따라 다른 상태를 갖는다.** 이것이 테이블을 하나로
// 뭉치지 않은 이유다 — 뭉치면 둘 중 하나가 조용히 틀린다.
func TestWorktreeStatusDiffersPerSurface(t *testing.T) {
	gitStatus, _, _ := Git.Lookup(worktree.ErrNotRepo)
	runStatus, _, _ := Runs.Lookup(worktree.ErrNotRepo)

	if gitStatus != http.StatusNotFound {
		t.Errorf("/api/git/worktrees 는 404 여야 한다 (지목한 것이 거기 없다), got %d", gitStatus)
	}
	if runStatus != http.StatusBadRequest {
		t.Errorf("/api/runs 는 400 이어야 한다 (호출자가 준 인자가 틀렸다), got %d", runStatus)
	}
	if gitStatus == runStatus {
		t.Fatal("두 표면이 같아졌다 — 테이블을 하나로 뭉친 것이 아닌지 확인하라")
	}
}

// /api/fs/* · /api/editors/* 의 sentinel → (status, code). 리팩터 전
// `fsFromOS` 와 `fsEntriesErr` 를 그대로 옮겨 온 것이다.
func TestFSTableMatchesPreRefactorBehavior(t *testing.T) {
	cases := []struct {
		sentinel error
		code     string
	}{
		{wsentry.ErrNotAbsolute, CodeBadRequest},
		{wsentry.ErrNotDir, CodeBadRequest},
		{wsentry.ErrNotFound, CodeNotFound},
	}
	for _, c := range cases {
		t.Run(c.sentinel.Error(), func(t *testing.T) {
			status, code, ok := FS.Lookup(fmt.Errorf("%w: 세부", c.sentinel))
			if !ok {
				t.Fatalf("%v 에 규칙이 없다", c.sentinel)
			}
			if code != c.code {
				t.Errorf("코드 %q, want %q", code, c.code)
			}
			// fs 표면은 상태를 코드에서 끌어낸다 — 둘이 어긋나면 응답이 자기
			// 모순이다.
			if status != FSStatus(code) {
				t.Errorf("상태 %d 가 FSStatus(%q)=%d 와 어긋난다", status, code, FSStatus(code))
			}
		})
	}
}
