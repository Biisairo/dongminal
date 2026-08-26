package core

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// RepoRoot 는 cwd 가 속한 저장소의 루트 절대경로를 확정한다.
//
// 저장소가 아니면 ErrNotRepo 다 — 빈 문자열로 낮추지 않는다 (FR-GIT-8). 조용한
// 빈 결과는 호출자가 "저장소가 없다"와 "확인에 실패했다"를 구분할 수 없게 만든다.
//
// macOS 의 /tmp → /private/tmp 같은 심링크 차이는 **정규화하지 않는다.** git 이
// 준 값이 진실이며, 비교는 이 함수의 출력끼리 한다.
func (s *Service) RepoRoot(ctx context.Context, cwd string) (string, error) {
	out, err := s.Exec(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	top := strings.TrimSpace(out.Stdout)
	if top == "" {
		return "", fmt.Errorf("%w: %s 는 git 저장소가 아니다", ErrNotRepo, cwd)
	}
	if !filepath.IsAbs(top) {
		// bare 저장소·이상 응답 방어. 상대경로는 해석 기준이 없어 쓸 수 없다.
		return "", fmt.Errorf("%w: rev-parse 가 절대경로를 주지 않았다: %q", ErrNotRepo, top)
	}
	return top, nil
}
