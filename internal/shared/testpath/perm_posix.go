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

// POSIXShell 은 이 OS 가 `#!/bin/sh` 스크립트를 실행할 수 있는지 알린다.
//
// 가짜 셸을 스크립트로 만들어 신호 처리를 시험하는 검사가 이것을 딛는다.
// Windows 에는 그 셰뱅도, 그 신호(SIGTERM trap)도 없다 — 정중한 종료의 의미가
// 다르다 (CROSS_PLATFORM_SRS FR-XPR-3: Ctrl+Break 뒤 강제 종료).
func POSIXShell() bool { return true }

// Symlinks 는 이 호스트가 **권한 없이** 심링크를 만들 수 있는지 알린다.
//
// 링크를 따라가지 않는 것을 검증하는 검사들이 이것을 딛는다 — 링크를 만들지
// 못하면 그 검사는 아무것도 재지 못한다 (LEFTOVERS_SRS FR-LFT-2).
func Symlinks() bool { return true }
