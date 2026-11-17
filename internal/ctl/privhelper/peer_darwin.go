package privhelper

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

// peerUID 는 macOS 의 LOCAL_PEERCRED 로 접속한 프로세스의 uid 를 읽는다.
func peerUID(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return -1, errors.New("유닉스 소켓이 아니다")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var gerr error
	if err := raw.Control(func(fd uintptr) {
		cred, e := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if e != nil {
			gerr = e
			return
		}
		uid = int(cred.Uid)
	}); err != nil {
		return -1, err
	}
	return uid, gerr
}

// supported 는 이 OS 에 도우미가 있는가다 (FR-PCH-79).
const supported = true
