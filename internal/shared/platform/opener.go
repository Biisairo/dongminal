package platform

// Opener 는 URL 을 **평범한 브라우저 창/탭**으로 여는 명령을 조립한다
// (VIEWER_URL_OPEN_SRS FR-VUO-2). 실행은 호출자가 한다.
//
// Browser 와 갈리는 지점은 창 모양이다. Browser 는 주소창 없는 앱 창(--app)을
// 만들고, 이쪽은 사용자가 평소 쓰는 브라우저를 평소 모양으로 연다 — 로그인
// 흐름과 dev 서버는 주소창과 탭이 있어야 쓸 수 있다.
type Opener interface {
	OpenCommand(url string) (name string, args []string, err error)
}

// openerChain 은 browserChain 과 같은 해소 규칙을 쓴다. 규칙이 둘이면 한쪽이
// 조용히 뒤처지므로 몸통(resolve)을 공유한다.
type openerChain struct{ browserChain }

func (o openerChain) OpenCommand(url string) (string, []string, error) { return o.resolve(url) }

// plainArgs 는 URL 하나만 넘긴다.
func plainArgs(url string) []string { return []string{url} }

// macOpener 는 macOS 의 `open <url>` 이다. 인자 없는 `open` 은 기본 브라우저를
// 쓰므로 사용자의 선택을 존중한다.
func macOpener() Opener {
	return openerChain{browserChain{chain: []launcher{
		fixedLauncher{name: "open", args: plainArgs},
	}}}
}

// unixOpener 는 xdg-open 을 먼저 보고, 없으면 호스트로 넘기는 수단(WSL)을 쓴다.
func unixOpener(look lookFn) Opener {
	chain := []launcher{pathLauncher{look: look, names: []string{"xdg-open"}, args: plainArgs}}
	chain = append(chain, hostOpeners(look)...)
	return openerChain{browserChain{
		chain: chain,
		hint: "URL 을 열 수단을 찾지 못했습니다. xdg-utils 를 설치하세요 " +
			"(WSL 이라면 wslu 로 호스트 브라우저를 쓸 수 있습니다)",
	}}
}

// winOpener 는 기본 핸들러에 위임한다. rundll32 는 모든 Windows 에 있으므로
// 실패하지 않는다.
func winOpener() Opener {
	return openerChain{browserChain{chain: []launcher{winDefaultHandler()}}}
}
