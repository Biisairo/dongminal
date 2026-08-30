//go:build !windows

package testpath

// HomeEnv 는 이 OS 에서 홈 디렉터리를 정하는 환경변수 이름이다.
//
// 프로덕션은 `os.UserHomeDir()` 을 쓰는데, 그것이 보는 변수가 OS 마다 다르다 —
// POSIX 는 HOME, Windows 는 USERPROFILE. 테스트가 "HOME" 을 박으면 Windows 에서
// **아무 효과가 없고**, 임시 홈 대신 진짜 사용자 홈이 새어 들어온다
// (WINDOWS_TEST_PARITY_SRS FR-WTP-9).
func HomeEnv() string { return "HOME" }
