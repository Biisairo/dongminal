//go:build !darwin && !linux

// POSIX 가 아닌 플랫폼용 대체다 (FR-TAN-24). 전경 조회는 조용히 비활성되며
// 오류를 내지 않는다 — 탭 이름은 기본값으로 남는다. cross-platform 후속
// 트랙이 채울 자리는 이 파일 하나다 (C-4, NFR-CNV-5).

package toolhub

import "os"

func foregroundName(*os.File, int) string { return "" }

func foregroundNames([]fgRequest) map[string]string { return nil }
