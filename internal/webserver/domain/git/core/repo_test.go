package core

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

// 케이스 11 (FR-GIT-8/9): RepoRoot 는 확정하거나 오류다. 빈 문자열로 낮추지 않는다.
func TestRepoRoot(t *testing.T) {
	cases := []struct {
		name    string
		out     Output
		want    string
		wantErr error
	}{
		{"정상", Output{Stdout: absUserRepo + "\n"}, absUserRepo, nil},
		{"저장소 아님", Output{Stderr: "fatal: not a git repository (or any of the parent directories): .git\n", ExitCode: 128}, "", ErrNotRepo},
		{"빈 출력", Output{Stdout: "\n  \n"}, "", ErrNotRepo},
		{"상대경로 출력", Output{Stdout: "repo\n"}, "", ErrNotRepo},
		// FR-WTP-3: git 출력은 정규형이 아닐 수 있고, Windows 에서는 슬래시
		// 형태(C:/Users/x)로 온다. 정규화하지 않으면 이 값이 캐시 키·핀 비교·
		// API 응답에 그대로 실려 다른 형태와 어긋난다.
		{"정규형이 아닌 출력", Output{Stdout: absUserRepo + "/sub/..\n"}, absUserRepo, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotArgs []string
			s := New(WithRunner(func(_ context.Context, _ string, args []string) (Output, error) {
				gotArgs = args
				return tc.out, nil
			}))
			got, err := s.RepoRoot(context.Background(), filepath.Join(absUserRepo, "sub"))
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if got != "" {
					t.Fatalf("오류인데 %q 를 돌려줬다", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("RepoRoot: %v", err)
			}
			if got != tc.want {
				t.Fatalf("root = %q, want %q", got, tc.want)
			}
			if len(gotArgs) != 2 || gotArgs[0] != "rev-parse" || gotArgs[1] != "--show-toplevel" {
				t.Fatalf("argv = %q", gotArgs)
			}
		})
	}
}

func TestRepoRoot_BadCwd(t *testing.T) {
	s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		t.Fatal("Runner 가 호출되면 안 된다")
		return Output{}, nil
	}))
	for _, cwd := range []string{"", "relative"} {
		if _, err := s.RepoRoot(context.Background(), cwd); !errors.Is(err, ErrUnsafeArgument) {
			t.Fatalf("cwd %q: err = %v, want ErrUnsafeArgument", cwd, err)
		}
	}
}

// 저장소를 심링크 경로로 물어도 git 이 준 값을 그대로 돌려준다 (정규화하지 않는다).
func TestRepoRoot_RealGit(t *testing.T) {
	if testing.Short() {
		t.Skip("실제 git 이 필요하다")
	}
	repo := tempRepo(t)
	s := New()
	got, err := s.RepoRoot(context.Background(), repo)
	if err != nil {
		t.Fatalf("RepoRoot: %v", err)
	}
	if got != repo {
		t.Fatalf("root = %q, want %q", got, repo)
	}
	if _, err := s.RepoRoot(context.Background(), t.TempDir()); !errors.Is(err, ErrNotRepo) {
		t.Skipf("임시 디렉터리가 상위 저장소 안에 있다: %v", err)
	}
}
