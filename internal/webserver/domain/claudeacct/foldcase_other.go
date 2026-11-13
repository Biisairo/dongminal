//go:build !windows

package claudeacct

// foldCase 는 경로의 대소문자를 구분하지 않는 운영체제인가다 (FR-CAC-80).
const foldCase = false
