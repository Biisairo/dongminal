// Package ext 는 언어 서버가 **플러그인으로 오는** 자리다 (LSP_PLUGIN_SRS).
//
// **여기에 서버 목록이 없다** (FR-EXT-1). 매니페스트가 유일한 출처이며, 이 패키지의
// Go 코드에 서버 이름·패키지 이름·URL 이 문자열로 나타나면 그것은 이 요구의
// 위반이다. 우리는 선언을 읽어 집행하는 쪽이지 무엇이 있는지 아는 쪽이 아니다
// (D-P2).
//
// 이름이 `plugin` 이 아니라 `ext` 인 것은 저장소에 이미 "플러그인" 이 있기
// 때문이다 — `runtime.AgentPluginDir` 의 Claude Code 플러그인이며 다른 계층이다
// (§1.3).
package ext

import (
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/platform"
)

// ManifestName 은 팩 디렉터리 안에서 선언이 사는 파일 이름이다.
const ManifestName = "plugin.json"

// Kind 는 팩이 무엇을 내는가다 (FR-EXT-3).
type Kind string

const (
	// KindServer 는 언어 서버를 내는 팩이다.
	KindServer Kind = "server"
	// KindRuntime 은 서버를 **실행할 것**을 내는 팩이다 (FR-EXT-6). node 가
	// 그것이며, 특례가 아니라 종류 하나다 (D-P3).
	KindRuntime Kind = "runtime"
)

// SourceKind 는 조달 방법이다 (FR-EXT-10).
type SourceKind string

const (
	// SourceArchive 는 타깃별 URL 에서 받아 푸는 것이다.
	SourceArchive SourceKind = "archive"
	// SourceNPM 은 런타임의 npm 으로 받는 것이다. 호스트 npm 을 찾지 않는다
	// (FR-EXT-12).
	SourceNPM SourceKind = "npm"
	// SourceToolchain 은 호스트의 도구로 만드는 것이다. gopls 가 이 갈래이며,
	// prebuilt 가 어디에도 없어 받을 URL 이 없기 때문이다 (§2.3 / D-P4).
	SourceToolchain SourceKind = "toolchain"
)

// Server 는 팩이 내는 언어 서버 하나이며 **세션의 단위**다 (FR-EXT-4).
//
// 단위가 언어가 아닌 것은 종전 규칙 그대로다 (FR-LSP-13) — 하나가 여러 언어를
// 덮으므로, 언어를 단위로 삼으면 같은 프로세스가 둘로 세어져 두 번 기동된다.
type Server struct {
	ID    string   `json:"id"`
	Langs []string `json:"langs"`
	// Exts 는 대응 확장자다. 소문자·점 포함으로 정규화된다 — 화면이 이 표로
	// "이 파일의 서버가 있는가" 를 판정하므로(FR-LSP-44) 표기가 흔들리면 그
	// 언어에서 제안이 뜨지 않는다.
	Exts []string `json:"exts"`
	Exe  string   `json:"exe"`
	Args []string `json:"args,omitempty"`
}

// Target 은 한 플랫폼의 조달처다 (FR-EXT-11).
type Target struct {
	URL string `json:"url"`
	// SHA256 은 받은 것을 **풀기 전에** 대조할 값이다 (FR-EXT-15). 네트워크에서
	// 받은 것을 검증 없이 실행하지 않는다.
	SHA256 string `json:"sha256"`
	// Strip 은 아카이브 안에서 벗겨낼 앞 디렉터리 수다 (node tarball 이 한 겹을
	// 씌운다).
	Strip int `json:"strip,omitempty"`
	// Bin 은 푼 자리 기준의 실행 파일 상대경로다 (server 팩).
	Bin string `json:"bin,omitempty"`
	// Provides 는 이름 → 상대경로다 (runtime 팩). **타깃마다 다르다** — npm 은
	// POSIX 에서 `bin/npm` 이고 Windows 에서 `node_modules/npm/bin/npm-cli.js`
	// 다 (§2.8). 그 차이가 코드가 아니라 여기 있어야 한다 (FR-EXT-13).
	Provides map[string]string `json:"provides,omitempty"`
}

// Source 는 조달 선언이다.
type Source struct {
	Kind SourceKind `json:"kind"`
	// Packages 는 npm 의 패키지 명세들이다. 판이 박혀야 한다 (FR-EXT-37).
	//
	// **여럿인 것이 규칙이다.** 서버 하나가 다른 패키지를 함께 요구하는 일이
	// 있다 — `typescript-language-server` 는 `typescript` 없이는 아무것도 모른다.
	// 그것을 따로 받게 하면 팩 하나가 두 번 조달돼야 한다 (FR-EXT-5 를 어긴다).
	Packages []string `json:"packages,omitempty"`
	// Tool·Args 는 toolchain 의 호스트 도구와 인자다.
	Tool string   `json:"tool,omitempty"`
	Args []string `json:"args,omitempty"`
	// Bin 은 toolchain 산출물이 놓일 팩 안 상대 디렉터리다.
	Bin string `json:"bin,omitempty"`
	// Targets 는 archive 의 타깃별 조달처다.
	Targets map[string]Target `json:"targets,omitempty"`
}

