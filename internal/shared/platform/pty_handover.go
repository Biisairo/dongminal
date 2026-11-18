package platform

import "errors"

// Handover 는 데몬 교체(세션 유지 재시작)에 터미널이 내놓는 능력이다
// (DAEMON_SESSION_KEEP_SRS FR-DSK-13). POSIX 터미널만 갖는다 (D-DSK-7).
type Handover interface {
	// Freeze 는 읽기를 멈춘다. 돌아온 뒤로 Read 는 바이트를 가져가지 않고 ErrFrozen 을
	// 돌려준다. 그동안의 출력은 커널 버퍼에 남는다 (NFR-DSK-2).
	Freeze()
	// Thaw 는 Freeze 를 되돌린다.
	Thaw()
	// MasterFD 는 의사 터미널 마스터 쪽 fd 다. exec 로 넘길 때 쓴다.
	MasterFD() uintptr
}

// ErrFrozen 은 Freeze 된 터미널의 Read 가 돌려주는 오류다. 끝이 아니다 — Thaw 뒤에 다시 읽는다.
var ErrFrozen = errors.New("터미널 읽기가 멈춰 있다")
