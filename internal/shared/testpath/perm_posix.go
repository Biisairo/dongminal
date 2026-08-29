//go:build !windows

package testpath

// PermChecked 는 이 호스트가 유닉스 권한 비트를 보존하는지 알린다.
//
// 권한 비트를 단언하는 검사를 이것으로 감싼다. 테스트 전체를 build tag 로
// 빼지 않는 이유는 FR-WTP-31 이다 — 같은 테스트의 이식 가능한 절반까지 함께
// 사라지면, 빠진 줄 모르는 보증이 는다.
func PermChecked() bool { return true }

// ForegroundGroups 는 이 OS 에 **전경 프로세스 그룹**이 있는지 알린다
// (CROSS_PLATFORM_SRS FR-XPT-5). 능력의 이름으로 묻는다 — OS 의 이름으로
// 가르지 않는 것이 이 저장소의 규칙이다 (FR-XBD-3).
func ForegroundGroups() bool { return true }
