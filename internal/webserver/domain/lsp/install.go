package lsp

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/platform"
)

// InstallTimeout 은 설치 하나의 시간 상한이다 (FR-LSP-12).
//
// 넉넉한 이유는 `go install golang.org/x/tools/gopls@latest` 가 찬 캐시 없이는
// 의존을 다 받아 컴파일하기 때문이다 — 처음 받을 때 분 단위가 정상이다. 그래도
// 상한이 있어야 한다: 없으면 답하지 않는 네트워크에서 설치가 영영 끝나지 않고,
// 사용자는 버튼이 죽은 것으로 읽는다.
const InstallTimeout = 6 * time.Minute

// InstallOutput 은 도구의 출력을 상태에 실을 때의 상한이다. 전부 실으면 응답이
// 커지고, 사용자가 읽을 부분은 대개 끝쪽이다.
const InstallOutput = 4000

// InstallOutcome 은 설치의 결과다 (FR-LSP-10).
//
// **사유가 있는 것이 규칙이다.** LSP 는 "안 되는 경우" 가 많고(D-9), 그 전부가
// 아무 말 없이 끝나면 사용자는 모두 우리 버그로 읽는다.
type InstallOutcome struct {
	OK bool `json:"ok"`
	// Reason 은 사람의 말로 적은 사유다.
	Reason string `json:"reason,omitempty"`
	// Detail 은 도구가 낸 출력의 끝쪽이다 — 실제 원인이 거기 있다.
	Detail string `json:"detail,omitempty"`
	// Exe 는 성공했을 때 실행 파일이 놓인 자리다.
	Exe string `json:"exe,omitempty"`
}

// InstallRunner 는 언어 서버를 전용 디렉터리로 받는다 (FR-LSP-7~12).
//
// 실행을 **주입받는다** — 검사가 남의 기계에 네트워크를 쓰거나 파일을 쓰지 않고
// "무엇을 어떻게 부르려 했는지" 를 잴 수 있어야 한다. 그것이 격리와 셸 미경유를
// 재는 유일한 길이다.
type InstallRunner struct {
	// ManagedDir 은 전용 디렉터리다 (`<홈>/lsp`).
	ManagedDir string
	// LookPath 는 보통 exec.LookPath 다.
	LookPath func(string) (string, error)
	// Exec 은 명령을 돌린다. name 과 args 가 **분리된 채** 오므로 셸이 끼지
	// 않는다 (FR-LSP-9·51). 반환은 합친 출력과 오류다.
	Exec func(ctx context.Context, name string, args, env []string, dir string) ([]byte, error)
	// Timeout 이 0 이면 InstallTimeout 이다.
	Timeout time.Duration
}

// NewInstallRunner 는 실제 프로세스를 돌리는 InstallRunner 다.
func NewInstallRunner(managedDir string) *InstallRunner {
	return &InstallRunner{ManagedDir: managedDir, LookPath: exec.LookPath, Exec: execCombined}
}

// execCombined 은 실제 실행이다. **셸을 거치지 않는다** — `exec.CommandContext` 에
// 이름과 인자를 그대로 넘긴다 (FR-EGS-9 / D-4 와 같은 규약).
func execCombined(ctx context.Context, name string, args, env []string, dir string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	return cmd.CombinedOutput()
}

