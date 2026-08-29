//go:build windows

package testpath

// PermChecked 는 Windows 에서 거짓이다. NTFS 에는 유닉스 권한 비트가 없고,
// Go 는 모든 파일을 `-rw-rw-rw-` 로 보고한다 — 0755 로 쓴 파일도 그렇다.
// 실행 가능 여부는 확장자(.exe·.ps1)가 정한다 (FR-WTP-32: 이 조건에서
// 빠지는 보증은 "권한 비트 보존" 하나이며, Windows 에 대응물이 없다).
func PermChecked() bool { return false }
