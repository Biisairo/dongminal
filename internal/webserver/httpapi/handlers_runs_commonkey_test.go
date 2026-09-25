package httpapi

import (
	"context"
	"sync/atomic"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-4 (DOM-26): Run 격리의 repoLock 키는 Store 의 gitdir
// 캐시를 딛는다 — 멤버마다 rev-parse 를 다시 돌리지 않는다.
func TestCommonKey_UsesStoreCache(t *testing.T) {
	repo := testpath.Abs("repo")
	var calls atomic.Int32
	svc := core.New(core.WithRunner(func(_ context.Context, dir string, args []string) (core.Output, error) {
		calls.Add(1)
		return core.Output{Stdout: dir + "/.git\n.git\n"}, nil
	}))
	s := &Server{Deps: Deps{Git: store.NewStore(svc)}}
	want := core.ExclusionKey(repo + "/.git")
	for i := 0; i < 3; i++ {
		got, err := s.commonKey(context.Background(), repo)
		if err != nil || got != want {
			t.Fatalf("commonKey = %q, %v; want %q", got, err, want)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("rev-parse %d 회, want 1", n)
	}
}
