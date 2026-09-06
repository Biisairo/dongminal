package ext

import (
	"os"
	"os/exec"
	"path/filepath"

	"dongminal/internal/shared/platform"
)

// 격리 칸의 배치다 (FR-EXT-20). **이 셋 밖에는 아무것도 쓰지 않는다** — 그것이
// "지우면 원상복구" 의 뜻이고 이 작업의 완료 판정이다 (FR-EXT-22).
const (
	pluginsSub  = "plugins"
	runtimesSub = "runtimes"
	cacheSub    = "cache"
)

// DirName 은 데이터 디렉터리 아래 격리 칸의 이름이다.
//
// 배선이 이 문자열을 따로 적으면 두 자리가 되고, 한쪽만 고쳐졌을 때 탐색기가 보는
// 곳과 조달이 쓰는 곳이 갈린다.
const DirName = "ext"

// RootIn 은 데이터 디렉터리 아래 격리 칸이다.
func RootIn(dataDir string) string { return filepath.Join(dataDir, DirName) }

// PluginsDir·PluginDir 은 팩이 사는 자리다.
func PluginsDir(root string) string { return filepath.Join(root, pluginsSub) }

// PluginDir 은 팩 하나의 자리다. **id 가 디렉터리 이름이 되므로** 그 값이 경로 한
// 칸이어야 한다 (validSegment / FR-EXT-39).
func PluginDir(root, id string) string { return filepath.Join(PluginsDir(root), id) }

// RuntimesDir 은 런타임들이 사는 자리다.
func RuntimesDir(root string) string { return filepath.Join(root, runtimesSub) }

// RuntimeDir 은 런타임 하나의 자리이며 **판과 타깃이 이름에 박힌다** (FR-EXT-24).
//
// 고정 이름을 쓰면 새 판을 받은 뒤에도 옛 파일이 남아 섞이고, 그 불일치는 오류가
// 아니라 조용한 오동작으로 나타난다 (§2.5 ①).
func RuntimeDir(root string, m Manifest) string {
	return filepath.Join(RuntimesDir(root), m.ID+"-"+m.Version+"-"+CurrentTarget())
}

// CacheDir 은 조달·실행이 쓰는 캐시의 자리다 (FR-EXT-21). 사용자 홈이 아니라
// 여기를 가리켜야 §2.1 의 889 MB 가 남의 기계에 쌓이지 않는다.
func CacheDir(root string) string { return filepath.Join(root, cacheSub) }

// Origin 은 실행 파일을 **어디서 찾았는지**다 (FR-EXT-28).
type Origin string

const (
	// OriginConfig 는 사용자가 설정에 적은 절대경로다 (①).
	OriginConfig Origin = "config"
	// OriginPath 는 PATH 다 (②). **격리되지 않은 갈래다.**
	OriginPath Origin = "path"
	// OriginManaged 는 격리 칸의 조달물이다 (③).
	OriginManaged Origin = "managed"
)

// MissingKind 는 **무엇이 없어서** 서지 못하는가다 (FR-EXT-29).
//
// 셋을 가르는 이유는 사용자가 할 일이 각각 다르기 때문이다 — 런타임을 받아야
// 하는가, 호스트에 도구를 깔아야 하는가, 그냥 버튼을 누르면 되는가.
type MissingKind string

const (
	// MissingRuntime 은 `needs` 의 런타임이 없다.
	MissingRuntime MissingKind = "runtime"
	// MissingTool 은 toolchain 조달의 호스트 도구가 없다 (gopls 의 갈래).
	MissingTool MissingKind = "tool"
	// MissingTarget 은 이 플랫폼의 조달처가 선언에 없다.
	MissingTarget MissingKind = "target"
	// MissingNotFetched 는 아무것도 막지 않는데 아직 받지 않았다는 뜻이다.
	MissingNotFetched MissingKind = "not-fetched"
)

// Missing 은 없는 것을 **이름과 함께** 말한다 (FR-EXT-29 / FR-LSP-11 의 규약).
//
// "설치 실패" 는 사용자가 다음에 할 일을 알려주지 않지만 "node 가 없다" 는 알려준다.
type Missing struct {
	Kind MissingKind `json:"kind"`
	Name string      `json:"name,omitempty"`
}

