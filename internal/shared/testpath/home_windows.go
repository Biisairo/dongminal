//go:build windows

package testpath

// HomeEnv 는 Windows 에서 USERPROFILE 이다 — os.UserHomeDir 이 그것을 본다.
func HomeEnv() string { return "USERPROFILE" }
