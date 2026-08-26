package query

import (
	"context"
	"errors"

	"dongminal/internal/webserver/domain/git/core"
)

// HasHead 는 HEAD 가 커밋을 가리키는지다. 읽기이므로 Exec 으로 간다 — rev-parse 는
// 쓰기 목록에 없다.
//
// 커밋이 없는 저장소의 실패는 실패가 아니다. 그 사실 자체가 답이며, 오류로 올리면
// 초기 커밋 전 저장소에서 unstage 가 아예 막힌다.
func HasHead(s *core.Service, ctx context.Context, repo string) (bool, error) {
	if _, err := s.Exec(ctx, repo, "rev-parse", "--verify", "HEAD"); err != nil {
		var xe *core.ExecError
		if errors.As(err, &xe) && xe.Unwrap() == nil {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
