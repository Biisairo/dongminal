//go:build !darwin

package privhelper

import (
	"errors"
	"net"
)

// peerUID 는 macOS 밖에서 아직 없다 (FR-PCH-79). 모든 연결을 끊는다.
func peerUID(net.Conn) (int, error) { return -1, errors.New("이 OS 의 도우미는 아직 없다") }

// supported 는 이 OS 에 도우미가 있는가다 (FR-PCH-79).
const supported = false
