package platform

import (
	"path/filepath"
	"strings"
)

// ShellSpec 은 도구 하나를 띄울 셸의 명세다 (FR-XSH-1).
type ShellSpec struct {
	Path string   // 실행 파일
	Args []string // Args[0] 을 뺀 인자
	Env  []string // 이 셸에만 필요한 추가 "K=V"
}

// ShellProvider 는 대화형 셸의 선택과 훅 주입 방식이다.
type ShellProvider interface {
	// EchoCommand 는 text 한 줄을 내보내고 끝나는 명령의 argv 다. 대화형이
	// 아니므로 프롬프트도 입력도 필요 없다 — 의사 터미널의 배관만 시험하는
	// 자리에 쓴다.
	EchoCommand(text string) []string

	// Shell 은 이 호스트의 대화형 셸 명세를 낸다. binDir 은 헬퍼와 훅이
	// 설치된 곳이며, 훅 주입 환경변수가 이 경로를 참조한다.
	Shell(binDir string) ShellSpec

	// HookRoot 는 binDir 에 풀어야 할 훅 자산의 임베드 서브트리 이름이다.
	// 이 OS 의 것만 푼다 — 모든 OS 의 훅을 다 풀지 않는다 (FR-XSH-4).
	HookRoot() string

	// Quote 는 s 를 이 셸에 그대로 타이핑해도 **한 덩어리 리터럴**로 남도록
	// 인용한다. 전개·치환·단어 분리가 일어나지 않아야 하며, 개행도 그대로
	// 살아야 한다.
	//
	// 인용법은 셸마다 다르다 — POSIX sh 는 홑따옴표 안의 홑따옴표를 닫았다
	// 이스케이프하고 다시 열지만, PowerShell 은 겹쳐서 쓴다. 한쪽 규칙을
	// 다른 셸에 쓰면 따옴표가 닫히지 않아 명령이 통째로 깨진다.
	Quote(s string) string
}

// PosixHookRoot·WindowsHookRoot 는 임베드 트리의 서브디렉터리 이름이다.
// 자산을 담은 쪽(shared/runtime)과 이름을 정하는 쪽이 어긋나지 않도록
// 상수로 내보낸다.
const (
	PosixHookRoot   = "posix"
	WindowsHookRoot = "windows"
)

// ── posix ────────────────────────────────────────────

// posixShellFallbacks 는 $SHELL 이 없거나 쓸 수 없을 때의 차선이다.
var posixShellFallbacks = []string{"/bin/bash", "/bin/sh"}

// posixShellHook 은 셸별 훅 주입 방식이다. 셸마다 비대화형 시작 시 읽는
// 파일과 그것을 가리키는 변수가 다르다. **OS 분기가 아니라 셸 분기다.**
type posixShellHook struct {
	match string
	env   func(binDir string) string
}

var posixShellHooks = []posixShellHook{
	{"zsh", func(b string) string { return "ZDOTDIR=" + filepath.Join(b, "zdotdir") }},
	{"bash", func(b string) string { return "BASH_ENV=" + filepath.Join(b, "bash-hook.sh") }},
}

type posixShell struct {
	env  envFn
	stat statFn
}

func (s posixShell) HookRoot() string { return PosixHookRoot }

// 홑따옴표 안에서는 개행을 포함해 어떤 문자도 특수하지 않다. 홑따옴표 자신만
// 닫고(') 이스케이프한 뒤(\') 다시 여는(') 형태로 이어 붙인다.
func (s posixShell) Quote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'"
}

func (s posixShell) EchoCommand(text string) []string {
	return []string{s.pick(), "-c", "echo " + text}
}

func (s posixShell) Shell(binDir string) ShellSpec {
	path := s.pick()
	spec := ShellSpec{
		Path: path,
		// 로그인 셸로 띄운다 — 사용자의 PATH·rc 가 종전대로 적용된다.
		Args: []string{"-l"},
		Env: []string{
			"LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8",
			// macOS /etc/zshrc_Apple_Terminal 은 상속된 TERM_SESSION_ID 로 세션
			// 저장/복원을 켠다. 모든 도구가 같은 ID 를 물려받아 같은 .session
			// 파일을 지우려 들면서 rm 오류가 뜬다. 이 변수는 /etc/zshrc 보다
			// 먼저 보여야 하므로 ZDOTDIR/.zshrc 가 아니라 프로세스 환경에서 준다.
			"SHELL_SESSIONS_DISABLE=1",
			"SHELL=" + path,
		},
	}
	for _, h := range posixShellHooks {
		if strings.Contains(path, h.match) {
			spec.Env = append(spec.Env, h.env(binDir))
			break
		}
	}
	return spec
}

