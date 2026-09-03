// Package lsp 는 편집기의 코드 탐색을 언어 서버에게 묻는 자리다
// (EDITOR_LSP_SRS).
//
// **프로토콜과 프로세스가 여기 있고 httpapi 에는 없다** (D-4). 방향은 샌드박스와
// 같다 — 그쪽 주석이 이유를 적고 있다: "httpapi 는 컨테이너 런타임을 알지 않는다."
//
// 화면까지 LSP 를 그대로 프록시하지 않는다 (D-1). 편집기가 CDN UMD Monaco 이므로
// `monaco-languageclient` 를 쓸 수 없고, 종단을 우리가 정하면 요청·응답이 우리
// 루트 가드와 우리 상한을 그대로 지난다.
package lsp

import "strings"

// Origin 은 실행 파일을 **어디서 찾았는지**다 (FR-LSP-5).
//
// 이것을 상태에 싣는 근거는 ripgrep 의 `engine` 과 같다 (FR-EGS-3) — 어느 것이
// 쓰이는지 모르면 사용자가 결과 차이를 설명할 수 없다.
type Origin string

const (
	// OriginConfig 는 사용자가 설정에 적은 절대경로다 (FR-LSP-4 ①).
	OriginConfig Origin = "config"
	// OriginPath 는 PATH 다 (②).
	OriginPath Origin = "path"
	// OriginManaged 는 전용 디렉터리다 (③) — 우리가 받아 둔 것.
	OriginManaged Origin = "managed"
)

// Installer 는 서버를 받는 방법이다 (FR-LSP-1).
//
// `Tool` 은 PATH 에서 찾을 패키지 매니저 이름이며, 없을 때 **그 이름으로** 알리기
// 위해 상태에도 실린다 (FR-LSP-11) — "설치 실패" 는 사용자가 다음에 할 일을
// 알려주지 않지만 "go 가 없다" 는 알려준다.
//
// 대상들이 독립 바이너리를 릴리스하지 않으므로(§2.9) 받는 길은 패키지 매니저뿐이다.
type Installer struct {
	// Tool 은 `go` 나 `npm` 이다.
	Tool string
	// Args 는 그 도구에 넘길 인자다. **셸을 거치지 않는다** (FR-LSP-9·51) —
	// 격리 인자(GOBIN·--prefix)는 Install 이 채운다.
	Args []string
}

// Descriptor 는 한 **언어 서버**의 서술자다 (FR-LSP-1).
//
// 단위가 언어가 아니라 서버인 것이 규칙이다 — `typescript-language-server` 하나가
// TypeScript 와 JavaScript 를 함께 덮으므로, 언어를 단위로 삼으면 같은 프로세스가
// 둘로 세어져 두 번 기동된다 (FR-LSP-13).
type Descriptor struct {
	// ID 는 서술자의 식별자이며 세션 키의 한쪽이다.
	ID string
	// Langs 는 이것이 덮는 Monaco language id 들이다 — provider 등록의 단위다
	// (FR-LSP-39).
	Langs []string
	// Exts 는 대응 확장자다 (소문자, 점 포함).
	Exts []string
	// Exe 는 실행 파일 이름이다. 탐색이 이 이름을 찾는다.
	Exe string
	// Args 는 기동 인자다. 대부분 stdio 를 켜는 스위치다.
	Args []string
	// Installer 는 없을 때 받는 방법이다.
	Installer Installer
}

// defaults 는 I-3 의 기본 셋이다. 사용자는 설정으로 더하거나 덮는다 (FR-LSP-3).
var defaults = []Descriptor{
	{
		ID:    "gopls",
		Langs: []string{"go"},
		Exts:  []string{".go"},
		Exe:   "gopls",
		// gopls 는 인자 없이 stdio 로 말한다.
		Installer: Installer{
			Tool: "go",
			Args: []string{"install", "golang.org/x/tools/gopls@latest"},
		},
	},
	{
		// 하나가 넷을 덮는다 — 이것이 단위를 서버로 잡은 이유다.
		ID:    "typescript-language-server",
		Langs: []string{"typescript", "javascript"},
		Exts:  []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"},
		Exe:   "typescript-language-server",
		Args:  []string{"--stdio"},
		Installer: Installer{
			Tool: "npm",
			// `typescript` 도 함께 받는다 — 서버는 그것 없이는 아무것도 모른다.
			Args: []string{"install", "typescript-language-server", "typescript"},
		},
	},
	{
		ID:    "pyright",
		Langs: []string{"python"},
		Exts:  []string{".py", ".pyi"},
		Exe:   "pyright-langserver",
		Args:  []string{"--stdio"},
		Installer: Installer{
			Tool: "npm",
			Args: []string{"install", "pyright"},
		},
	},
}

// Descriptors 는 지금 쓰이는 서술자들이다.
//
// 사본을 돌려준다 — 부르는 쪽이 표를 고쳐도 기본 셋이 바뀌지 않는다.
func Descriptors() []Descriptor {
	out := make([]Descriptor, len(defaults))
	copy(out, defaults)
	return out
}

// DescriptorForExt 는 확장자를 서술자로 푼다.
//
// 서술자에 없는 확장자는 풀리지 않는다 (FR-LSP-1 / V-LSP-1) — 그것이 "세션을
// 세우지 않는다" 의 자리다.
func DescriptorForExt(ext string) (Descriptor, bool) {
	e := strings.ToLower(strings.TrimSpace(ext))
	if e == "" {
		return Descriptor{}, false
	}
	for _, d := range defaults {
		for _, x := range d.Exts {
			if x == e {
				return d, true
			}
		}
	}
	return Descriptor{}, false
}
