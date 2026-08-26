package query

import (
	"context"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// lastMessageFormat 은 커밋 메시지 전문(제목+본문)이다. `%s` 로는 본문이 사라져
// amend 토글의 왕복이 손실을 낸다 (FR-GIT-78, 검증 V33).
const lastMessageFormat = "--pretty=%B"

// LastCommitMessage 는 amend 토글이 채울 메시지다 (FR-GIT-78).
//
//	git log -1 --pretty=%B
//
// 후행 개행은 버린다 — git 이 저장할 때 붙인 것이고, 입력창에 그대로 넣으면 토글
// 왕복마다 빈 줄이 하나씩 늘어난다.
func LastCommitMessage(s *core.Service, ctx context.Context, repo string) (string, error) {
	out, err := s.Exec(ctx, repo, "log", "-1", lastMessageFormat)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(out.Stdout, "\n"), nil
}
