package gitapi

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
)

// REPO_FIX 01 §8 — 서버 종료로 끊긴 동기 쓰기는 503 server_shutdown 이다.

// shutdownServer 는 서버 루트 ctx 를 가진 격리 서버다. 돌려준 cancel 이 종료다.
func shutdownServer(t *testing.T, f *gitWriteFake) (*GitServer, context.CancelFunc) {
	t.Helper()
	s, _ := gitWriteServer(t, f)
	root, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	at := time.Now()
	s.Git = store.NewStore(
		core.New(core.WithRunner(f.read), core.WithWriteRunner(f.write)),
		store.WithClock(func() time.Time { return at }),
		store.WithRoot(root),
	)
	return s, cancel
}

// 쓰기 도중 루트가 취소되면 재조회하지 않고 503 server_shutdown.
func TestShutdown_SyncWriteCutIs503(t *testing.T) {
	f := newGitWriteFake(t)
	s, cancel := shutdownServer(t, f)
	var once sync.Once
	f.writeCtx = func(context.Context) { once.Do(cancel) }
	statusCalls := 0
	f.onStatus = func() { statusCalls++ }
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusServiceUnavailable || out["error"] != apierr.CodeServerShutdown {
		t.Fatalf("= %d %v, want 503 server_shutdown", code, out)
	}
	if _, ok := out["partial"]; ok {
		t.Fatalf("종료 응답에 partial 이 실렸다: %v", out)
	}
	// before 스냅샷 1회만 — 쓰기 뒤 재조회가 없다.
	if statusCalls != 1 {
		t.Fatalf("status 조회 %d회, want 1 (종료 뒤 재조회 없음)", statusCalls)
	}
}

// 루트가 이미 끝났으면 쓰기를 시작하지 않는다.
func TestShutdown_SyncWriteAfterShutdownNotRun(t *testing.T) {
	f := newGitWriteFake(t)
	s, cancel := shutdownServer(t, f)
	f.onStatus = func() { cancel() }
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusServiceUnavailable || out["error"] != apierr.CodeServerShutdown {
		t.Fatalf("= %d %v, want 503 server_shutdown", code, out)
	}
	if n := exclWrites(f, "add"); n != 0 {
		t.Fatalf("종료 뒤 쓰기가 실행됐다 (add %d회)", n)
	}
}
