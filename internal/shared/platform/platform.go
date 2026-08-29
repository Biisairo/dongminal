// Package platform 은 운영체제마다 갈리는 능력을 인터페이스 뒤로 보낸다.
//
// 존재 이유는 하나다 — **호출부가 OS 를 알지 못하게 하는 것**이다. 종전에는
// syscall.Kill·Setsid·/proc·lsof·/bin/bash·net.Listen("unix") 가 각각의 사용처에
// 그대로 박혀 있었고, 그래서 dongminal 은 사실상 darwin 전용이었다. 그것을
// 다형성으로 바꾼다. 호출부에 OS 이름이 나타나면 그것은 이 패키지의 실패다
// (CROSS_PLATFORM_SRS FR-XPL-5).
//
// 구조는 sysstat.Reader 의 선례를 따른다.
//
//   - 인터페이스와 **모든** 어댑터 구현은 build tag 없이 컴파일된다. 그래서
//     Windows 용 조립 로직도 darwin 호스트에서 테스트된다 (SRS §4.2).
//   - build tag 가 붙는 것은 **번들 조립**(platform_<goos>.go) 뿐이다.
//     실제 시스템 호출을 하는 어댑터만 예외적으로 태그를 갖는다.
//
// 이 패키지는 internal/ 안의 다른 패키지를 import 하지 않는다 (FR-XPL-6).
package platform

import "sync"

// 주입점 세 가지다. 어댑터가 OS API 를 직접 부르는 대신 이것을 통하면, 그
// 어댑터의 판단 로직 전량을 다른 호스트에서도 검증할 수 있다 (§4.2).
type (
	// lookFn 은 exec.LookPath 다.
	lookFn = func(string) (string, error)
	// envFn 은 os.Getenv 다.
	envFn = func(string) string
	// statFn 은 "이 경로가 있는가" 다. nil 이면 있다.
	statFn = func(string) error
)

// Platform 은 이 빌드가 제공하는 OS 능력의 묶음이다. 필드는 모두 인터페이스이며,
// 소비자는 번들이 아니라 자기가 쓰는 필드 하나만 받는다 (FR-XPL-2).
//
// 필드는 해당 능력이 구현된 단계에서 추가된다 (FR-XPL-3a).
type Platform struct {
	// OS 는 표시·기록용 값이다. 분기의 근거가 아니다 (OSKind 주석 참조).
	OS      OSKind
	Process Process
	Info    ProcInfo
	PTY     PTY
	Shell   ShellProvider
	IPC     IPC
	Paths   Paths
	Browser Browser
}

var (
	currentOnce sync.Once
	current     Platform
)

// Current 는 이 빌드의 구현을 낸다. 값은 프로세스 수명 동안 같다 — WSL 판정이
// /proc 을 읽으므로 매 호출마다 다시 하지 않는다 (FR-XWS-1).
func Current() Platform {
	currentOnce.Do(func() { current = newPlatform() })
	return current
}
