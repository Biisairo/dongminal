package cli

import (
	"fmt"
	"io"
	"os"
	"time"
)

// Opener 는 URL 하나로 frameless window 를 여는 수단이다. 기본은
// openFrameless 이고, 테스트가 여기를 갈아 끼운다 — `serve` 를 주입받는
// RunStart 와 같은 관행이다 (WINDOW_COMMAND_SRS V-WIN-2/3/4).
type Opener func(url string) error

// windowPingTimeout 은 준비 확인 한 번의 제한이다. 기다리지 않는 명령이므로
// 재시도가 없다 (D-5).
const windowPingTimeout = 2 * time.Second

// RunWindow는 `dongminal window` 다 (FR-WIN-1..7).
//
// **서버를 띄우지 않는다.** 그것이 이 명령이 `start --open` 에서 갈라져 나온
// 이유다 — 이미 돌고 있는 서버에 창만 하나 더 붙이는 자리가 없었다.
func RunWindow(o WindowOpts, open Opener, stdout, stderr io.Writer) int {
	// FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다. 두 곳이 다르면
	// 띄운 자리와 여는 자리가 어긋난다.
	host := DefaultHost
	if v := os.Getenv(EnvHost); v != "" {
		host = v
	}
	url := ServerURL(host, o.ResolvePort())

	// FR-WIN-3: 죽은 서버에 창을 띄우면 사용자는 빈 화면에서 원인을 찾게 된다.
	if !ping(url+"/api/ping", windowPingTimeout) {
		fmt.Fprintf(stderr, "❌ %s 에서 응답이 없습니다 — 서버가 떠 있지 않습니다\n", url)
		fmt.Fprintln(stderr, "   먼저 띄웁니다: dongminal start")
		return 1
	}

	// FR-WIN-4: 창이 이 명령의 본체다. 여는 데 실패하면 명령이 실패한 것이다
	// (start 에서 경고에 그쳤던 이유는 거기서는 서버가 본체였기 때문이다).
	if err := open(url); err != nil {
		fmt.Fprintf(stderr, "❌ 창을 열지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "✅ 창을 열었습니다 — %s\n", url)
	return 0
}