// Status 는 서버 하나에 대한 **관측**이다 (FR-EXT-33).
//
// 캐시가 아니라 관측인 것이 규칙이다 — 사용자가 격리 칸을 지우면 다음 조회가 다시
// "없음" 을 내야 한다.
type Status struct {
	// Pack 은 이 서버를 낸 팩이다. 조달의 단위가 그것이므로 화면의 버튼도
	// 팩마다 하나다 (FR-EXT-5·31).
	Pack string `json:"pack"`
	ID   string `json:"id"`

	Langs []string `json:"langs,omitempty"`
	Exts  []string `json:"exts,omitempty"`

	Found  bool   `json:"found"`
	Exe    string `json:"exe,omitempty"`
	Origin Origin `json:"origin,omitempty"`

	// Isolated 는 이것이 **우리 칸 안의 것인가**다 (FR-EXT-28).
	//
	// 사용자가 PATH 의 자기 서버를 쓰는 것은 정당하지만, 그것이 우리 격리의
	// 예외라는 사실까지 조용하면 "격리했다" 는 말이 거짓이 된다.
	Isolated bool `json:"isolated"`

	Needs   []string `json:"needs,omitempty"`
	Missing *Missing `json:"missing,omitempty"`
	// Note 는 Missing 을 사람의 말로 옮긴 것이다 (FR-EXT-29).
	//
	// 서버가 채우는 이유는 옮기는 자리가 **하나여야** 하기 때문이다 — 화면이 따로
	// 적으면 서버가 아는 사유와 사용자가 읽는 문장이 갈린다.
	Note string `json:"note,omitempty"`

	// CanInstall 은 지금 조달을 시도할 수 있는가다.
	CanInstall bool `json:"canInstall"`
	Installing bool `json:"installing,omitempty"`
}

// Locator 는 실행 파일을 찾는다.
//
// PATH 와 파일시스템을 **주입받는다** — 실제 PATH 에 의존하면 검사가 기계마다 다른
// 답을 낸다.
type Locator struct {
	// Root 는 격리 칸이다 (`<데이터>/ext`).
	Root string
	// LookPath 는 보통 exec.LookPath 다.
	LookPath func(string) (string, error)
	// Overrides 는 사용자가 설정에 적은 절대경로다 (서버 id → 경로).
	//
	// 화면이 실어 보낸다 (FR-LSP-4b) — 설정 블롭을 서버가 해석하지 않으므로
	// 서버가 그것을 읽을 자리가 없다.
	Overrides map[string]string
	// Runtimes 는 이 기계가 아는 런타임 팩들이다. `needs` 판정이 이것을 딛는다.
	Runtimes []Manifest
	// Target 이 비면 이 빌드의 타깃을 쓴다. 검사가 다른 플랫폼을 재는 자리다.
	Target string
}

// NewLocator 는 실제 PATH 를 쓰는 Locator 다.
func NewLocator(root string, overrides map[string]string, runtimes []Manifest) *Locator {
	return &Locator{Root: root, LookPath: exec.LookPath, Overrides: overrides, Runtimes: runtimes}
}

func (l *Locator) lookPath() func(string) (string, error) {
	if l.LookPath != nil {
		return l.LookPath
	}
	return exec.LookPath
}

func (l *Locator) target() string {
	if l.Target != "" {
		return l.Target
	}
	return CurrentTarget()
}

// ManagedExe 는 격리 칸에서 이 서버의 실행 파일이 놓일 자리다.
//
// **조달의 성공 판정과 탐색이 이 하나를 함께 쓴다** (FR-EXT-19 / FR-LWP-6). 두 벌로
// 적으면 조달은 성공이라 하고 탐색은 없다고 한다.
//
// 자리가 조달 방법마다 다른 것은 도구의 규약이 다르기 때문이다 — npm 은
// `node_modules/.bin` 에 놓고, `go install` 은 `GOBIN` 을 그대로 쓴다.
func ManagedExe(root string, m Manifest, s Server) string {
	c := managedExeCandidates(root, m, s)
	if len(c) == 0 {
		return ""
	}
	return c[0]
}

