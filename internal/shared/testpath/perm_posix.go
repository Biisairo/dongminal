//go:build !windows

package testpath

// PermChecked 는 이 호스트가 유닉스 권한 비트를 보존하는지 알린다.
//
// 권한 비트를 단언하는 검사를 이것으로 감싼다. 테스트 전체를 build tag 로
// 빼지 않는 이유는 FR-WTP-31 이다 — 같은 테스트의 이식 가능한 절반까지 함께
// 사라지면, 빠진 줄 모르는 보증이 는다.
func PermChecked() bool { return true }