// Manifest 는 팩 하나의 선언이다 (FR-EXT-3).
type Manifest struct {
	ID   string `json:"id"`
	Kind Kind   `json:"kind"`
	// Version 은 이 팩이 고정한 판이다. **런타임에서는 필수**다 — 경로에 박혀야
	// 갱신이 옛 칸을 덮지 않는다 (FR-EXT-24). 판 없는 고정 경로를 쓰면 새 판을
	// 받은 뒤에도 옛것을 계속 쓰고, 그 불일치는 오류가 아니라 조용한 오동작이
	// 된다 (§2.5 ①).
	Version string `json:"version,omitempty"`
	// Needs 는 이 팩이 서기 전에 확보돼야 할 런타임 id 들이다 (FR-EXT-7).
	Needs   []string `json:"needs,omitempty"`
	Source  Source   `json:"source"`
	Servers []Server `json:"servers,omitempty"`
}

// ParseManifest 는 선언 하나를 읽고 **검증까지 한다**.
//
// 읽기와 검증이 한 문인 것이 규칙이다 — 갈라 두면 검증하지 않은 Manifest 가
// 돌아다니고, 그것이 조달에 닿으면 격리 칸 밖에 파일을 쓰는 길이 열린다
// (FR-EXT-39).
func ParseManifest(blob []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(blob, &m); err != nil {
		return Manifest{}, fmt.Errorf("선언을 해석할 수 없습니다: %w", err)
	}
	if err := m.validate(); err != nil {
		return Manifest{}, err
	}
	m.normalize()
	return m, nil
}

