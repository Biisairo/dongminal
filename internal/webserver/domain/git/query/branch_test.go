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

// ── 묶음 B 가 딛는 조회 (GIT_ACTIONS_SRS §3.2, 검증 V179·V180·V182) ──

// B20 (FR-GIT-250.2): 지우기 전 oid 를 읽을 수 있어야 hint 가 값을 실을 수 있다.
func TestBranchOid_ReadsExactRef(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	s := core.New()
	ctx := context.Background()

	oid, err := BranchOid(s, ctx, repo, "feat")
	if err != nil {
		t.Fatalf("BranchOid: %v", err)
	}
	if len(oid) != 40 {
		t.Fatalf("oid = %q — 40자 sha 가 아니다", oid)
	}
	// 없는 브랜치는 오류다 — 빈 값으로 뭉개면 hint 가 조용히 값을 잃는다.
	if _, err := BranchOid(s, ctx, repo, "nope"); err == nil {
		t.Fatal("없는 브랜치의 oid 가 오류가 아니다")
	}
}

// B21 (FR-GIT-254 / V180): 미머지 브랜치는 `-d` 가 거부한다는 것을 **실행 전에**
// 안다 — 그래야 실패가 아니라 `-D` 로 올릴 선택지가 된다.
func TestBranchMerged_MatchesGitCriterion(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	// main 에 합쳐진 브랜치 — 커밋을 더하지 않았으므로 조상이다.
	gitRun(t, repo, "branch", "merged")
	merged, err := BranchMerged(s, ctx, repo, "merged")
	if err != nil {
		t.Fatalf("BranchMerged(merged): %v", err)
	}
	if !merged {
		t.Fatal("합쳐진 브랜치가 미머지로 판정됐다 — 지울 수 있는 것을 못 지우게 된다")
	}

	// 자기만의 커밋이 있는 브랜치 — `git branch -d` 가 거부하는 상태다.
	gitRun(t, repo, "checkout", "-q", "-b", "unmerged")
	gitRun(t, repo, "commit", "-q", "--allow-empty", "-m", "only-here")
	gitRun(t, repo, "checkout", "-q", "main")
	unmerged, err := BranchMerged(s, ctx, repo, "unmerged")
	if err != nil {
		t.Fatalf("BranchMerged(unmerged): %v", err)
	}
	if unmerged {
		t.Fatal("미머지 브랜치가 머지된 것으로 판정됐다 — 선택지 없이 실패로 끝난다")
	}
}

// B22 (FR-GIT-255 / V182): 영향 범위는 실행 전에 답한다 — ff 로 끝나는지와 들어올
// 커밋 수. 둘 중 하나만으로는 사용자가 무엇이 생기는지 알 수 없다.
func TestMergePreview_FFAndCounts(t *testing.T) {
	repo := tempRepo(t)
	s := core.New()
	ctx := context.Background()

	gitRun(t, repo, "checkout", "-q", "-b", "side")
	gitRun(t, repo, "commit", "-q", "--allow-empty", "-m", "s1")
	gitRun(t, repo, "commit", "-q", "--allow-empty", "-m", "s2")
	gitRun(t, repo, "checkout", "-q", "main")

	// 갈라지지 않았다 — 두 커밋이 그대로 들어오고 ff 로 끝난다.
	im, err := MergePreview(s, ctx, repo, "side")
	if err != nil {
		t.Fatalf("MergePreview: %v", err)
	}
	if !im.FastForward || im.Incoming != 2 || im.Diverged != 0 || im.UpToDate {
		t.Fatalf("impact = %+v, want ff=true incoming=2 diverged=0", im)
	}

	// 이쪽에도 커밋을 하나 얹으면 갈라진다 — 더 이상 ff 가 아니다.
	gitRun(t, repo, "commit", "-q", "--allow-empty", "-m", "m1")
	im, err = MergePreview(s, ctx, repo, "side")
	if err != nil {
		t.Fatalf("MergePreview(갈라진 뒤): %v", err)
	}
	if im.FastForward || im.Incoming != 2 || im.Diverged != 1 {
		t.Fatalf("impact = %+v, want ff=false incoming=2 diverged=1", im)
	}

	// 이미 합쳐졌으면 들어올 것이 없다. ff 와 구분되어야 한다.
	gitRun(t, repo, "merge", "-q", "--no-edit", "side")
	im, err = MergePreview(s, ctx, repo, "side")
	if err != nil {
		t.Fatalf("MergePreview(합친 뒤): %v", err)
	}
	if !im.UpToDate || im.Incoming != 0 {
		t.Fatalf("impact = %+v, want upToDate", im)
	}

	// 옵션처럼 생긴 ref 는 실행 전에 거부된다.
	if _, err := MergePreview(s, ctx, repo, "-x"); !errors.Is(err, core.ErrRefName) {
		t.Fatalf("err = %v, want ErrRefName", err)
	}
}

// B23 (FR-GIT-257·258): upstream 이 없다는 것은 **오류가 아니라 답**이다 — 오류로
// 올리면 publish 판정 자체가 막힌다.
func TestBranchUpstream_EmptyIsAnAnswer(t *testing.T) {
	repo := tempRepoWithBranch(t, "feat")
	s := core.New()
	up, err := BranchUpstream(s, context.Background(), repo, "feat")
	if err != nil {
		t.Fatalf("BranchUpstream: %v", err)
	}
	if up != "" {
		t.Fatalf("upstream = %q, want \"\"", up)
	}
}
