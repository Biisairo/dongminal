package query

import (
	"context"

	"dongminal/internal/webserver/domain/git/core"
)

// HasHead 는 HEAD 가 커밋을 가리키는지다. 읽기이므로 Exec 으로 간다 — rev-parse 는
// 쓰기 목록에 없다.
//
// 커밋이 없는 저장소의 실패는 실패가 아니다. 그 사실 자체가 답이며, 오류로 올리면
// 초기 커밋 전 저장소에서 unstage 가 아예 막힌다.
func HasHead(s *core.Service, ctx context.Context, repo string) (bool, error) {
	return refExists(s, ctx, repo, "", "HEAD")
}

// refExists 는 `rev-parse --verify <prefix+name>` 이 답하는가다 (FR-OPT-7-1).
// HasHead·LocalBranchExists·TagExists 가 이 하나를 딛는다 — 각자 적으면 "없음"
// 판정이 한쪽만 고쳐진다.
//
// 없는 ref 의 실패(분류되지 않은 종료)는 실패가 아니라 답이다.
func refExists(s *core.Service, ctx context.Context, repo, prefix, name string) (bool, error) {
	if _, err := refOid(s, ctx, repo, prefix, name); err != nil {
		if _, ok := core.PlainExit(err); ok {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
