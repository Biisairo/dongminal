package git

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// GitDirs 는 리포의 gitdir 과 common-dir 을 준다.
//
// worktree 에서는 둘이 다르다 — HEAD·index 는 gitdir 에, refs 는 common-dir 에
// 있다. 하나로 뭉개면 worktree 의 signature 가 잘못된 파일을 stat 한다.
//
// rev-parse 한 번으로 두 줄을 얻는다. 둘째 줄이 상대경로면 repo 기준으로
// 절대화한다 (git 2.50 은 `.git` 을 준다).
func (s *Service) GitDirs(ctx context.Context, repo string) (gitDir, commonDir string, err error) {
	out, err := s.Exec(ctx, repo, "rev-parse", "--absolute-git-dir", "--git-common-dir")
	if err != nil {
		return "", "", err
	}
	lines := splitLines(out.Stdout)
	if len(lines) == 0 {
		return "", "", fmt.Errorf("%w: rev-parse 가 gitdir 을 주지 않았다: %s", ErrNotRepo, repo)
	}
	gitDir = lines[0]
	// 둘째 줄이 없으면 common-dir 은 gitdir 과 같다는 뜻이다 (worktree 가 아닌
	// 평범한 저장소). 없는 줄을 인덱스로 집으면 패닉이므로 명시적으로 처리한다.
	commonDir = gitDir
	if len(lines) > 1 && lines[1] != "" {
		commonDir = lines[1]
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(repo, commonDir)
	}
	return gitDir, commonDir, nil
}

// splitLines 는 빈 줄을 버리고 각 줄을 다듬는다.
func splitLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}
