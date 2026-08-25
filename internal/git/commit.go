package git

import (
	"context"
	"strings"
	"time"
)

// 커밋 argv 의 고정 부분.
//
// **메시지는 stdin 이다** (FR-GIT-77, §7.1 I6) — 인자에 넣으면 프로세스 목록과 실행
// 기록에 남는다. `--cleanup=strip` 은 주석·후행 공백을 정리한다.
const (
	commitFileStdin = "--file=-"
	commitCleanup   = "--cleanup=strip"
)

// UndoTTL 은 커밋을 되돌릴 수 있는 창이다 (FR-GIT-83, O7). 상수로 못박는다 —
// 토스트의 지속 시간과 서버 토큰의 수명이 갈라지면 둘 중 하나가 거짓말을 한다.
const UndoTTL = 5 * time.Second

// undoRev 는 직전 커밋 **이전**의 상태다. reflog 의 한 칸 앞이므로 amend 도 같은
// 방법으로 되돌아간다.
const undoRev = "HEAD@{1}"

// lastMessageFormat 은 커밋 메시지 전문(제목+본문)이다. `%s` 로는 본문이 사라져
// amend 토글의 왕복이 손실을 낸다 (FR-GIT-78, 검증 V33).
const lastMessageFormat = "--pretty=%B"

// CommitOpts 는 커밋 한 번의 옵션이다. 조합 명령을 만들지 않는다 — VSCode 의 20개
// 조합 명령을 이 구조체 하나가 대체한다 (FR-GIT-79).
type CommitOpts struct {
	Message  string // stdin 으로 전달한다. 인자로 넘기지 않는다 (FR-GIT-77)
	Amend    bool
	SignOff  bool
	NoVerify bool
	All      bool // -a
}

// Commit 은 staged 내용을 커밋한다 (FR-GIT-77).
//
//	git commit --file=- --cleanup=strip [--amend] [--signoff] [--no-verify] [-a]
//
// `--no-edit` 은 주지 않는다 — `--file=-` 이 이미 메시지를 정하므로 에디터가 열리지
// 않는다. 파괴적이 아니다: amend 도 `HEAD@{1}` 로 되돌아간다.
func (s *Service) Commit(ctx context.Context, repo string, o CommitOpts) (Output, error) {
	argv := []string{"commit", commitFileStdin, commitCleanup}
	if o.Amend {
		argv = append(argv, "--amend")
	}
	if o.SignOff {
		argv = append(argv, "--signoff")
	}
	if o.NoVerify {
		argv = append(argv, "--no-verify")
	}
	if o.All {
		argv = append(argv, "-a")
	}
	return s.ExecWrite(ctx, repo, WriteSpec{Argv: argv, Stdin: o.Message})
}

// UndoLast 는 직전 커밋을 되돌린다 (FR-GIT-82).
//
//	git reset --soft HEAD@{1}
//
// **`--hard` 를 쓰지 않는다.** `--soft` 는 워킹 트리와 index 를 건드리지 않으므로
// 아무것도 지우지 않고, 그래서 파괴적이 아니다.
func (s *Service) UndoLast(ctx context.Context, repo string) (Output, error) {
	return s.ExecWrite(ctx, repo, WriteSpec{Argv: []string{"reset", "--soft", undoRev}})
}

// LastCommitMessage 는 amend 토글이 채울 메시지다 (FR-GIT-78).
//
//	git log -1 --pretty=%B
//
// 후행 개행은 버린다 — git 이 저장할 때 붙인 것이고, 입력창에 그대로 넣으면 토글
// 왕복마다 빈 줄이 하나씩 늘어난다.
func (s *Service) LastCommitMessage(ctx context.Context, repo string) (string, error) {
	out, err := s.Exec(ctx, repo, "log", "-1", lastMessageFormat)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(out.Stdout, "\n"), nil
}
