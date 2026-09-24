package write

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// V7 (GIT_EXEC_UNIFY_SRS FR-GXU-6): 인가를 지나지 않은 기록은 다시 돌리지 않는다.
//
// `Exec` 이 어차피 화이트리스트로 막을 것이라는 이유로 생략하면 안 된다 — 거부의
// **사유가 다르고**, 화이트리스트가 나중에 바뀌면 그 우연한 방어가 사라진다.
// replay 는 "서버 자신의 기록만 다시 돈다"는 계약이며, 그 기록에는 인가를 지나지
// 않은 것이 섞여 있다.
func TestReplay_RejectsUnguardedRecord(t *testing.T) {
	var called bool
	s := core.New(
		core.WithRunner(func(context.Context, string, []string) (core.Output, error) {
			called = true
			return core.Output{}, nil
		}),
		core.WithWriteRunner(func(context.Context, string, []string, string) (core.Output, error) {
			called = true
			return core.Output{}, nil
		}),
	)

	rec := core.Record{
		Argv:      []string{"worktree", "remove", "--force", "/tmp/x"},
		Cwd:       absRepo,
		Unguarded: true,
		Reason:    "worktree 도메인",
	}

	_, err := Replay(s, context.Background(), absRepo, rec)
	if err == nil {
		t.Fatal("인가를 지나지 않은 기록이 재실행됐다")
	}
	if !errors.Is(err, ErrReplayTarget) {
		t.Fatalf("사유가 ErrReplayTarget 이 아니다: %v", err)
	}
	if called {
		t.Fatal("거부해야 하는데 실행기까지 닿았다")
	}
	// 사유가 화면에 나가므로 무엇이 문제인지 말해야 한다.
	if !strings.Contains(err.Error(), "인가") {
		t.Fatalf("거부 사유가 이유를 말하지 않는다: %v", err)
	}
}

// 회귀: 인가를 지난 기록은 그대로 다시 돈다. 위 거부가 넓게 잡히면 replay 자체가
// 죽는다.
func TestReplay_AllowsGuardedRecord(t *testing.T) {
	var seen []string
	s := core.New(core.WithRunner(func(_ context.Context, _ string, args []string) (core.Output, error) {
		seen = append([]string(nil), args...)
		return core.Output{}, nil
	}))

	rec := core.Record{Argv: []string{"status", "--porcelain"}, Cwd: absRepo}
	if _, err := Replay(s, context.Background(), absRepo, rec); err != nil {
		t.Fatalf("정상 기록이 거부됐다: %v", err)
	}
	if strings.Join(seen, " ") != "status --porcelain" {
		t.Fatalf("argv 가 그대로 가지 않았다: %q", seen)
	}
}

// REPO_FIX 01 §7.5: stdin 으로 넘긴 내용은 기록되지 않는다(I6). 그 기록을 다시
// 돌리면 다른 결과다 — 태그는 빈 메시지 annotated tag 가 exit 0 으로 생겼다(실측).
// 실행 전에 거절한다.
func TestReplay_RejectsStdinRecord(t *testing.T) {
	var called bool
	s := core.New(core.WithWriteRunner(func(context.Context, string, []string, string) (core.Output, error) {
		called = true
		return core.Output{}, nil
	}))
	rec := core.Record{Argv: []string{"tag", "-a", "v1", "-F", "-"}, Cwd: absRepo, Write: true, StdinBytes: 12}
	if _, err := Replay(s, context.Background(), absRepo, rec); !errors.Is(err, ErrReplayTarget) {
		t.Fatalf("err = %v, want ErrReplayTarget", err)
	}
	if called {
		t.Fatal("stdin 기록이 재실행됐다")
	}
}

// §7.5: stash 쓰기 기록은 위치(stash@{n})로 기록돼 지금 다시 돌리면 다른 stash 를
// 건드릴 수 있다 — 거절한다.
func TestReplay_RejectsStashWriteRecord(t *testing.T) {
	var called bool
	s := core.New(core.WithWriteRunner(func(context.Context, string, []string, string) (core.Output, error) {
		called = true
		return core.Output{}, nil
	}))
	rec := core.Record{Argv: []string{"stash", "drop", "stash@{0}"}, Cwd: absRepo, Write: true}
	if _, err := Replay(s, context.Background(), absRepo, rec); !errors.Is(err, ErrReplayTarget) {
		t.Fatalf("err = %v, want ErrReplayTarget", err)
	}
	if called {
		t.Fatal("stash 기록이 재실행됐다")
	}
}
