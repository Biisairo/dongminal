package platform

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Paths 는 경로 규약과 파일 설치의 OS 차이다 (FR-XPA-1).
type Paths interface {
	// DefaultLogFile 은 --foreground 가 아닌 기동이 출력을 남길 자리다.
	// 상위 디렉터리는 존재하지 않을 수 있다 — 호출자가 만든다.
	DefaultLogFile() string

	// ExeSuffix 는 실행 파일의 확장자다. POSIX 는 "", Windows 는 ".exe".
	ExeSuffix() string

	// LinkOrCopy 는 dst 가 src 의 실행 가능한 링크 또는 사본이 되게 한다.
	LinkOrCopy(src, dst string) error
}

const logBaseName = "dongminal.log"

// statFile 은 statFn 의 실제 구현이다. "있는가" 만 답하며 무엇인지는 묻지 않는다.
func statFile(p string) error {
	_, err := os.Stat(p)
	return err
}

// ── posix ────────────────────────────────────────────

type posixPaths struct{}

// /tmp 하드코딩은 종전 cli.DefaultLog 와 같은 값이다 (§7 #2).
func (posixPaths) DefaultLogFile() string { return filepath.Join("/tmp", logBaseName) }

func (posixPaths) ExeSuffix() string { return "" }

// symlink 를 먼저 시도하고 안 되면 복사한다. 종전 runtime.installHelper 와 같다.
// 이미 같은 곳을 가리키는 symlink 면 아무 것도 하지 않는다 — 매 기동마다
// 지웠다 다시 거는 동안 그 경로를 부르는 도구가 있으면 그 호출이 실패한다.
func (posixPaths) LinkOrCopy(src, dst string) error {
	if existing, err := os.Readlink(dst); err == nil && existing == src {
		return nil
	}
	if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Symlink(src, dst); err == nil {
		return nil
	}
	return copyExecutable(src, dst)
}

// ── windows ──────────────────────────────────────────

type windowsPaths struct{}

func (windowsPaths) DefaultLogFile() string { return windowsLogFile(os.Getenv, os.TempDir) }

func (windowsPaths) ExeSuffix() string { return ".exe" }

// Windows 는 symlink 를 시도하지 않는다 (FR-XPA-3). 개발자 모드가 아닌 계정에서
// symlink 는 관리자 권한을 요구하므로, 시도했다 복사로 물러서는 흐름은 매 기동마다
// 권한 오류만 남기고 결과는 같다.
func (windowsPaths) LinkOrCopy(src, dst string) error { return copyExecutable(src, dst) }

// windowsLogFile 은 로그 자리를 정한다. env·tempDir 주입점은 테스트를 위한
// 것이다 — 이 함수는 build tag 가 없어 어느 호스트에서도 검증된다 (§4.2).
func windowsLogFile(env envFn, tempDir func() string) string {
	if base := env("LOCALAPPDATA"); base != "" {
		return filepath.Join(base, "dongminal", logBaseName)
	}
	// 서비스 계정 등 LOCALAPPDATA 가 비는 환경이 있다. 로그 자리가 없다고
	// 기동을 접을 이유는 없다.
	return filepath.Join(tempDir(), logBaseName)
}

// ── 공통 ─────────────────────────────────────────────

// copyExecutable 은 src 를 dst 로 복사하고 실행 권한을 준다.
//
// dst 를 곧바로 열지 못하면 옆으로 밀어내고 다시 시도한다. Windows 는 실행 중인
// 파일을 덮어쓸 수 없지만 **이름은 바꿀 수 있다** — dmctl 은 에이전트가 상시
// 부르는 것이라 갱신 시점에 돌고 있을 가능성이 높다. 밀어낸 파일은 지워지면
// 좋고 안 지워져도 무방하다(다음 기동이 치운다).
func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := openExecutable(dst)
	if err != nil {
		aside := dst + ".old"
		_ = os.Remove(aside)
		if rerr := os.Rename(dst, aside); rerr != nil {
			return err
		}
		defer os.Remove(aside)
		if out, err = openExecutable(dst); err != nil {
			return err
		}
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func openExecutable(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
}
