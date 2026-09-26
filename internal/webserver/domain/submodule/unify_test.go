package submodule

import (
	"context"
	"errors"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-2: 성공은 stdout 만 준다 — 성공한 git 의 stderr
// 경고가 파싱 입력에 섞이지 않는다. 앞 공백은 그대로다 (FR-SUB-2).
func TestRunnerFor_SuccessIsStdoutOnly(t *testing.T) {
	svc := core.New(core.WithWriteRunner(func(_ context.Context, _ string, _ []string, _ string) (core.Output, error) {
		return core.Output{Stdout: " abc sub (heads/main)\n", Stderr: "warning: x\n"}, nil
	}))
	out, err := RunnerFor(svc)(context.Background(), testpath.Abs("repo"), "submodule", "status")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if out != " abc sub (heads/main)" {
		t.Fatalf("out = %q", out)
	}
}

// FR-OPT-7-5 (DOM-31): 경로 가드는 core.RelPath 위에 선다 — 가장 강한 규칙으로
// 통일한다. 종전 checkPath 가 놓치던 NUL·정규화되지 않은 경로를 막고, 이 표면의
// 추가 규칙(- 시작·드라이브 문자)은 그대로 둔다.
func TestCheckPath_StrongestRules(t *testing.T) {
	for _, p := range []string{"", "  ", "/abs", "../x", "a/../../x", "a\x00b", "a/./b", "a//b", "a/", "-flag", "C:\\x", "C:x"} {
		if err := checkPath(p); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("checkPath(%q) = %v, want ErrUnsafePath", p, err)
		}
	}
	for _, p := range []string{"sub", "vendor/my lib", "a/b-c", "x.y"} {
		if err := checkPath(p); err != nil {
			t.Errorf("checkPath(%q) = %v, want nil", p, err)
		}
	}
}
