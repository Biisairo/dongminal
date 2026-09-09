package toolhub

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// 도구별 셸 히스토리 (TOOL_HISTORY_ISOLATION_SRS).
//
// 왜 필요한가. 도구 셸은 로그인 셸이라 종료할 때 히스토리를 쓰고 시작할 때
// 파일 전체를 읽는다. 모든 도구가 `$HOME/.zsh_history` 하나를 공유했으므로,
// 서버를 내리면 모든 셸이 자기 명령을 그 파일에 붙이고 올리면 되살아난 모든
// 셸이 그 통합본을 읽었다 — 재기동 한 번에 모든 터미널의 히스토리가 합쳐졌다
// (SRS §2.4 의 실측).
//
// 도구 id 는 재기동을 넘어 유지되므로(tools.json → Restore), 파일 이름을 id 로
// 지으면 격리와 동시에 **그 터미널의 히스토리가 그 터미널로 돌아온다.**
//
// 경로를 정하고 시드를 놓는 일은 여기 한 곳에서만 한다 (FR-THI-20). 셸 쪽
// 스크립트는 값을 만들지 않고 되살리기만 한다 — bash 훅은 대화형 로그인 셸에서
// 아예 로드되지 않으므로(SRS §2.7), 규칙을 rc 에 두면 bash 에서 조용히 빠진다.

// toolHistDir 은 인스턴스 홈 아래에서 도구 히스토리가 사는 자리다. tools.json 과
// 같은 자리이므로 격리 기동에서는 그 홈째로 함께 격리된다 (D-4).
const toolHistDir = "tool-history"

// toolHistEnv 는 도구 셸에 심을 히스토리 환경이다. 심을 수 없으면 nil 을 내고,
// 그때 셸은 이 기능이 없던 때와 똑같이 동작한다 (FR-THI-5, NFR-THI-3).
//
// shellPath 는 이 도구가 띄울 셸의 실행 경로다. 히스토리 형식이 셸마다 다르므로
// 파일 이름이 셸을 함께 담는다 (FR-THI-2).
func toolHistEnv(id, shellPath string) []string {
	if !safeHistName(id) {
		return nil
	}
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		return nil
	}
	shell := histShellName(shellPath)
	if !safeHistName(shell) {
		return nil
	}
	dir := filepath.Join(home, toolHistDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		// 만들 수 없으면 종전 동작으로 내려간다. 히스토리를 위해 도구가 뜨지
		// 않는 일은 없어야 한다.
		log.Printf("[tool %s] history dir: %v", id, err)
		return nil
	}
	path := filepath.Join(dir, id+"."+shell)
	seedHistFile(path, userHistFile(shell))
	return []string{"HISTFILE=" + path, dmenv.EnvHistFile + "=" + path}
}

// userHistFile 은 그 셸이 **평소 쓰는** 히스토리 자리다. 시드의 원본이며 규칙이
// 셸마다 다르다 (HOST_PARITY_SRS FR-HPR-16).
//
// PowerShell 만 홈 밑의 점파일이 아니다 — PSReadLine 은 로밍 프로필 아래 고정된
// 자리를 쓴다. 종전에는 이 갈래가 없어 `~/.powershell_history` 라는 실재하지 않는
// 파일을 시드 원본으로 삼았고, Windows 사용자는 새 도구마다 빈 기록을 받았다.
//
// 규칙이 여기 한 곳에 있는 이유는 FR-THI-20 이다 — 훅 스크립트로 새면 두 벌이
// 된다.
func userHistFile(shell string) string {
	if shell == "powershell" || shell == "pwsh" {
		base := os.Getenv("APPDATA")
		if base == "" {
			return ""
		}
		return filepath.Join(base, "Microsoft", "Windows", "PowerShell",
			"PSReadLine", "ConsoleHost_history.txt")
	}
	return filepath.Join(toolHome(), "."+shell+"_history")
}

// histShellName 은 실행 경로에서 셸 이름을 뽑는다 — `/bin/zsh` → `zsh`,
// Windows 의 `powershell.exe` → `powershell`.
func histShellName(shellPath string) string {
	base := filepath.Base(shellPath)
	if ext := platform.Current().Paths.ExeSuffix(); ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	return strings.ToLower(base)
}

// safeHistName 은 파일 이름 한 조각으로 쓸 수 있는 값인지 본다.
//
// id 가 언제나 uuid 라고 믿지 않는다 — tools.json 은 사람이 고칠 수 있는 파일이고,
// 거기서 온 값이 그대로 경로가 된다. `..` 하나면 이 함수가 없는 한 인스턴스 홈
// 바깥에 파일을 쓴다.
func safeHistName(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, `/\`+"\x00") {
		return false
	}
	return true
}

// seedHistFile 은 도구의 히스토리 파일이 **없을 때만** 사용자 히스토리를 옮겨
// 놓는다 (FR-THI-10·13, D-6).
//
// O_EXCL 로 만드는 것이 요점이다. "있는지 보고 없으면 쓴다"는 두 도구가 동시에
// 뜨는 순간을 견디지 못하고, 그 실패는 사용자가 쌓아 둔 히스토리를 지운다.
//
// 원본이 없어도 빈 파일을 만든다. 셸이 만들게 두면 그 권한이 umask 를 따르는데,
// 이 파일에는 사용자가 친 명령이 담긴다 (NFR-THI-1).
func seedHistFile(dst, src string) {
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		// 이미 있다 — 정상 경로다. 그 밖의 오류도 마찬가지로 조용히 지나간다;
		// 셸은 히스토리 없이도 뜬다.
		return
	}
	defer f.Close()
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	if _, err := f.Write(data); err != nil {
		log.Printf("history seed %s: %v", dst, err)
	}
}
