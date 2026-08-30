//go:build windows

package testpath

// PermChecked 는 Windows 에서 거짓이다. NTFS 에는 유닉스 권한 비트가 없고,
// Go 는 모든 파일을 `-rw-rw-rw-` 로 보고한다 — 0755 로 쓴 파일도 그렇다.
// 실행 가능 여부는 확장자(.exe·.ps1)가 정한다 (FR-WTP-32: 이 조건에서
// 빠지는 보증은 "권한 비트 보존" 하나이며, Windows 에 대응물이 없다).
func PermChecked() bool { return false }

// ForegroundGroups 는 이 OS 에 **전경 프로세스 그룹**이 있는지 알린다
// (CROSS_PLATFORM_SRS FR-XPT-5). 능력의 이름으로 묻는다 — OS 의 이름으로
// 가르지 않는 것이 이 저장소의 규칙이다 (FR-XBD-3).
func ForegroundGroups() bool { return false }

// POSIXShell 은 이 OS 가 `#!/bin/sh` 스크립트를 실행할 수 있는지 알린다.
//
// 가짜 셸을 스크립트로 만들어 신호 처리를 시험하는 검사가 이것을 딛는다.
// Windows 에는 그 셰뱅도, 그 신호(SIGTERM trap)도 없다 — 정중한 종료의 의미가
// 다르다 (CROSS_PLATFORM_SRS FR-XPR-3: Ctrl+Break 뒤 강제 종료).
func POSIXShell() bool { return false }