// ManagedExeFound 는 후보 중 **실제로 있고 실행할 수 있는 것**이다 (FR-LWP-7).
//
// 후보가 여럿인 이유는 `node_modules/.bin` 이다 — npm 은 그 자리에 OS 마다 다른
// shim 을 함께 놓으며, 한 이름으로 좁히면 받아 두고도 못 찾는다.
func ManagedExeFound(root string, m Manifest, s Server) string {
	for _, p := range managedExeCandidates(root, m, s) {
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

func managedExeCandidates(root string, m Manifest, s Server) []string {
	if root == "" {
		return nil
	}
	dir := PluginDir(root, m.ID)
	suffix := platform.Current().Paths.ExeSuffix()
	switch m.Source.Kind {
	case SourceNPM:
		bin := filepath.Join(dir, "node_modules", ".bin")
		if suffix == "" {
			return []string{filepath.Join(bin, s.Exe)}
		}
		// Windows: `.cmd` 가 셸 없이 실행되는 shim 이다. 확장자 없는 sh 스크립트도
		// 함께 놓이지만 그것은 Windows 가 실행하지 못한다.
		return []string{filepath.Join(bin, s.Exe+".cmd")}
	case SourceToolchain:
		return []string{filepath.Join(ManagedBinDir(root, m), s.Exe+suffix)}
	case SourceArchive:
		// 아카이브는 **선언이 자리를 정한다** — 안의 배치를 우리가 알 길이 없다.
		if p := archiveExe(root, m, s, CurrentTarget()); p != "" {
			return []string{p}
		}
		return nil
	}
	return nil
}

// archiveExe 는 archive 팩에서 이 서버의 실행 파일 자리다.
//
// 선언의 `bin` 이 **파일**을 가리키면 그것이고, **디렉터리**면 그 아래의 `exe` 다.
// 팩 하나가 서버 여럿을 낼 수 있으므로(FR-EXT-5) 한 경로로 좁힐 수 없다.
func archiveExe(root string, m Manifest, s Server, target string) string {
	t, ok := m.Source.Targets[target]
	if !ok || t.Bin == "" {
		return ""
	}
	suffix := platform.Current().Paths.ExeSuffix()
	p := filepath.Join(PluginDir(root, m.ID), filepath.FromSlash(t.Bin))
	if base := filepath.Base(p); base == s.Exe || base == s.Exe+suffix {
		return p
	}
	return filepath.Join(p, s.Exe+suffix)
}

// Locate 는 FR-EXT-27 의 순서로 찾는다: ①설정 ②PATH ③격리 칸.
//
// 먼저 찾은 것을 쓰고, **어디서 찾았는지와 그것이 격리된 것인지**를 함께 낸다.
func (l *Locator) Locate(m Manifest, s Server) Status {
	st := Status{Pack: m.ID, ID: s.ID, Langs: s.Langs, Exts: s.Exts, Needs: m.Needs}
	look := l.lookPath()

	// ① 사용자가 적은 절대경로. 적었다는 것 자체가 의사표시이므로 가장 앞이다.
	if p := l.Overrides[s.ID]; p != "" && isExecutable(p) {
		st.Found, st.Exe, st.Origin = true, p, OriginConfig
	}
	// ② PATH. 사용자가 이미 자기 방식으로 깔아 둔 것을 우리 것보다 앞세운다.
	if !st.Found {
		if p, err := look(s.Exe); err == nil && p != "" {
			st.Found, st.Exe, st.Origin = true, p, OriginPath
		}
	}
	// ③ 격리 칸 — 우리가 받아 둔 것.
	if !st.Found {
		p := ManagedExeFound(l.Root, m, s)
		if p != "" {
			st.Found, st.Exe, st.Origin = true, p, OriginManaged
		}
	}

	st.Isolated = st.Origin == OriginManaged
	st.CanInstall, st.Missing = l.readiness(m)
	// 찾았으면 "없는 것" 을 말하지 않는다 — 이미 서 있는 서버에 대해 무엇이
	// 없다고 하면 그 말이 곧 고장으로 읽힌다.
	if st.Found {
		st.Missing = nil
	}
	return st
}

// readiness 는 지금 조달할 수 있는가와, 없다면 무엇이 없는가다.
//
// 판정이 팩 단위인 것은 조달이 팩 단위이기 때문이다 (FR-EXT-5).
func (l *Locator) readiness(m Manifest) (canInstall bool, missing *Missing) {
	look := l.lookPath()

	// FR-EXT-7: 런타임이 먼저다. 없으면 그 이름으로 말한다.
	for _, need := range m.Needs {
		if !l.runtimeReady(need) {
			return false, &Missing{Kind: MissingRuntime, Name: need}
		}
	}

	switch m.Source.Kind {
	case SourceToolchain:
		// FR-EXT-14: 호스트 도구가 없으면 조달하지 않는다. gopls 가 이 갈래이며
		// prebuilt 가 어디에도 없기 때문이다 (§2.3).
		if _, err := look(m.Source.Tool); err != nil {
			return false, &Missing{Kind: MissingTool, Name: m.Source.Tool}
		}
	case SourceArchive:
		if _, ok := m.Source.Targets[l.target()]; !ok {
			return false, &Missing{Kind: MissingTarget, Name: l.target()}
		}
	}
	return true, &Missing{Kind: MissingNotFetched}
}

// runtimeReady 는 그 런타임을 지금 쓸 수 있는가다.
//
// **호스트의 것을 먼저 본다** — 대개의 개발 기계에는 이미 있고, 있는 것을 두고 또
// 받으면 그것이 곧 "컴퓨터를 건드리는" 일이 된다 (FR-EXT-7b 의 lazy 와 같은 근거).
func (l *Locator) runtimeReady(id string) bool {
	return runtimeReadyIn(l.Root, l.lookPath(), l.Runtimes, id, l.target())
}

// runtimeReadyIn 은 탐색과 조달이 **함께 쓰는** 판정이다.
//
// 두 벌로 두면 조달은 "런타임이 없다" 며 받고 탐색은 "있다" 고 하거나 그 반대가
// 된다 — FR-EXT-19 가 실행 파일에 대해 말하는 것과 같은 이유다.
func runtimeReadyIn(root string, look func(string) (string, error), rts []Manifest, id, target string) bool {
	if look != nil {
		if _, err := look(id); err == nil {
			return true
		}
	}
	for _, rt := range rts {
		if rt.ID != id || rt.Kind != KindRuntime {
			continue
		}
		// 런타임 자신은 실행 가능해야 한다 — 그것으로 하위 도구를 부른다.
		if p := RuntimeExe(root, rt, id, target); p != "" && isExecutable(p) {
			return true
		}
	}
	return false
}

// RuntimeExe 는 격리 칸에 받아 둔 런타임이 내는 것 하나의 자리다 (FR-EXT-6).
//
// 이름 → 상대경로가 **타깃마다 다르다** (FR-EXT-13) — npm 이 POSIX 와 Windows 에서
// 다른 자리에 있다. 그 차이는 여기 코드가 아니라 매니페스트가 안다.
func (l *Locator) RuntimeExe(rt Manifest, name string) string {
	return RuntimeExe(l.Root, rt, name, l.target())
}

// RuntimeExe 는 격리 칸에 받아 둔 런타임이 내는 것 하나의 자리다.
//
// **실행 비트를 보지 않는다.** 런타임이 내는 것이 전부 실행 파일인 것은 아니다 —
// npm 은 `npm-cli.js` 이며 node 가 그것을 실행한다 (§2.8). 여기서 실행 비트를
// 요구하면 정상적으로 받아 둔 런타임이 "없다" 가 된다.
//
// 실행 가능해야 하는 것은 런타임 **자신**이며, 그 판정은 runtimeReadyIn 이 한다.
func RuntimeExe(root string, rt Manifest, name, target string) string {
	t, ok := rt.Source.Targets[target]
	if !ok {
		return ""
	}
	rel, ok := t.Provides[name]
	if !ok {
		return ""
	}
	p := filepath.Join(RuntimeDir(root, rt), filepath.FromSlash(rel))
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// isExecutable 은 **실행할 수 있는 보통 파일**인가다.
//
// 존재만 보지 않는 이유는 실패의 모양이다 — 실행할 수 없는 동명 파일을 서버로
// 삼으면 기동이 permission denied 로 죽고, 그 실패는 "없다" 가 아니라 "우리 버그"
// 로 보인다.
//
// **판정은 `platform` 이 갖는다** (FR-EXT-41 / FR-LWP-1). POSIX 는 실행 비트이고
// Windows 는 확장자다 — Go 가 Windows 의 보통 파일에 0666 을 주므로 실행 비트를
// 보면 거기서는 언제나 거짓이 된다.
func isExecutable(path string) bool {
	return platform.Current().Paths.IsExecutable(path)
}
