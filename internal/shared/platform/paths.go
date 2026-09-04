package platform

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

	// IsExecutable 은 그 경로가 **실행할 수 있는 보통 파일**인가다
	// (LSP_WINDOWS_PORTABILITY_SRS FR-LWP-1).
	//
	// 존재만 보지 않는 이유는 실패의 모양이다 — 실행할 수 없는 동명 파일을
	// 골라 쓰면 기동이 permission denied 나 "실행 파일이 아닙니다" 로 죽고,
	// 그 실패는 "없다" 가 아니라 "우리 버그" 로 보인다.
	//
	// **판정의 근거가 OS 마다 다르다.** POSIX 는 실행 비트이고 Windows 는
	// 확장자다 — Go 는 Windows 의 보통 파일에 0666 을 주므로 실행 비트를 보면
	// 언제나 거짓이 된다 (§2.1).
	IsExecutable(path string) bool

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

// FR-LWP-2: 실행 비트가 선 보통 파일. 종전 `lsp.isExecutable` 과 한 글자도 다르지
// 않다 — 권한 없는 동명 파일을 서버로 삼지 않는 규약(TC-LSP-7)이 여기 산다.
func (posixPaths) IsExecutable(path string) bool {
	fi, ok := statRegular(path)
	if !ok {
		return false
	}
	return fi.Mode().Perm()&0o111 != 0
}

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

// FR-LWP-3: Windows 는 **확장자**로 판정한다. 권한 비트는 아무것도 말하지 않는다.
func (windowsPaths) IsExecutable(path string) bool {
	if _, ok := statRegular(path); !ok {
		return false
	}
	return winExecutableName(path, os.Getenv("PATHEXT"))
}

// defaultPathExt 는 PATHEXT 가 비었을 때의 값이다. Windows 자신의 기본값이며,
// 우리가 고른 목록이 아니다.
const defaultPathExt = ".COM;.EXE;.BAT;.CMD"

// winExecutableName 은 이름만으로 하는 판정이다.
//
// build tag 없이 컴파일되므로 **darwin 호스트에서도 검증된다** (platform 패키지
// 머리말 §4.2 의 규약, V-LWP-1).
func winExecutableName(path, pathext string) bool {
	if pathext == "" {
		pathext = defaultPathExt
	}
	ext := strings.ToUpper(filepath.Ext(path))
	if ext == "" {
		return false
	}
	for _, want := range strings.Split(pathext, ";") {
		want = strings.ToUpper(strings.TrimSpace(want))
		if want == "" {
			continue
		}
		if !strings.HasPrefix(want, ".") {
			want = "." + want
		}
		if ext == want {
			return true
		}
	}
	return false
}

// statRegular 는 "있고, 디렉터리가 아니다" 다 (FR-LWP-4). 두 어댑터가 같은
// 앞머리를 쓰므로 한 자리에 둔다.
func statRegular(path string) (os.FileInfo, bool) {
	if path == "" {
		return nil, false
	}
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return nil, false
	}
	return fi, true
}

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
// WriteFileAtomic 은 data 를 path 에 **통째로** 쓴다 (FR-CAF-8).
//
// `os.WriteFile` 을 쓰면 안 되는 자리를 위한 것이다. 저쪽은 O_TRUNC 로 연 뒤
// 쓰므로, 그 사이에 프로세스가 죽거나 디스크가 차면 **잘린 파일이 살아 있는
// 파일이 된다.** `workspace.json`·`tools.json`·`settings.json` 과 편집기가
// 저장하는 사용자 파일이 그 처지였다.
//
// 계약의 핵심은 실패 쪽에 있다 (FR-CAF-10): **실패해도 목적 파일의 기존 내용은
// 그대로다.** 새 내용을 못 쓰는 것보다 옛 내용을 잃는 것이 나쁘다.
//
// fsync 를 하는 이유는 rename 만으로는 "잘린 파일" 은 막아도 "빈 파일" 은 막지
// 못하기 때문이다 — 임시 파일의 내용이 디스크에 닿기 전에 rename 만 먼저 반영될
// 수 있다. 이 파일들은 초당 여러 번 쓰이지 않으므로 비용이 문제되지 않는다.
//
// 거는 것은 replaceFile 이다. 그것이 Windows 에서 왜 단순하지 않은지는 그 함수의
// 머리말에 있다 — 여기서 그 지식을 다시 적지 않는다.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := tempSibling(path)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// umask 가 먹은 비트를 되돌린다 — 호출자가 적은 perm 이 결과여야 한다.
	if err := os.Chmod(tmp, perm); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := replaceFile(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

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
