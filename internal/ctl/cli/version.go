package cli

import (
	"fmt"
	"io"
	"runtime"

	"dongminal/internal/shared/platform"
)

// Version 은 이 바이너리의 판이다. 빌드 때 새겨진다 (RELEASE_SRS FR-RVN-1):
//
//	go build -ldflags "-X dongminal/internal/ctl/cli.Version=v1.0.0" ./cmd/dongminal
//
// 새기지 않으면 `dev` 다. **소스에서 직접 빌드한 것과 릴리스 산출물이 구별되어야
// 한다** — 결함 보고에서 그 둘을 섞으면 재현할 수 없다 (FR-RVN-2).
//
// 값을 여기 한 곳에만 두는 이유는 scripts/build.sh 와 릴리스 워크플로우가 같은
// 경로를 가리켜야 하기 때문이다. 두 벌이면 한쪽만 새겨진다.
var Version = "dev"

// ParseVersion 은 `version` 의 인자를 읽는다. 옵션이 없으므로 -h/--help 만
// 받고 나머지는 다른 액션과 같이 옵션 오류다 (FR-CLI-6/7).
func ParseVersion(args []string) error {
	switch {
	case len(args) == 0:
		return nil
	case args[0] == "-h" || args[0] == "--help":
		return ErrHelp
	default:
		return unknownFlag("version", args[0])
	}
}

func usageVersion() string {
	return `사용법: dongminal version

판·대상(OS/아키텍처)·go 런타임을 찍는다. --version 도 같다.
`
}

// RunVersion 은 `dongminal version` 이다.
//
// 대상과 go 런타임을 함께 찍는다 — "무엇을 받았는가" 가 곧 첫 질문이고, 특히
// darwin 은 amd64/arm64 를 잘못 받아도 Rosetta 로 돌아 버려 증상만으로는
// 구별되지 않는다 (FR-RVN-3).
//
// 대상은 platform.BuildTarget 에서 온다. runtime.GOOS 는 platform 안에서만
// 만진다 (FR-XPL-5) — 표시용이라도 예외를 두지 않는다.
func RunVersion(stdout io.Writer) int {
	fmt.Fprintf(stdout, "dongminal %s %s %s\n",
		Version, platform.BuildTarget(), runtime.Version())
	return 0
}
