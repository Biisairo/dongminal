package platform

import (
	"net"
	"os"
	"path/filepath"
	"time"
)

// IPC 는 dongminal(웹서버) ↔ dongminald(데몬) 사이의 로컬 전송이다 (FR-XIP-1).
// 로컬 전용이며 네트워크에 노출되지 않는다.
type IPC interface {
	// Endpoint 는 home 에 대응하는 종단 주소다.
	Endpoint(home string) string

	Listen(endpoint string) (net.Listener, error)
	Dial(endpoint string, timeout time.Duration) (net.Conn, error)

	// Exists 는 종단이 놓여 있는지다. **살아 있는지가 아니다** — 살아 있는지는
	// 호출자가 Dial 로 확인한다. 이 둘을 섞으면 죽은 종단을 치우지 못한다.
	Exists(endpoint string) bool

	// Remove 는 잔여 종단을 치운다.
	Remove(endpoint string) error
}

// SocketFileName 은 종단 파일의 이름이다. 홈 안의 다른 파일들과 함께 쓰이므로
// 내보낸다.
const SocketFileName = "paned.sock"

// unixSocketIPC 는 유닉스 도메인 소켓 종단이다.
//
// Windows 에서도 같은 전송을 쓴다. AF_UNIX 는 Windows 10 1803 부터 지원되고,
// 이 트랙의 Windows 최소 버전은 ConPTY 때문에 1809 이므로 항상 쓸 수 있다
// (C-1). named pipe 리스너를 직접 구현하지 않는 이유는 검증이다 — 겹치기
// 어려운 오버랩드 I/O 코드를 실기 없이 인도하는 것보다, 표준 net 패키지가
// 이미 검증한 경로를 쓰는 편이 낫다.
type unixSocketIPC struct {
	// isSocket 은 stat 결과가 종단인지 판정한다. POSIX 는 소켓 비트를 보지만
	// Windows 의 AF_UNIX 종단은 재분석 지점으로 나타나 그 비트가 서지 않는다.
	// 그 차이만 주입으로 가른다.
	isSocket func(os.FileInfo) bool
}

func (unixSocketIPC) Endpoint(home string) string {
	return filepath.Join(home, SocketFileName)
}

func (unixSocketIPC) Listen(endpoint string) (net.Listener, error) {
	return net.Listen("unix", endpoint)
}

func (unixSocketIPC) Dial(endpoint string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", endpoint, timeout)
}

func (i unixSocketIPC) Exists(endpoint string) bool {
	fi, err := os.Stat(endpoint)
	return err == nil && i.isSocket(fi)
}

func (unixSocketIPC) Remove(endpoint string) error {
	if err := os.Remove(endpoint); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// posixIsSocket 은 소켓 비트를 본다 — 종전 cli/proc.go 의 판정과 같다.
func posixIsSocket(fi os.FileInfo) bool { return fi.Mode()&os.ModeSocket != 0 }

// windowsIsSocket 은 존재만으로 판정한다. Windows 의 AF_UNIX 종단에는 소켓
// 비트가 서지 않으므로 그것을 요구하면 살아 있는 데몬을 못 본다.
func windowsIsSocket(os.FileInfo) bool { return true }
