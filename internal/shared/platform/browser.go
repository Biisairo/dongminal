package platform

import (
	"errors"
	"path/filepath"
)

// Browser 는 frameless window(주소창 없는 앱 창)를 여는 명령을 조립한다
// (FR-XBR-1). 실행은 호출자가 한다 — 이 인터페이스는 명령만 낸다.
type Browser interface {
	FramelessCommand(url string) (name string, args []string, err error)
}

// launcher 는 브라우저를 여는 **한 가지 방법**이다.
//
// 핵심은 `ok` 다 — launcher 는 자기가 이 환경에서 쓸 수 있는지를 **스스로**
// 판정한다. 그래서 이 파일에는 "여기가 WSL 인가", "여기가 리눅스인가" 를 묻는
// 코드가 없다. `wslview` 는 WSL 에만 있으므로 평범한 리눅스에서는 스스로
// 빠지고, Chrome 이 깔린 WSL 에서는 크로미움이 먼저 답한다.
//
// 이것이 이 패키지가 OS 분기를 하나도 갖지 않는 방식이다 (FR-XPL-3).
type launcher interface {
	command(url string) (name string, args []string, ok bool)
}

// browserChain 은 launcher 들에게 순서대로 물어본다. 먼저 답하는 것이 이긴다.
// 순서가 곧 선호도다.
type browserChain struct {
	chain []launcher
	// hint 는 아무도 답하지 못했을 때 사용자에게 줄 안내다. 어떤 수단을
	// 기대했는지는 체인을 조립한 쪽만 알기에 함께 들고 있는다.
	hint string
}

func (b browserChain) FramelessCommand(url string) (string, []string, error) {
	for _, l := range b.chain {
		if name, args, ok := l.command(url); ok {
			return name, args, nil
		}
	}
	return "", nil, errors.New(b.hint)
}

// appArgs 는 크로미움 계열에 frameless window 를 요구하는 인자다.
func appArgs(url string) []string { return []string{"--app=" + url} }

// ── launcher 구현 4종 ────────────────────────────────

// pathLauncher 는 PATH 에서 이름들을 차례로 찾아 먼저 있는 것을 쓴다.
// 찾지 못하면 답하지 않는다.
type pathLauncher struct {
	look  lookFn
	names []string
	args  func(url string) []string
}

func (l pathLauncher) command(url string) (string, []string, bool) {
	for _, n := range l.names {
		if path, err := l.look(n); err == nil {
			return path, l.args(url), true
		}
	}
	return "", nil, false
}

// installLauncher 는 PATH 에 없는 표준 설치 자리를 훑는다. 크로미움 계열은
// 설치 관리자가 PATH 를 건드리지 않는 경우가 흔하다.
type installLauncher struct {
	env        envFn
	stat       statFn
	candidates []installCandidate
	args       func(url string) []string
}

type installCandidate struct{ env, rel string }

func (l installLauncher) command(url string) (string, []string, bool) {
	for _, c := range l.candidates {
		base := l.env(c.env)
		// 빈 환경변수를 Join 하면 상대 경로가 되어 엉뚱한 파일을 가리킨다.
		if base == "" {
			continue
		}
		path := filepath.Join(base, c.rel)
		if l.stat(path) == nil {
			return path, l.args(url), true
		}
	}
	return "", nil, false
}

// fixedLauncher 는 조건 없이 같은 명령을 낸다. **그 명령이 그 플랫폼에 반드시
// 있는 경우에만** 체인에 넣는다 (macOS 의 `open`, Windows 의 `rundll32`).
// 항상 답하므로 체인의 마지막이어야 한다.
type fixedLauncher struct {
	name string
	args func(url string) []string
}

func (l fixedLauncher) command(url string) (string, []string, bool) {
	return l.name, l.args(url), true
}

// ── 체인 구성 요소 ───────────────────────────────────

// chromiumNames 는 리눅스에서 찾는 크로미움 계열이다. 종전
// scripts/open_frameless_window.sh 와 순서가 같다.
var chromiumNames = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"}

// winChromiumNames 는 Windows 의 PATH 에서 찾는 이름이다. Edge 는 모든
// Windows 10+ 에 있다.
var winChromiumNames = []string{"chrome.exe", "msedge.exe"}

