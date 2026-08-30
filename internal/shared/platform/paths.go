package platform

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"
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
// 이미 같은 곳을 가리키는 symlink 면 아무 것도 하지 않는다.
//
// 대상이 바뀌는 재설치는 **옆에 만들고 rename 으로 덮는다** (FR-ATI-1).
// 지웠다 다시 거는 순서로 하면 그 사이에 dst 가 없고, 그 경로를 부르는 훅이
// `No such file or directory` 로 죽는다 — 창은 이론상의 것이 아니라 실측
// 5,037회다 (RECONNECT_STORM_SRS §2.3, V-ATI-1). POSIX rename(2) 은 원자적이고
// 같은 디렉터리라 파일시스템 경계를 넘지 않는다.
func (posixPaths) LinkOrCopy(src, dst string) error {
	if existing, err := os.Readlink(dst); err == nil && existing == src {
		return nil
	}
	tmp := tempSibling(dst)
	if err := os.Symlink(src, tmp); err == nil {
		if err := replaceFile(tmp, dst); err == nil {
			return nil
		}
		_ = os.Remove(tmp)
	} else if !errors.Is(err, os.ErrExist) {
		// 심링크를 아예 만들 수 없는 파일시스템이다. 복사로 물러선다.
		_ = os.Remove(tmp)
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

// tempSibling 은 dst 를 원자적으로 덮기 위한 **같은 디렉터리의** 임시 이름이다
// (FR-ATI-4). 같은 디렉터리여야 하는 이유는 rename 의 원자성이 파일시스템 안에서만
// 성립하기 때문이다 — /tmp 를 거치면 EXDEV 로 실패하거나 복사로 떨어진다.
//
// pid 를 넣는 이유는 두 프로세스가 동시에 설치해도 서로의 임시 파일을 건드리지
// 않게 하려는 것이고, 카운터는 한 프로세스 안의 동시 설치를 가른다. 랜덤이 아닌
// 이유는 실패로 남은 잔여물을 사람이 추적할 수 있게 하기 위해서다.
func tempSibling(dst string) string {
	n := tempSeq.Add(1)
	return dst + ".tmp" + strconv.Itoa(os.Getpid()) + "." + strconv.FormatUint(n, 10)
}

var tempSeq atomic.Uint64

// replaceFile 은 tmp 를 dst 로 옮긴다. **목적 경로를 비우지 않는 것이 계약이다**
// (FR-ATI-1).
//
// Windows 는 갓 쓴 파일을 바이러스 검사·인덱서가 잠깐 열어 두는 일이 흔하고,
// 그동안 MoveFileEx 가 거부된다. 그 거부에 "목적 경로를 지워서" 답하면 계약이
// 깨진다 — 실측으로 Windows CI 에서 120회 중 4회 dst 가 비었다. 일시적인
// 거부에는 **물러섰다 다시 시도하는 것**이 옳은 답이다.
//
// 재시도를 다 써도 안 되면 부르는 쪽이 마지막 수단(옆으로 밀어내기)을 쓴다 —
// 그것은 실행 중인 파일을 갱신할 때만 필요하고, 그때는 창을 피할 방법이 없다.
func replaceFile(tmp, dst string) error {
	var err error
	for i := range renameTries {
		if err = os.Rename(tmp, dst); err == nil {
			return nil
		}
		time.Sleep(renameBackoff * time.Duration(i+1))
	}
	return err
}

const (
	renameTries   = 10
	renameBackoff = 20 * time.Millisecond
)

// copyExecutable 은 src 를 dst 로 복사하고 실행 권한을 준다.
//
// **옆에 다 쓴 뒤 rename 으로 덮는다** (FR-ATI-2). 제자리를 O_TRUNC 로 열면 그
// 순간부터 복사가 끝날 때까지 dst 는 빈 파일이고, 그 창에 exec 한 훅은 죽는다
// (V-ATI-5 가 이것을 실측으로 잡는다).
//
// rename 이 실패하면 dst 를 옆으로 밀어내고 다시 건다. Windows 는 실행 중인
// 파일을 덮어쓸 수 없지만 **이름은 바꿀 수 있다** — dmctl 은 에이전트가 상시
// 부르는 것이라 갱신 시점에 돌고 있을 가능성이 높다. POSIX 에서는 rename 이
// 실행 중인 파일도 덮으므로 이 갈래로 오지 않는다. 밀어낸 파일은 지워지면
// 좋고 안 지워져도 무방하다(다음 기동이 치운다).
// CopyExecutable 은 심볼릭 링크를 쓰지 않고 **실체를 복사**한다.
//
// LinkOrCopy 와 갈라 두는 이유는 대상이 사라질 수 있는 경우다 — `go run` 의
// 임시 산출물을 가리키는 링크는 그 프로세스가 끝나면 죽는다
// (HELPER_INSTALL_SRS FR-HLI-1). 그때는 링크가 아니라 복사여야 한다.
func CopyExecutable(src, dst string) error { return copyExecutable(src, dst) }

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := tempSibling(dst)
	out, err := openExecutable(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	if err := replaceFile(tmp, dst); err != nil {
		aside := dst + ".old"
		_ = os.Remove(aside)
		if rerr := os.Rename(dst, aside); rerr != nil {
			_ = os.Remove(tmp)
			return err
		}
		if rerr := replaceFile(tmp, dst); rerr != nil {
			// 되돌린다 — 밀어내고 못 걸면 dst 가 아예 없는 채로 끝난다.
			_ = os.Rename(aside, dst)
			_ = os.Remove(tmp)
			return rerr
		}
		_ = os.Remove(aside)
	}
	return nil
}

func openExecutable(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
}
