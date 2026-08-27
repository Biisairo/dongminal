package query

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// 태그 이름 검사와 대상 조회 (GIT_ACTIONS_SRS §3.3 FR-GIT-260·261).
//
// branch.go 와 같은 정신이다 — **규칙을 직접 구현하지 않는다.** 브랜치는
// `check-ref-format --branch` 가, 태그는 `--normalize` 가 판정한다: `--branch` 는
// 브랜치 이름 규칙이라 태그에 쓸 수 없다.
//
// 목록은 여기서 만들지 않는다 — Refs 가 `refs/tags` 를 이미 준다 (FR-GIT-147).

// TagRefPrefix 는 태그 ref 의 접두다. 이름만으로 묻지 않는 이유는 브랜치와 같다 —
// 검사도 존재 확인도 전체 ref 로 해야 네임스페이스가 섞이지 않는다.
const TagRefPrefix = "refs/tags/"

// ValidTagName 은 git 의 이름 규칙을 확인한다 (FR-GIT-260).
//
// 실측 (git 2.50.1): 유효하면 exit 0 + **정규화된 ref** 를 출력, 무효하면 exit 1 +
// 출력 없음. 브랜치의 exit 128 과 다르므로 문구로 좁히지 않는다 — 분류되지 않은
// 실패가 곧 "이름 규칙 위반" 이다.
//
// 출력이 입력과 다르면 거부한다. `--normalize` 는 `refs/tags//x` 의 겹친 `/` 를
// 말없이 하나로 줄이므로(실측), 통과시키면 사용자가 적은 이름과 git 이 만드는
// 이름이 달라진다.
func ValidTagName(s *core.Service, ctx context.Context, repo, name string) error {
	if err := core.CheckRefArg("name", name); err != nil {
		return err
	}
	full := TagRefPrefix + name
	out, err := s.Exec(ctx, repo, "check-ref-format", core.CheckRefFormatNormalize, full)
	if err != nil {
		return tagNameError(name, err)
	}
	if got := strings.TrimRight(out.Stdout, "\n"); got != full {
		return fmt.Errorf("%w: %q 는 git 이 %q 로 고쳐 읽는 이름이다",
			core.ErrRefName, name, strings.TrimPrefix(got, TagRefPrefix))
	}
	return nil
}

// TagExists 는 그 이름의 태그가 있는지다. 읽기이므로 Exec 으로 간다.
//
// 없는 ref 의 실패는 실패가 아니다 — 그 사실 자체가 답이며, 오류로 올리면 충돌이
// 없을 때 생성이 아예 막힌다 (LocalBranchExists 와 같은 규약).
func TagExists(s *core.Service, ctx context.Context, repo, name string) (bool, error) {
	if _, err := TagOid(s, ctx, repo, name); err != nil {
		if errors.Is(err, core.ErrRefName) {
			return false, err
		}
		var xe *core.ExecError
		if errors.As(err, &xe) && xe.Unwrap() == nil {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// TagOid 는 `refs/tags/<name>` 이 가리키는 객체다.
//
// **역참조하지 않는다** (`^{}` 를 붙이지 않는다). annotated 태그의 ref 는 태그
// 객체를 가리키며, 그 값으로 `git tag <name> <oid>` 를 돌리면 지우기 전 상태가
// 그대로 돌아온다 (실측) — 커밋으로 역참조하면 annotated 가 lightweight 로
// 되살아나 메시지·서명이 사라진다. 삭제의 recovery hint 가 이 값을 싣는다
// (FR-GIT-92·261).
func TagOid(s *core.Service, ctx context.Context, repo, name string) (string, error) {
	if err := core.CheckRefArg("name", name); err != nil {
		return "", err
	}
	out, err := s.Exec(ctx, repo, "rev-parse", "--verify", TagRefPrefix+name)
	if err != nil {
		return "", err
	}
	oid := strings.TrimRight(out.Stdout, "\n")
	if oid == "" {
		return "", fmt.Errorf("태그 %q 의 대상을 읽지 못했다: rev-parse 가 빈 값을 줬다", name)
	}
	return oid, nil
}

// tagNameError 는 분류되지 않은 실패를 "이름 규칙 위반" 으로 갈라 준다. 저장소·git
// 자체의 실패와 구분되지 않으면 사용자는 이름을 고치면 되는지 알 수 없다.
func tagNameError(name string, err error) error {
	var xe *core.ExecError
	if !errors.As(err, &xe) || xe.Unwrap() != nil {
		return err
	}
	return fmt.Errorf("%w: %q 는 git 의 태그 이름 규칙을 어긴다", core.ErrRefName, name)
}