const (
	chromeRelPath = `Google\Chrome\Application\chrome.exe`
	edgeRelPath   = `Microsoft\Edge\Application\msedge.exe`
)

// winInstallCandidates 는 Windows 의 표준 설치 자리다.
var winInstallCandidates = []installCandidate{
	{"ProgramFiles", chromeRelPath},
	{"ProgramFiles(x86)", chromeRelPath},
	{"LOCALAPPDATA", chromeRelPath},
	{"ProgramFiles(x86)", edgeRelPath},
	{"ProgramFiles", edgeRelPath},
}

// chromiumOnPath 는 PATH 의 크로미움 계열에 --app 을 주는 launcher 다.
func chromiumOnPath(look lookFn, names []string) launcher {
	return pathLauncher{look: look, names: names, args: appArgs}
}

// hostOpeners 는 리눅스에서 **호스트 Windows** 로 URL 을 넘기는 수단들이다.
// WSL 밖에서는 둘 다 PATH 에 없으므로 스스로 빠진다 — 그래서 WSL 인지 묻는
// 코드가 필요 없다 (FR-XWS-2).
//
// 이 경로로 열면 frameless window 는 포기한다. wslview 도 Start-Process 도
// 기본 브라우저를 평범한 창으로 열 뿐이다. 창 모양보다 여는 것이 먼저다.
func hostOpeners(look lookFn) []launcher {
	return []launcher{
		pathLauncher{look: look, names: []string{"wslview"},
			args: func(url string) []string { return []string{url} }},
		pathLauncher{look: look, names: []string{"powershell.exe"},
			args: func(url string) []string {
				return []string{"-NoProfile", "-Command", "Start-Process", url}
			}},
	}
}

// macOpen 은 macOS 의 `open` 이다. 앱 번들은 PATH 로 찾지 않으므로 이름으로
// 연다. `open` 은 macOS 에 반드시 있다.
func macOpen(app string) launcher {
	return fixedLauncher{name: "open", args: func(url string) []string {
		return []string{"-na", app, "--args", "--app=" + url}
	}}
}

// winDefaultHandler 는 기본 브라우저에 위임한다. 크로미움을 못 찾았을 때의
// 마지막 수단이며 rundll32 는 모든 Windows 에 있다.
func winDefaultHandler() launcher {
	return fixedLauncher{name: "rundll32", args: func(url string) []string {
		return []string{"url.dll,FileProtocolHandler", url}
	}}
}

// ── 체인 조립 ────────────────────────────────────────
//
// 조립을 build tag 없는 곳에 두는 이유는 검증이다. 세 체인 전부를 어느
// 호스트에서도 테스트할 수 있다 (§4.2). 어느 체인을 쓸지 고르는 것만이
// platform_<goos>.go 의 몫이다.

// macBrowser 는 macOS 의 체인이다. `open` 하나로 끝난다.
func macBrowser() Browser {
	return browserChain{chain: []launcher{macOpen("Google Chrome")}}
}

// unixBrowser 는 리눅스 계열의 체인이다. WSL 을 위한 별도 체인은 없다 —
// 호스트로 넘기는 수단이 뒤에 붙어 있을 뿐이고, 그것들은 WSL 밖에서 스스로
// 빠진다 (hostOpeners 주석).
func unixBrowser(look lookFn) Browser {
	chain := []launcher{chromiumOnPath(look, chromiumNames)}
	chain = append(chain, hostOpeners(look)...)
	return browserChain{
		chain: chain,
		hint: "브라우저를 열 수단을 찾지 못했습니다. Chrome 또는 Chromium 을 설치하세요 " +
			"(WSL 이라면 wslu 설치로 호스트 브라우저를 쓸 수 있습니다)",
	}
}

// winBrowser 는 Windows 의 체인이다. 마지막이 기본 브라우저 위임이므로
// 실패하지 않는다 — frameless window 만 포기한다.
func winBrowser(look lookFn, env envFn, stat statFn) Browser {
	return browserChain{chain: []launcher{
		chromiumOnPath(look, winChromiumNames),
		installLauncher{env: env, stat: stat, candidates: winInstallCandidates, args: appArgs},
		winDefaultHandler(),
	}}
}