func (m Manifest) validate() error {
	if !validSegment(m.ID) {
		return fmt.Errorf("id 가 경로 한 칸이 아닙니다: %q", m.ID)
	}
	switch m.Kind {
	case KindServer:
		if len(m.Servers) == 0 {
			return fmt.Errorf("%s: server 팩이 서버를 하나도 내지 않습니다", m.ID)
		}
		for _, s := range m.Servers {
			if !validSegment(s.ID) {
				return fmt.Errorf("%s: 서버 id 가 온전하지 않습니다: %q", m.ID, s.ID)
			}
			if strings.TrimSpace(s.Exe) == "" {
				return fmt.Errorf("%s/%s: exe 가 없습니다", m.ID, s.ID)
			}
			if strings.ContainsAny(s.Exe, `/\`) {
				return fmt.Errorf("%s/%s: exe 는 이름이지 경로가 아닙니다: %q", m.ID, s.ID, s.Exe)
			}
		}
	case KindRuntime:
		if len(m.Source.Targets) == 0 {
			return fmt.Errorf("%s: runtime 팩에 타깃이 없습니다", m.ID)
		}
		// FR-EXT-24: 판이 경로에 박히므로 없으면 칸을 지을 수 없다.
		if !validSegment(m.Version) {
			return fmt.Errorf("%s: runtime 팩에 version 이 없습니다", m.ID)
		}
	default:
		return fmt.Errorf("%s: 모르는 kind 입니다: %q", m.ID, m.Kind)
	}
	return m.Source.validate(m.ID, m.Kind)
}

func (s Source) validate(id string, kind Kind) error {
	switch s.Kind {
	case SourceNPM:
		if len(s.Packages) == 0 {
			return fmt.Errorf("%s: npm 조달에 packages 가 없습니다", id)
		}
		for _, p := range s.Packages {
			if strings.TrimSpace(p) == "" {
				return fmt.Errorf("%s: 빈 패키지 명세가 있습니다", id)
			}
			// 인자로 그대로 나가므로 옵션으로 읽히는 값을 막는다 (FR-EXT-38).
			if strings.HasPrefix(p, "-") {
				return fmt.Errorf("%s: 패키지 명세가 옵션처럼 보입니다: %q", id, p)
			}
		}
	case SourceToolchain:
		if strings.TrimSpace(s.Tool) == "" || len(s.Args) == 0 {
			return fmt.Errorf("%s: toolchain 조달에 tool·args 가 필요합니다", id)
		}
		if s.Bin != "" {
			if err := safeRel(s.Bin); err != nil {
				return fmt.Errorf("%s: bin 이 격리 칸을 벗어납니다: %w", id, err)
			}
		}
	case SourceArchive:
		if len(s.Targets) == 0 {
			return fmt.Errorf("%s: archive 조달에 타깃이 없습니다", id)
		}
		for name, t := range s.Targets {
			if err := t.validate(); err != nil {
				return fmt.Errorf("%s[%s]: %w", id, name, err)
			}
			if kind == KindRuntime && len(t.Provides) == 0 {
				return fmt.Errorf("%s[%s]: runtime 타깃에 provides 가 없습니다", id, name)
			}
		}
	default:
		return fmt.Errorf("%s: 모르는 조달 방법입니다: %q", id, s.Kind)
	}
	return nil
}

func (t Target) validate() error {
	// FR-EXT-40: https 만 받는다.
	if !strings.HasPrefix(t.URL, "https://") {
		return fmt.Errorf("url 이 https 가 아닙니다: %q", t.URL)
	}
	if !validSHA256(t.SHA256) {
		return fmt.Errorf("sha256 이 64자리 16진수가 아닙니다: %q", t.SHA256)
	}
	if t.Strip < 0 {
		return fmt.Errorf("strip 이 음수입니다: %d", t.Strip)
	}
	if t.Bin != "" {
		if err := safeRel(t.Bin); err != nil {
			return fmt.Errorf("bin: %w", err)
		}
	}
	for name, rel := range t.Provides {
		if err := safeRel(rel); err != nil {
			return fmt.Errorf("provides[%s]: %w", name, err)
		}
	}
	return nil
}

// normalize 는 표기를 하나로 맞춘다. 확장자가 그 대상이다 (FR-EXT-4).
func (m *Manifest) normalize() {
	for i := range m.Servers {
		exts := m.Servers[i].Exts
		for j, e := range exts {
			exts[j] = normalizeExt(e)
		}
	}
}

// normalizeExt 는 확장자의 표기를 하나로 맞춘다 — 소문자, 점 포함.
//
// **선언을 읽을 때와 파일을 풀 때가 같은 함수를 써야 한다.** 두 벌로 적으면 한쪽만
// 고쳐졌을 때 그 언어에서 조용히 서버가 뜨지 않는다.
func normalizeExt(e string) string {
	e = strings.ToLower(strings.TrimSpace(e))
	if e != "" && !strings.HasPrefix(e, ".") {
		e = "." + e
	}
	return e
}

// validSegment 는 경로 한 칸으로 쓸 수 있는 이름인가다.
//
// id 가 디렉터리 이름이 되므로(PluginDir) 구분자나 `..` 이 들어오면 팩 하나가
// 격리 칸 밖을 가리킬 수 있다 (FR-EXT-39).
func validSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, `/\`) {
		return false
	}
	// 제어문자는 이름이 될 수 없다. JSON 은 `\b`·`\t` 같은 이스케이프로 그것을
	// 실어 올 수 있고(검사가 이 자리를 잡았다), Windows 는 그런 이름의 파일을
	// 아예 만들지 못한다 — 그 실패는 조달이 아니라 우리 버그로 보인다.
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// safeRel 은 격리 칸 안에 머무는 상대경로인가다 (FR-EXT-39).
//
// `filepath.IsAbs` 만으로는 모자란다 — Windows 에서 `/usr/bin/node` 는 절대경로가
// 아니라고 답하고, POSIX 에서 `C:\x` 는 보통 이름으로 통과한다. 검사는 두 OS 에서
// 모두 같은 답을 내야 하므로 둘 다 손으로 막는다.
func safeRel(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("비었습니다")
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return fmt.Errorf("절대경로입니다: %q", p)
	}
	if len(p) >= 2 && p[1] == ':' {
		return fmt.Errorf("드라이브 경로입니다: %q", p)
	}
	c := path.Clean(strings.ReplaceAll(p, `\`, "/"))
	if c == ".." || strings.HasPrefix(c, "../") {
		return fmt.Errorf("상위로 올라갑니다: %q", p)
	}
	return nil
}

func validSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// 타깃 표기는 VS Code 의 것을 빌린다 (D-P5 / §2.4). 우리 표기를 만들면 매니페스트를
// 쓰는 사람이 그것을 따로 배워야 한다.
var (
	targetOS   = map[string]string{"darwin": "darwin", "linux": "linux", "windows": "win32"}
	targetArch = map[string]string{"amd64": "x64", "arm64": "arm64", "arm": "armhf"}
)

// TargetName 은 `GOOS/GOARCH` 를 타깃 이름으로 옮긴다.
//
// 모르는 대상은 **빈 값**이다. 그럴듯한 이름을 지어내면 조달이 없는 타깃을 찾아
// 엉뚱한 것을 받거나, 더 나쁘게는 다른 플랫폼의 바이너리를 놓는다.
func TargetName(buildTarget string) string {
	goos, goarch, ok := strings.Cut(buildTarget, "/")
	if !ok {
		return ""
	}
	o, ok := targetOS[goos]
	if !ok {
		return ""
	}
	a, ok := targetArch[goarch]
	if !ok {
		return ""
	}
	return o + "-" + a
}

// CurrentTarget 은 이 빌드의 타깃 이름이다.
//
// `runtime.GOOS` 를 직접 만지지 않는다 — 그 값은 `platform` 안에서만 다룬다
// (FR-XPL-5).
func CurrentTarget() string { return TargetName(platform.BuildTarget()) }