// pick 은 $SHELL 을 우선하고, 없거나 실재하지 않으면 차선으로 내려간다.
// 종전 toolhub.StartTool 의 규칙과 같다.
func (s posixShell) pick() string {
	if v := s.env("SHELL"); v != "" && s.stat(v) == nil {
		return v
	}
	for _, c := range posixShellFallbacks {
		if s.stat(c) == nil {
			return c
		}
	}
	return posixShellFallbacks[len(posixShellFallbacks)-1]
}

// ── windows ──────────────────────────────────────────

// PowerShellHookFile 은 Windows 훅 스크립트의 파일명이다.
const PowerShellHookFile = "powershell-hook.ps1"

// winShellCandidates 는 찾는 순서다. PowerShell 계열이 먼저인 이유는 훅 때문이다 —
// cmd.exe 에는 프롬프트마다 실행되는 후크 자리가 없다.
var winShellCandidates = []string{"pwsh.exe", "powershell.exe", "cmd.exe"}

type windowsShell struct {
	env  envFn
	look lookFn
}

func (s windowsShell) HookRoot() string { return WindowsHookRoot }

// Quote 는 PowerShell 의 축자 문자열을 만든다. pick() 이 cmd.exe 로 떨어진
// 경우에는 맞지 않지만, 그 경로는 훅도 없는 성능 저하 경로이고(FR-XSH-3)
// cmd.exe 에는 개행을 담을 수 있는 인용 자체가 없다.
func (s windowsShell) Quote(v string) string { return powerShellQuote(v) }

// powerShellQuote 는 v 를 PowerShell 의 홑따옴표 문자열로 감싼다. 그 안에서는
// 변수 전개도 escape 시퀀스도 일어나지 않으며, 홑따옴표 자신만 **겹쳐서**
// 이스케이프한다. 사용자 이름에 아포스트로피가 들어가는 경우가 실제로 있다
// (O'Brien).
func powerShellQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", "''") + "'"
}

// cmd.exe 를 쓰는 이유는 가장 얇기 때문이다. PowerShell 은 시작에 초가 걸려
// 배관 문제와 기동 지연이 섞인다.
func (s windowsShell) EchoCommand(text string) []string {
	comspec := s.env("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	return []string{comspec, "/c", "echo " + text}
}

func (s windowsShell) Shell(binDir string) ShellSpec {
	path := s.pick()
	spec := ShellSpec{Path: path}
	// cmd.exe 로 떨어지면 훅이 없다. cwd 추적과 에이전트 래퍼가 동작하지
	// 않지만 셸 자체는 정상이다 — 성능 저하이지 오류가 아니다 (FR-XSH-3).
	if !strings.Contains(strings.ToLower(filepath.Base(path)), "powershell") &&
		!strings.Contains(strings.ToLower(filepath.Base(path)), "pwsh") {
		return spec
	}
	spec.Args = []string{
		"-NoLogo", "-NoExit",
		"-ExecutionPolicy", "Bypass",
		"-Command", dotSource(filepath.Join(binDir, PowerShellHookFile)),
	}
	return spec
}

// dotSource 는 스크립트를 **현재 세션 스코프로** 읽어들이는 명령을 만든다.
//
// -File 을 쓰지 않는 이유는 대화형 유지가 불확실해서다. -NoExit 이 -File 과
// 함께일 때 대화형 프롬프트로 남는지가 PowerShell 판본에 따라 다르고, 남지
// 않으면 셸이 훅만 실행하고 곧바로 죽는다 — 도구가 뜨자마자 사라진다.
// -NoExit 과 -Command 의 조합에는 그 모호함이 없다.
//
// 닷소싱이라 훅이 정의한 함수가 세션에 그대로 남는 것도 이점이다.
func dotSource(path string) string {
	return ". " + powerShellQuote(path)
}

func (s windowsShell) pick() string {
	// 사용자가 정한 셸이 있으면 그것이 우선이다.
	if v := s.env("DONGMINAL_SHELL"); v != "" {
		return v
	}
	for _, c := range winShellCandidates {
		if path, err := s.look(c); err == nil {
			return path
		}
	}
	// 아무것도 못 찾아도 cmd.exe 는 PATH 해석에 맡겨 시도해 본다.
	return "cmd.exe"
}
