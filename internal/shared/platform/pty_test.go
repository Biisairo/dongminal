package platform

import (
	"reflect"
	"strings"
	"testing"
)

// 호출자는 append(os.Environ(), 덧붙일것...) 로 환경을 만든다. 정리하지 않으면
// **덧붙인 값이 아니라 원본이 이긴다** — Windows 터미널에서 PATH 에 binDir 이
// 들어가지 않아 dmctl 이 잡히지 않던 원인이다.
func TestDedupEnvLastWins(t *testing.T) {
	in := []string{"PATH=/usr/bin", "HOME=/h", "PATH=/usr/bin:/extra"}
	got := dedupEnv(in, envKeyAsIs)
	want := []string{"PATH=/usr/bin:/extra", "HOME=/h"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupEnv = %v, want %v", got, want)
	}
}

// Windows 는 환경변수 이름의 대소문자를 구분하지 않는다. Path 와 PATH 가 둘 다
// 남으면 어느 쪽이 이길지 알 수 없다.
func TestDedupEnvFoldsCaseForWindows(t *testing.T) {
	in := []string{"Path=C:\\Windows", "PATH=C:\\Windows;C:\\bin"}
	got := dedupEnv(in, envKeyFolded)
	if len(got) != 1 || got[0] != "PATH=C:\\Windows;C:\\bin" {
		t.Fatalf("dedupEnv = %v", got)
	}
	// POSIX 규칙에서는 서로 다른 이름이므로 둘 다 남는다.
	if got := dedupEnv(in, envKeyAsIs); len(got) != 2 {
		t.Fatalf("POSIX 규칙에서 = %v, 둘 다 남아야 한다", got)
	}
}

// "=" 로 시작하는 항목은 Windows 의 드라이브별 cwd 다. 키가 없으므로 묶지 않고
// 그대로 둔다 — 지우면 자식의 상대 경로 해석이 달라진다.
func TestDedupEnvKeepsDriveEntries(t *testing.T) {
	in := []string{"=C:=C:\\work", "=D:=D:\\x", "PATH=a"}
	got := dedupEnv(in, envKeyFolded)
	if len(got) != 3 {
		t.Fatalf("dedupEnv = %v — 특수 항목이 사라졌다", got)
	}
	if !strings.HasPrefix(got[0], "=C:") || !strings.HasPrefix(got[1], "=D:") {
		t.Fatalf("특수 항목 순서가 바뀌었다: %v", got)
	}
}

func TestDedupEnvDropsEmpty(t *testing.T) {
	if got := dedupEnv([]string{"", "A=1"}, envKeyAsIs); !reflect.DeepEqual(got, []string{"A=1"}) {
		t.Fatalf("dedupEnv = %v", got)
	}
}

// ConPTY 는 크기 0 을 E_INVALIDARG 로 거절한다. POSIX 는 그냥 뜨므로, 하한이
// 없으면 이 차이가 Windows 에서만 "터미널이 안 뜬다" 로 나타난다.
func TestClampSizeRejectsZero(t *testing.T) {
	cases := [][4]uint16{
		{0, 0, defaultCols, defaultRows},
		{0, 30, defaultCols, 30},
		{100, 0, 100, defaultRows},
		{100, 30, 100, 30},
	}
	for _, c := range cases {
		gc, gr := clampSize(c[0], c[1])
		if gc != c[2] || gr != c[3] {
			t.Fatalf("clampSize(%d,%d) = %d,%d — want %d,%d", c[0], c[1], gc, gr, c[2], c[3])
		}
	}
}
