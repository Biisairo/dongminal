package core

import (
	"context"
	"errors"
	"testing"
)

// 케이스 5 (V1, FR-GIT-7): 저장소를 변경하는 명령은 실행 경로 자체가 없다.
func TestExec_RejectsWriteCommands(t *testing.T) {
	writes := []string{
		"commit", "push", "add", "reset", "checkout", "stash", "clean",
		"merge", "rebase", "pull", "fetch", "branch", "tag", "worktree",
		"restore", "switch", "cherry-pick", "revert", "apply", "rm", "mv", "init", "clone",
	}
	for _, cmd := range writes {
		s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
			t.Fatalf("%s 가 실행됐다 — Runner 에 도달하면 안 된다", cmd)
			return Output{}, nil
		}))
		_, err := s.Exec(context.Background(), absTmpRepo, cmd, "-m", "x")
		if !errors.Is(err, ErrWriteCommand) {
			t.Fatalf("%s: err = %v, want ErrWriteCommand", cmd, err)
		}
	}
}

// FR-GIT-7: 허용 목록에 읽기 명령만 있다. 목록을 늘리는 것은 해당 마일스톤의 일이다.
//
// `config` 는 9단계가 더했다 (preflight, FR-GIT-86) — 읽기 인자만 통과하는지는
// preflight_test.go 의 W10 이 본다. `git config user.name x` 는 여전히 거부된다.
func TestReadCommands_ReadOnly(t *testing.T) {
	want := []string{"rev-parse", "status", "diff", "show", "log", "for-each-ref", "config"}
	for _, c := range want {
		if !readCommands[c] {
			t.Fatalf("%s 는 M1 이 필요한 읽기 명령인데 없다", c)
		}
	}
	forbidden := []string{"commit", "push", "add", "reset", "checkout", "stash", "clean", "branch"}
	for _, c := range forbidden {
		if readCommands[c] {
			t.Fatalf("%s 가 허용 목록에 있다 — M1 에 파괴적 경로가 생겼다", c)
		}
	}
}

// 케이스 6 (V1, FR-GIT-2): 전역 옵션·임의 실행·파일 쓰기 경로와 NUL 을 거부한다.
func TestGuardArgs_Rejects(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want error
	}{
		{"빈 args", nil, ErrUnsafeArgument},
		{"빈 슬라이스", []string{}, ErrUnsafeArgument},
		{"전역 옵션 -c", []string{"-c", "core.pager=x", "status"}, ErrUnsafeArgument},
		{"전역 옵션 --exec-path", []string{"--exec-path=/x", "status"}, ErrUnsafeArgument},
		{"전역 옵션 --upload-pack", []string{"--upload-pack=x", "status"}, ErrUnsafeArgument},
		{"뒤따르는 --exec-path", []string{"status", "--exec-path=/x"}, ErrUnsafeArgument},
		{"뒤따르는 --upload-pack", []string{"log", "--upload-pack=/bin/sh"}, ErrUnsafeArgument},
		{"뒤따르는 --receive-pack", []string{"log", "--receive-pack=/bin/sh"}, ErrUnsafeArgument},
		{"파일 쓰기 --output", []string{"diff", "--output=/etc/passwd"}, ErrUnsafeArgument},
		{"파일 쓰기 -o", []string{"diff", "-o/etc/passwd"}, ErrUnsafeArgument},
		{"NUL 포함", []string{"log", "--format=%H\x00id"}, ErrUnsafeArgument},
		{"하위 명령에 NUL", []string{"status\x00"}, ErrWriteCommand},
		{"쓰기 명령", []string{"commit"}, ErrWriteCommand},
		{"알 수 없는 명령", []string{"frobnicate"}, ErrWriteCommand},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := guardArgs(tc.args); !errors.Is(err, tc.want) {
				t.Fatalf("guardArgs(%q) = %v, want %v", tc.args, err, tc.want)
			}
		})
	}
}

func TestGuardArgs_Allows(t *testing.T) {
	ok := [][]string{
		{"rev-parse", "--show-toplevel"},
		{"status", "--porcelain=v2", "--branch", "--untracked-files=all"},
		{"diff", "--numstat", "--", "a/b.txt"},
		{"log", "--format=%H%x00%an", "-n", "50"},
		{"for-each-ref", "--format=%(refname)", "refs/heads/"},
		{"show", "HEAD:README.md"},
	}
	for _, args := range ok {
		if err := guardArgs(args); err != nil {
			t.Fatalf("guardArgs(%q) = %v, want nil", args, err)
		}
	}
}

// W10: `config` 는 읽기 목록에 있으나 읽기 인자만 통과한다.
// `git config user.name x` 는 쓰기이므로 읽기 경로로 흘러선 안 된다.
func TestGuardArgs_ConfigReadOnly(t *testing.T) {
	ok := [][]string{
		{"config", "--get", "user.name"},
		{"config", "--get-all", "remote.origin.url"},
		{"config", "--list"},
		{"config", "--type=bool", "--get", "commit.gpgsign"},
	}
	for _, args := range ok {
		if err := guardArgs(args); err != nil {
			t.Fatalf("guardArgs(%q) = %v, want nil", args, err)
		}
	}
	bad := [][]string{
		{"config", "user.name", "x"},
		{"config", "--unset", "user.name"},
		{"config", "--add", "remote.origin.url", "git@example.com"},
		{"config", "--global", "--get", "user.name"},
		{"config", "--file=/etc/passwd", "--list"},
		{"config", "--get", "user.name", "extra"},
	}
	for _, args := range bad {
		if err := guardArgs(args); !errors.Is(err, ErrUnsafeArgument) {
			t.Fatalf("guardArgs(%q) = %v, want ErrUnsafeArgument", args, err)
		}
	}
}

// FR-GIT-276: blame 은 읽기다. 목록을 넓히는 것은 그 요구사항의 일이며, 넓힌 뒤에도
// 쓰기 목록과 겹치지 않아야 한다 (FR-GIT-95 의 교집합-금지).
func TestReadCommands_Blame(t *testing.T) {
	if !readCommands["blame"] {
		t.Fatal("blame 이 읽기 목록에 없다 — FR-GIT-276 이 실행되지 못한다")
	}
	if writeCommands["blame"] {
		t.Fatal("blame 이 쓰기 목록에도 있다 — 교집합이 생겼다 (FR-GIT-95)")
	}
}
