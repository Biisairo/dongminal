package platform

import (
	"errors"
	"io"
	"path"
	"path/filepath"
)

// Chrome 은 브라우저 탭의 엔진(서버 기기의 Google Chrome)을 다루는 능력이다
// (BROWSER_TAB_SRS FR-BRT-1·5).
//
// `Browser`(`dongminal window` 의 frameless 창)와 **다른 능력**이다. 그쪽 체인은
// Edge·chromium·기본 브라우저로 물러서지만 이쪽은 Chrome 만 찾는다 (D-BRT-1). 두
// 체인을 하나로 합치면 한쪽의 물러섬이 다른 쪽으로 샌다.
type Chrome interface {
	// Find 는 Chrome 실행 파일의 경로다. 없으면 ErrChromeNotFound 다.
	Find() (string, error)
	// InstallHint 는 이 OS 에서 Chrome 을 설치하는 안내 한 줄이다 (FR-BRT-2).
	InstallHint() string
	// StartPiped 는 fd 3(자식이 읽음)·fd 4(자식이 씀)를 pipe 로 이어 띄운다
	// (FR-BRT-5). 자식과 그 자손 전체가 한 묶음이며, Kill 이 묶음을 끝낸다.
	StartPiped(spec PipedSpec) (*PipedProcess, error)
	// ModIsMeta 는 이 OS 의 편집 단축키가 ⌘(Meta)인가다 — macOS 만 참이다
	// (FR-BRT-54). 뷰어의 Mod 를 서버 OS 쪽으로 바꿀 때 쓴다.
	ModIsMeta() bool
}

// ErrChromeNotFound 는 Chrome 을 찾지 못했다는 뜻이다. 다른 브라우저로 대체하지
// 않는다 (FR-BRT-2).
var ErrChromeNotFound = errors.New("Google Chrome 을 찾지 못했습니다")

// PipedSpec 은 pipe 로 띄울 자식이다.
type PipedSpec struct {
	Path string
	Args []string
	// Env 가 nil 이면 부모의 환경을 물려준다.
	Env []string
	// Stderr 가 nil 이면 버린다.
	Stderr io.Writer
}

// PipedProcess 는 pipe 로 띄운 자식이다. ToChild 에 쓰면 자식의 fd 3 으로,
// 자식이 fd 4 에 쓴 것은 FromChild 에서 읽힌다.
type PipedProcess struct {
	ToChild   io.WriteCloser
	FromChild io.ReadCloser
	Pid       int
	wait      func() error
	kill      func() error
}

// NewPipedProcess 는 pipe 두 끝과 수명 함수로 PipedProcess 를 만든다 — 실제 Chrome 대신
// 가짜 피어를 세우는 시험이 쓴다 (BROWSER_TAB_SRS TC-BRT-3).
func NewPipedProcess(toChild io.WriteCloser, fromChild io.ReadCloser, pid int, wait, kill func() error) *PipedProcess {
	return &PipedProcess{ToChild: toChild, FromChild: fromChild, Pid: pid, wait: wait, kill: kill}
}

// Wait 는 자식이 끝날 때까지 기다린다.
func (p *PipedProcess) Wait() error { return p.wait() }

// Kill 은 자식과 그 자손 전체를 끝낸다. 여러 번 불려도 안전하다.
func (p *PipedProcess) Kill() error { return p.kill() }

// chromeFinder 는 Chrome 을 찾는 순서 한 벌이다. OS 마다 순서만 다르다 — 조립을
// build tag 없는 곳에 두어 세 체인 전부를 어느 호스트에서도 시험한다 (TC-BRT-1).
type chromeFinder struct {
	look  lookFn
	env   envFn
	stat  statFn
	names []string // PATH 에서 찾는 이름
	// installs 는 환경변수 아래의 표준 설치 자리다.
	installs []installCandidate
	// fixed 는 절대 경로 후보다.
	fixed []string
	hint  string
}

func (f chromeFinder) find() (string, error) {
	for _, n := range f.names {
		if p, err := f.look(n); err == nil {
			return p, nil
		}
	}
	for _, c := range f.installs {
		base := f.env(c.env)
		if base == "" {
			continue
		}
		if p := filepath.Join(base, c.rel); f.stat(p) == nil {
			return p, nil
		}
	}
	for _, p := range f.fixed {
		if f.stat(p) == nil {
			return p, nil
		}
	}
	return "", ErrChromeNotFound
}

const (
	chromeDownloadURL = "https://www.google.com/chrome/"
	macChromeRel      = "Google Chrome.app/Contents/MacOS/Google Chrome"
)

// macChromeFinder 는 macOS 의 순서다 — 시스템 Applications, 그 다음 사용자의 것.
func macChromeFinder(env envFn, stat statFn) chromeFinder {
	fixed := []string{"/Applications/" + macChromeRel}
	if userDir := env("HOME"); userDir != "" {
		// macOS 경로는 POSIX 다 — 시험이 어느 호스트에서 돌아도 같은 문자열이다 (TC-BRT-1).
		fixed = append(fixed, path.Join(userDir, "Applications", macChromeRel))
	}
	return chromeFinder{look: noLook, env: env, stat: stat, fixed: fixed,
		hint: "Google Chrome 을 설치하세요: " + chromeDownloadURL}
}

// linuxChromeFinder 는 리눅스의 순서다. 배포판 chromium 은 찾지 않는다 (D-BRT-1).
func linuxChromeFinder(look lookFn) chromeFinder {
	return chromeFinder{look: look, env: noEnvFn, stat: noStat,
		names: []string{"google-chrome", "google-chrome-stable"},
		hint:  "Google Chrome 을 설치하세요 (google-chrome-stable 패키지): " + chromeDownloadURL}
}

// winChromeFinder 는 Windows 의 순서다. Edge 는 찾지 않는다 (D-BRT-1).
func winChromeFinder(look lookFn, env envFn, stat statFn) chromeFinder {
	return chromeFinder{look: look, env: env, stat: stat,
		names: []string{"chrome.exe"},
		installs: []installCandidate{
			{"ProgramFiles", chromeRelPath},
			{"ProgramFiles(x86)", chromeRelPath},
			{"LOCALAPPDATA", chromeRelPath},
		},
		hint: "Google Chrome 을 설치하세요: " + chromeDownloadURL}
}

func noLook(string) (string, error) { return "", ErrChromeNotFound }
func noEnvFn(string) string         { return "" }
func noStat(string) error           { return ErrChromeNotFound }

// chromeEngine 은 탐색 체인과 기동 방식을 묶는다.
type chromeEngine struct {
	finder  chromeFinder
	start   func(PipedSpec) (*PipedProcess, error)
	modMeta bool
}

func (c chromeEngine) Find() (string, error)                         { return c.finder.find() }
func (c chromeEngine) InstallHint() string                           { return c.finder.hint }
func (c chromeEngine) StartPiped(s PipedSpec) (*PipedProcess, error) { return c.start(s) }
func (c chromeEngine) ModIsMeta() bool                               { return c.modMeta }
