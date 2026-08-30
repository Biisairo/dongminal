package cli

import (
	"runtime"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// 새기지 않은 빌드는 dev 여야 한다. 릴리스 산출물과 소스 빌드를 구별하는
// 유일한 표지이므로, 이 기본값이 바뀌면 결함 보고에서 둘을 섞게 된다
// (RELEASE_SRS FR-RVN-2).
func TestVersion_DefaultsToDev(t *testing.T) {
	if Version != "dev" {
		t.Fatalf("Version=%q — 주입 없이 빌드했는데 dev 가 아니다", Version)
	}
}

// 대상과 런타임을 함께 찍어야 한다. darwin 은 amd64 를 받아도 Rosetta 로 돌아
// 증상만으로는 구별되지 않는다 (FR-RVN-3).
//
// 기대값을 platform.BuildTarget 에서 가져오는 것이 요점이다 — 테스트가
// runtime.GOOS 를 직접 만지면 그 자체로 FR-XPL-5 위반이다.
func TestRunVersion_ReportsTargetAndRuntime(t *testing.T) {
	var buf strings.Builder
	if code := RunVersion(&buf); code != 0 {
		t.Fatalf("종료 코드 %d", code)
	}
	out := buf.String()
	for _, want := range []string{
		"dongminal", Version, platform.BuildTarget(), runtime.Version(),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("출력에 %q 가 없다: %q", want, out)
		}
	}
}

func TestDispatch_VersionActions(t *testing.T) {
	for _, args := range [][]string{{"version"}, {"--version"}} {
		var out, errBuf strings.Builder
		if code := Dispatch(args, nil, &out, &errBuf); code != 0 {
			t.Fatalf("%v: 종료 코드 %d (stderr=%q)", args, code, errBuf.String())
		}
		if !strings.Contains(out.String(), "dongminal "+Version) {
			t.Fatalf("%v: %q", args, out.String())
		}
	}
}

// 도움말 머리줄이 판을 싣는다 — 인자 없이 실행했을 때 무엇을 받았는지 보인다.
func TestHelp_CarriesVersion(t *testing.T) {
	if !strings.Contains(Help(), "dongminal "+Version) {
		t.Fatalf("도움말에 판이 없다:\n%s", strings.SplitN(Help(), "\n", 2)[0])
	}
}