// Install 은 서술자의 서버를 받는다.
//
// 성공의 판정이 **도구의 종료 코드가 아니라 실행 파일의 존재**인 것이 규칙이다
// (FR-LSP-10). 종료 코드만 보면 "설치했습니다" 라고 말한 뒤 상태가 여전히 "없음"
// 이 되고, 그 모순은 우리 버그로 읽힌다.
func (r *InstallRunner) Install(ctx context.Context, d Descriptor) InstallOutcome {
	tool := d.Installer.Tool
	if tool == "" || len(d.Installer.Args) == 0 {
		return InstallOutcome{Reason: fmt.Sprintf("%s 는 받는 방법이 정해져 있지 않습니다", d.ID)}
	}
	// FR-LSP-11: 없는 것을 **이름으로** 알린다.
	if r.LookPath == nil {
		return InstallOutcome{Reason: "설치를 실행할 수 없습니다"}
	}
	if _, err := r.LookPath(tool); err != nil {
		return InstallOutcome{Reason: fmt.Sprintf(
			"%s 가 이 기계에 없어 %s 를 받을 수 없습니다 — %s 를 먼저 설치하세요",
			tool, d.ID, tool)}
	}
	if r.ManagedDir == "" {
		return InstallOutcome{Reason: "전용 디렉터리가 정해지지 않았습니다"}
	}
	// FR-LSP-7: 디렉터리는 우리가 만든다 — 없다고 실패하지 않는다.
	if err := os.MkdirAll(r.ManagedDir, 0o755); err != nil {
		return InstallOutcome{Reason: "전용 디렉터리를 만들지 못했습니다", Detail: err.Error()}
	}

	args, env := r.isolate(d)
	to := r.Timeout
	if to <= 0 {
		to = InstallTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()

	out, err := r.Exec(cctx, tool, args, env, r.ManagedDir)
	detail := tailOf(string(out), InstallOutput)
	if cctx.Err() == context.DeadlineExceeded {
		return InstallOutcome{
			Reason: fmt.Sprintf("%s 설치가 %s 안에 끝나지 않아 중단했습니다", d.ID, to),
			Detail: detail,
		}
	}
	if err != nil {
		return InstallOutcome{
			Reason: fmt.Sprintf("%s 가 %s 를 받지 못했습니다", tool, d.ID),
			Detail: detail,
		}
	}
	// 도구가 0 을 냈다 — 그러나 우리가 쓸 실행 파일이 실제로 놓였는가.
	//
	// FR-LWP-6: 탐색과 **같은 함수**로 찾는다. 여기서 다른 이름을 보면 설치는
	// 성공이라 하고 탐색은 없다고 한다.
	exe := ManagedExeFound(r.ManagedDir, d)
	if exe == "" {
		return InstallOutcome{
			Reason: fmt.Sprintf("%s 는 끝났는데 %s 가 놓이지 않았습니다",
				tool, ManagedExe(r.ManagedDir, d)),
			Detail: detail,
		}
	}
	return InstallOutcome{OK: true, Exe: exe, Detail: detail}
}

// isolate 는 격리 인자를 만든다 (FR-LSP-7·7b).
//
// 도구마다 격리의 자리가 다르다 — `go` 는 환경변수(`GOBIN`)로 받고 `npm` 은
// 인자(`--prefix`)로 받는다. 이 함수가 그 차이를 아는 **유일한 자리**다.
func (r *InstallRunner) isolate(d Descriptor) (args, env []string) {
	args = append(args, d.Installer.Args...)
	switch d.Installer.Tool {
	case "npm":
		// `--prefix` 는 전용 디렉터리를 npm 의 뿌리로 삼는다 — 실행 파일은
		// 그 아래 `node_modules/.bin` 에 놓인다 (ManagedExe 와 같은 규약).
		args = append(args, "--prefix", r.ManagedDir)
		// npm 이 사용자 전역 설정을 읽어 다른 자리에 쓰지 않게 한다.
		env = append(env, "npm_config_global=false")
	default:
		// `GOBIN` 이 산출물의 자리를 정한다. `GOFLAGS` 를 비우는 이유는
		// 사용자의 전역 플래그(예: `-mod=vendor`)가 `go install` 을 막기
		// 때문이다 — 그 실패는 우리가 설명할 수 없는 실패로 보인다.
		env = append(env,
			"GOBIN="+filepath.Join(r.ManagedDir, "bin"),
			"GOFLAGS=",
		)
	}
	return args, env
}

// isExecutable 은 Locator.executable 과 같은 판정이다. 두 벌인 것이 아니라
// 수신자가 없는 자리에서 쓰는 같은 규칙이며, 아래 Locator 가 이것을 부른다.
//
// **판정 자체는 platform 이 갖는다** (LSP_WINDOWS_PORTABILITY_SRS FR-LWP-1).
// 종전에는 여기서 실행 비트를 봤고, Go 가 Windows 의 보통 파일에 0666 을 주므로
// 그 판정이 Windows 에서 **언제나 거짓**이었다 — 받아 둔 서버를 못 찾고, 받아
// 놓고도 "놓이지 않았습니다" 라고 했다 (§2.1).
func isExecutable(path string) bool {
	return platform.Current().Paths.IsExecutable(path)
}

// tailOf 는 문자열의 끝쪽 n 바이트다. 도구의 출력에서 사용자가 읽을 부분은
// 대개 마지막 오류 줄이다.
func tailOf(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
