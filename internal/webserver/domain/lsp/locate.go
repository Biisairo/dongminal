package lsp

import (
	"os/exec"
	"path/filepath"
)

// Status 는 한 서술자에 대한 **관측**이다 (FR-LSP-5·6·47).
//
// 캐시가 아니라 관측인 것이 규칙이다 — 전용 디렉터리의 파일을 지우면 다음 조회가
// 다시 "없음" 을 내야 한다. 캐시로 두면 사용자가 지운 것을 우리가 있다고 우긴다.
type Status struct {
	// ID 는 서술자의 식별자다.
	ID string `json:"id"`
	// Langs 는 이것이 덮는 Monaco language id 들이다.
	Langs []string `json:"langs"`
	// Exts 는 대응 확장자다.
	//
	// 상태에 싣는 이유는 FR-LSP-44 다 — 파일을 열 때 "이 파일의 서버가 있는가" 를
	// 화면이 판정해야 하는데, 확장자 표를 화면이 따로 적으면 서버의 서술자와
	// 어긋나 그 언어에서 제안이 뜨지 않거나 엉뚱한 것이 뜬다.
	Exts []string `json:"exts"`
	// Found 와 Exe·Origin 은 짝이다 — 못 찾았으면 뒤의 둘은 비어 있다.
	Found  bool   `json:"found"`
	Exe    string `json:"exe,omitempty"`
	Origin Origin `json:"origin,omitempty"`
	// Installer 는 받는 데 쓸 도구 이름이다. **못 찾았을 때도 실린다** —
	// 무엇이 없는지를 이름으로 알리는 자리다 (FR-LSP-11).
	Installer string `json:"installer,omitempty"`
	// CanInstall 은 그 도구가 이 기계에 있는가다 (FR-LSP-6).
	CanInstall bool `json:"canInstall"`
	// Installing 은 지금 받고 있는가다 (FR-LSP-48). 화면의 비활성만으로는 다른
	// 탭·다른 기기에서 누른 두 번째 설치를 막지 못하므로 서버가 알린다.
	Installing bool `json:"installing,omitempty"`
}

// Locator 는 실행 파일을 찾는다.
//
// PATH 와 파일시스템을 **주입받는다** — 실제 PATH 에 의존하면 검사가 기계마다
// 다른 답을 낸다.
type Locator struct {
	// LookPath 는 보통 exec.LookPath 다.
	LookPath func(string) (string, error)
	// ManagedDir 은 전용 디렉터리다 (`<홈>/lsp`).
	//
	// bin 이 아니라 그 위를 받는 이유는 FR-LSP-7b 다 — 안의 자리가 도구마다
	// 다르다. `ManagedExe` 가 서술자마다 그 자리를 정한다.
	ManagedDir string
	// Overrides 는 사용자가 설정에 적은 절대경로다 (서술자 ID → 경로).
	Overrides map[string]string
}

// NewLocator 는 실제 PATH 와 주어진 전용 디렉터리를 쓰는 Locator 다.
func NewLocator(managedDir string, overrides map[string]string) *Locator {
	return &Locator{LookPath: exec.LookPath, ManagedDir: managedDir, Overrides: overrides}
}

// ManagedExe 는 전용 디렉터리에서 이 서술자의 실행 파일이 놓일 자리다 (FR-LSP-7b).
//
// `go install` 은 `GOBIN` 을 그대로 쓰므로 `<lsp>/bin/<exe>` 이고, `npm --prefix`
// 는 자기 규약대로 `<lsp>/node_modules/.bin/<exe>` 에 놓는다. 설치와 탐색이 **같은
// 함수**로 그 자리를 얻어야 한다 — 두 벌로 적으면 받아 두고도 못 찾는다.
func ManagedExe(managedDir string, d Descriptor) string {
	if managedDir == "" {
		return ""
	}
	switch d.Installer.Tool {
	case "npm":
		return filepath.Join(managedDir, "node_modules", ".bin", d.Exe)
	default:
		return filepath.Join(managedDir, "bin", d.Exe)
	}
}

// Locate 는 FR-LSP-4 의 순서로 찾는다: ①설정 ②PATH ③전용 디렉터리.
//
// 먼저 찾은 것을 쓰고, **어디서 찾았는지를 함께 낸다** (FR-LSP-5).
func (l *Locator) Locate(d Descriptor) Status {
	st := Status{ID: d.ID, Langs: d.Langs, Exts: d.Exts, Installer: d.Installer.Tool}

	// ① 사용자가 적은 절대경로. 적었다는 것 자체가 의사표시이므로 가장 앞이다.
	if p := l.Overrides[d.ID]; p != "" && l.executable(p) {
		st.Found, st.Exe, st.Origin = true, p, OriginConfig
	}
	// ② PATH. 사용자가 이미 자기 방식으로 깔아 둔 것을 우리 것보다 앞세운다.
	if !st.Found && l.LookPath != nil {
		if p, err := l.LookPath(d.Exe); err == nil && p != "" {
			st.Found, st.Exe, st.Origin = true, p, OriginPath
		}
	}
	// ③ 전용 디렉터리 — 우리가 받아 둔 것. 자리는 도구가 정한다 (FR-LSP-7b).
	if !st.Found {
		if p := ManagedExe(l.ManagedDir, d); p != "" && l.executable(p) {
			st.Found, st.Exe, st.Origin = true, p, OriginManaged
		}
	}

	// 받을 수 있는지는 **찾았든 못 찾았든** 같은 질문이다 — 설정창이 이미 있는
	// 서버를 다시 받는 길도 보여야 한다.
	if d.Installer.Tool != "" && l.LookPath != nil {
		if _, err := l.LookPath(d.Installer.Tool); err == nil {
			st.CanInstall = true
		}
	}
	return st
}

// executable 은 그 경로가 **실행할 수 있는 보통 파일**인가다.
//
// 존재만 보지 않는 이유는 실패의 모양이다 — 실행 권한 없는 같은 이름의 파일을
// 서버로 삼으면 기동이 permission denied 로 죽고, 그 실패는 "서버가 없다" 가
// 아니라 "우리 버그" 로 보인다.
//
// 판정은 `isExecutable` 한 벌이다 (install.go) — 설치가 "놓였는가" 를 재는 규칙과
// 탐색이 "있는가" 를 재는 규칙이 갈리면, 설치는 성공이라 하고 탐색은 없다고 한다.
func (l *Locator) executable(path string) bool {
	return isExecutable(path)
}
