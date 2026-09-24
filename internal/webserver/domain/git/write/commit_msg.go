package write

import (
	"context"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// NormalizeCommitMessage 는 git 의 `--cleanup=strip` 과 같은 정규화다 (REPO_FIX 01
// §7.7). amend 에서 "메시지가 직전과 같다" 를 판정하는 데 쓴다.
//
// commentPrefix 로 시작하는 줄을 지우고(빈 값이면 지우지 않는다 — commentChar 가
// `auto` 인 경우), 줄 끝 공백을 지우고, 연속 빈 줄을 하나로, 앞뒤 빈 줄을 지운다.
// `git stripspace` 를 부르지 않는 이유: stdin 이 필요한데 읽기 경로에는 stdin 이
// 없고 읽기 허용 목록에도 없다.
func NormalizeCommitMessage(msg, commentPrefix string) string {
	var out []string
	blank := false
	for _, line := range strings.Split(strings.ReplaceAll(msg, "\r\n", "\n"), "\n") {
		if commentPrefix != "" && strings.HasPrefix(line, commentPrefix) {
			continue
		}
		line = strings.TrimRight(line, " \t")
		if line == "" {
			blank = len(out) > 0
			continue
		}
		if blank {
			out = append(out, "")
			blank = false
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// CommentPrefix 는 커밋 메시지의 주석 접두다. `core.commentString`(git ≥ 2.45)이
// 있으면 그것, 없으면 `core.commentChar`, 둘 다 없으면 `#`. 값이 `auto` 면 ""
// (주석 줄을 지우지 않는다).
func CommentPrefix(s *core.Service, ctx context.Context, repo string) string {
	for _, key := range []string{"core.commentString", "core.commentChar"} {
		out, err := s.Exec(ctx, repo, "config", "--get", "--default=", key)
		if err != nil {
			continue
		}
		v := strings.TrimRight(out.Stdout, "\n")
		switch v {
		case "":
			continue
		case "auto":
			return ""
		}
		return v
	}
	return "#"
}

// HasSignoff 는 메시지에 Signed-off-by 트레일러 줄이 있는가다.
func HasSignoff(msg string) bool {
	for _, line := range strings.Split(msg, "\n") {
		if strings.HasPrefix(line, "Signed-off-by:") {
			return true
		}
	}
	return false
}
