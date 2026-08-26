package query

import (
	"context"
	"errors"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 N — 브랜치 이름 검사 (GIT_SRS §3D.1 FR-GIT-159, 검증 V54).

// B6 (FR-GIT-159): 이름 규칙은 `check-ref-format --branch` 가 판정한다 — 규칙을
// 직접 구현하지 않는다. 실제 git 으로 확인한다.
func TestValidBranchName_UsesCheckRefFormat(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	for _, name := range []string{"feat", "feat/a-b", "릴리스/1.0"} {
		if err := ValidBranchName(s, ctx, repo, name); err != nil {
			t.Fatalf("ValidBranchName(%q) = %v, want nil", name, err)
		}
	}
	for _, name := range []string{"bad name", "x..y", "a.lock", "-lead", "he@{ad", "back\\slash"} {
		if err := ValidBranchName(s, ctx, repo, name); !errors.Is(err, core.ErrRefName) {
			t.Fatalf("ValidBranchName(%q) = %v, want ErrRefName", name, err)
		}
	}
}

// B7 (FR-GIT-159): `@{-1}` 은 **다른 브랜치 이름으로 펼쳐진다** — git 2.50.1 은
// exit 0 으로 `feat` 를 출력한다. 통과시키면 사용자가 적은 이름과 git 이 만드는
// 이름이 달라진다.
func TestValidBranchName_RejectsExpandedShorthand(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	s := core.New()
	if err := ValidBranchName(s, context.Background(), repo, "@{-1}"); !errors.Is(err, core.ErrRefName) {
		t.Fatalf("err = %v, want ErrRefName", err)
	}
}
