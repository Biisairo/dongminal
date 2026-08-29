package platform

import "strings"

// OSKind 는 이 빌드가 도는 운영체제의 종류다 (FR-XPL-4).
//
// 이 값은 **표시·기록용**이다. 능력의 분기 근거가 아니다 — 분기는 Platform 을
// 조립할 때 build tag 로 이미 끝나 있고, 그 뒤로는 인터페이스가 가른다.
// 호출부에서 OSKind 로 갈라지는 코드를 쓰면 그것은 FR-XPL-3 의 위반이다.
type OSKind string

const (
	Darwin  OSKind = "darwin"
	Linux   OSKind = "linux"
	WSL     OSKind = "wsl"
	Windows OSKind = "windows"
)

func (k OSKind) String() string { return string(k) }

// WSL 판정에 쓰는 경로들이다. WSL2 는 osrelease 에, WSL1 은 version 에 표식을
// 남기므로 둘 다 본다.
const (
	osReleasePath   = "/proc/sys/kernel/osrelease"
	procVersionPath = "/proc/version"

	// wslMarker 는 WSL 커널이 남기는 표식이다. 대소문자는 배포판·버전마다 달라
	// 소문자로 낮춰 비교한다.
	wslMarker = "microsoft"
)

// linuxKind 는 리눅스 빌드가 WSL 위에 있는지를 가른다 (FR-XWS-1). read 는
// 파일 읽기 주입점이다 — 이 함수는 build tag 없이 컴파일되므로 어느 호스트에서도
// 검증된다 (§4.2).
//
// 읽지 못한 경로는 판정을 끝내지 않는다. 첫 경로의 실패로 멈추면 WSL1 을
// 리눅스로 오판한다.
func linuxKind(read func(string) ([]byte, error)) OSKind {
	for _, p := range []string{osReleasePath, procVersionPath} {
		blob, err := read(p)
		if err != nil {
			continue
		}
		if strings.Contains(strings.ToLower(string(blob)), wslMarker) {
			return WSL
		}
	}
	return Linux
}
