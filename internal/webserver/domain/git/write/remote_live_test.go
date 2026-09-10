package write

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 원격 계열(fetch·pull·push)을 **실제로 실행한다** — 09-srs-implementation-gap
// 비목표 5 · CI_GATES_SRS §6.
//
// 이 자리가 비어 있었다. `remote_test.go` 는 argv 를 만드는 데까지만 재고
// (`FetchSpec` 이 무엇을 돌려주는가), 그 argv 가 실제 git 에서 무슨 일을 하는지는
// 아무도 확인하지 않았다. `E2E_UNIFICATION_SRS §6-4` 가 그 이유를 "네트워크와
// 자격증명이 필요하다" 로 적고 별도 트랙에 두었다.
//
// **그 전제가 틀렸다.** 로컬 bare 저장소를 원격으로 세우면 둘 다 필요 없다 —
// git 은 파일 경로를 원격 URL 로 받는다. 그래서 이 검사는 러너에서도 오프라인
// 에서도 똑같이 돈다.
//
// 재는 것은 **파이프라인 전체**다: Spec 이 만든 argv 가 `ExecWrite` 의 쓰기 가드를
// 지나 실제 git 에 닿고, 저장소의 상태가 실제로 바뀐다.

// liveRemote 는 bare 원격 하나와 그것을 `origin` 으로 둔 클론 둘을 만든다.
//
//	bare  ← origin
//	 ├── ours   (검사 대상)
//	 └── theirs (남이 밀어 넣는 자리)
func liveRemote(t *testing.T) (svc *core.Service, ours, theirs, bare string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	bare = filepath.Join(base, "origin.git")
	gitRun(t, base, "init", "-q", "--bare", "-b", "main", bare)

	seed := tempRepo(t)
	gitRun(t, seed, "remote", "add", "origin", bare)
	gitRun(t, seed, "push", "-q", "-u", "origin", "main")

	ours = filepath.Join(base, "ours")
	theirs = filepath.Join(base, "theirs")
	gitRun(t, base, "clone", "-q", bare, ours)
	gitRun(t, base, "clone", "-q", bare, theirs)
	for _, d := range []string{ours, theirs} {
		gitRun(t, d, "config", "user.email", "t@example.com")
		gitRun(t, d, "config", "user.name", "tester")
	}
	return core.New(), ours, theirs, bare
}

// commitFile 은 파일 하나를 만들고 커밋한다. 준비 단계이므로 진입점을 쓰지 않는다.
func commitFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", name)
	gitRun(t, dir, "commit", "-q", "-m", "add "+name)
}

