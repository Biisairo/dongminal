//go:build !windows

package testpath

import "os"

// posixShells 는 검사가 아는 셸의 이름 → 경로다. 제품의 셸 선택(`platform`)과
// 별개로 두는 이유는 순환 때문이다 — platform 의 검사가 이 패키지를 쓴다. 이
// 패키지는 테스트 전용이라 이음매 게이트(check-seams)가 예외로 둔다.
var posixShells = map[string]string{"bash": "/bin/bash", "sh": "/bin/sh", "zsh": "/bin/zsh"}

// pinnedShells 는 테스트가 띄우는 셸의 후보 순서다 — 앞의 것이 있으면 그것이다.
// bash 가 먼저인 이유는 macOS·리눅스·CI 러너 어디에나 있어서다.
var pinnedShells = []string{"bash", "sh"}

// PinShell 은 이 테스트 바이너리가 띄우는 셸을 고정한다 (M8 D-A-21, TEST-25).
//
// 왜 필요한가: 도구 셸은 `$SHELL` 로 고른다(`platform.posixShell.pick`). 그러면
// zsh 호스트와 bash 러너가 **다른 코드 경로**(ZDOTDIR 사슬 · `--rcfile`)를 지나고,
// 결과는 "돈 항목 수" 로만 보인다 — 어느 셸이 검사됐는지가 사람이 아는 것에 달렸다.
// 고정하면 호스트가 무엇이든 같은 경로를 지난다. 특정 셸의 사슬을 재야 하는 검사는
// 자기 자리에서 `t.Setenv("SHELL", …)` 로 고른다 (`Shells`). 돌려주는 함수는 되돌린다.
func PinShell() func() {
	prev, had := os.LookupEnv("SHELL")
	for _, name := range pinnedShells {
		if path, ok := shellPath(name); ok {
			os.Setenv("SHELL", path)
			break
		}
	}
	return func() {
		if had {
			os.Setenv("SHELL", prev)
		} else {
			os.Unsetenv("SHELL")
		}
	}
}

// Shells 는 이 호스트에 있는 검사 대상 셸이다 — 이름 → 경로. 없는 셸은 빠지므로
// 호출자가 그 이름을 Skip 사유로 남긴다 (조용히 빠지지 않는다).
func Shells() map[string]string {
	out := map[string]string{}
	for _, name := range []string{"bash", "zsh"} {
		if path, ok := shellPath(name); ok {
			out[name] = path
		}
	}
	return out
}

func shellPath(name string) (string, bool) {
	path, known := posixShells[name]
	if !known {
		return "", false
	}
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	return path, true
}
