package query

import (
	"context"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 I — 커밋 메시지 조회 (GIT_SRS §3A.2 FR-GIT-78, 검증 V33).

const commitFixtureMessage = "제목 줄\n\n본문 첫 줄\n본문 둘째 줄"

// S10 (V33, FR-GIT-78): amend 토글이 채울 직전 커밋 메시지를 여러 줄 그대로 준다.
// 제목만 주면 본문이 사라지고, 토글 왕복이 손실 없이 되돌아오지 못한다.
func TestLastCommitMessage_MultiLine(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	gitIn(t, repo, "commit", "--allow-empty", "--cleanup=strip", "-m", commitFixtureMessage)
	got, err := LastCommitMessage(s, ctx, repo)
	if err != nil {
		t.Fatalf("LastCommitMessage: %v", err)
	}
	if got != commitFixtureMessage {
		t.Fatalf("message = %q, want %q", got, commitFixtureMessage)
	}
	if recs := s.Records(0); len(recs) != 1 || recs[0].Argv[0] != "log" {
		t.Fatalf("읽기 경로로 실행되지 않았다: %+v", recs)
	}
}