// revList 는 커밋 수다. 상태가 실제로 바뀌었는지 세는 데 쓴다.
func revList(t *testing.T, dir, ref string) int {
	t.Helper()
	out, err := core.New().Exec(context.Background(), dir, "rev-list", "--count", ref)
	if err != nil {
		t.Fatalf("rev-list %s: %v", ref, err)
	}
	n := 0
	for _, c := range strings.TrimSpace(out.Stdout) {
		if c < '0' || c > '9' {
			t.Fatalf("rev-list 가 숫자가 아닌 것을 답했다: %q", out.Stdout)
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func TestLive_PushReachesRemote(t *testing.T) {
	svc, ours, _, bare := liveRemote(t)
	commitFile(t, ours, "ours.txt", "1\n")

	before := revList(t, bare, "main")
	spec, _, err := PushSpec(svc, context.Background(), ours, PushOpts{})
	if err != nil {
		t.Fatalf("PushSpec: %v", err)
	}
	if _, err := svc.ExecWrite(context.Background(), ours, spec); err != nil {
		t.Fatalf("push 실행: %v", err)
	}
	if after := revList(t, bare, "main"); after != before+1 {
		t.Fatalf("원격의 커밋 수가 %d → %d — push 가 닿지 않았다", before, after)
	}
}

func TestLive_FetchSeesTheirCommit(t *testing.T) {
	svc, ours, theirs, _ := liveRemote(t)
	commitFile(t, theirs, "theirs.txt", "1\n")
	gitRun(t, theirs, "push", "-q", "origin", "main")

	// fetch 전에는 원격 추적 ref 가 아직 옛 자리다.
	before := revList(t, ours, "origin/main")

	if _, err := svc.ExecWrite(context.Background(), ours, FetchSpec(FetchOpts{})); err != nil {
		t.Fatalf("fetch 실행: %v", err)
	}
	if after := revList(t, ours, "origin/main"); after != before+1 {
		t.Fatalf("origin/main 이 %d → %d — fetch 가 새 커밋을 가져오지 않았다", before, after)
	}
	// 작업 트리는 그대로다 — fetch 는 파괴적이 아니다.
	if revList(t, ours, "HEAD") != before {
		t.Fatalf("fetch 가 HEAD 를 옮겼다")
	}
}

func TestLive_PullMergesTheirCommit(t *testing.T) {
	svc, ours, theirs, _ := liveRemote(t)
	commitFile(t, theirs, "theirs.txt", "1\n")
	gitRun(t, theirs, "push", "-q", "origin", "main")

	before := revList(t, ours, "HEAD")
	spec, err := PullSpec(PullOpts{Mode: PullFFOnly})
	if err != nil {
		t.Fatalf("PullSpec: %v", err)
	}
	if _, err := svc.ExecWrite(context.Background(), ours, spec); err != nil {
		t.Fatalf("pull 실행: %v", err)
	}
	if after := revList(t, ours, "HEAD"); after != before+1 {
		t.Fatalf("HEAD 가 %d → %d — pull 이 남의 커밋을 들이지 않았다", before, after)
	}
	if _, err := os.Stat(filepath.Join(ours, "theirs.txt")); err != nil {
		t.Fatalf("pull 뒤에도 파일이 없다: %v", err)
	}
}

// 갈라진 히스토리에서 `--ff-only` 는 **실패해야 한다.** 조용히 머지하면 사용자가
// 고른 것과 다른 일이 일어난다.
func TestLive_PullFFOnlyRefusesDivergence(t *testing.T) {
	svc, ours, theirs, _ := liveRemote(t)
	commitFile(t, theirs, "theirs.txt", "1\n")
	gitRun(t, theirs, "push", "-q", "origin", "main")
	commitFile(t, ours, "ours.txt", "1\n") // 우리 쪽도 갈라졌다

	spec, err := PullSpec(PullOpts{Mode: PullFFOnly})
	if err != nil {
		t.Fatalf("PullSpec: %v", err)
	}
	if _, err := svc.ExecWrite(context.Background(), ours, spec); err == nil {
		t.Fatalf("갈라진 히스토리에서 --ff-only 가 통과했다")
	}
}

// upstream 이 없는 브랜치의 push 는 **Publish** 다 (FR-GIT-100) — 확인 없이는
// 계획만 돌려주고 멈춘다. 그 계획이 실제로 맞는지는 실행해 봐야 안다.
func TestLive_PublishSetsUpstream(t *testing.T) {
	svc, ours, _, bare := liveRemote(t)
	gitRun(t, ours, "checkout", "-q", "-b", "feature")
	commitFile(t, ours, "feature.txt", "1\n")

	ctx := context.Background()
	if _, plan, err := PushSpec(svc, ctx, ours, PushOpts{}); err == nil {
		t.Fatalf("upstream 없는 push 가 확인 없이 통과했다 (plan=%+v)", plan)
	}

	spec, _, err := PushSpec(svc, ctx, ours, PushOpts{Publish: true})
	if err != nil {
		t.Fatalf("PushSpec(publish): %v", err)
	}
	if _, err := svc.ExecWrite(ctx, ours, spec); err != nil {
		t.Fatalf("publish 실행: %v", err)
	}
	if n := revList(t, bare, "feature"); n == 0 {
		t.Fatalf("원격에 feature 브랜치가 서지 않았다")
	}
	// `-u` 가 실제로 붙었는가 — 다음 push 가 Publish 가 아니어야 한다.
	if _, _, err := PushSpec(svc, ctx, ours, PushOpts{}); err != nil {
		t.Fatalf("publish 뒤에도 upstream 이 없다: %v", err)
	}
}
