package runtimebin

import (
	"path/filepath"
	"testing"
)

func TestDispatchUnknownReturnsNotHandled(t *testing.T) {
	_, ok := Dispatch([]string{"dongminal"})
	if ok {
		t.Errorf("dongminal should not be handled by Dispatch")
	}
	_, ok = Dispatch([]string{})
	if ok {
		t.Errorf("empty argv should not be handled")
	}
	_, ok = Dispatch([]string{"unknown-tool"})
	if ok {
		t.Errorf("unknown tool should not be handled")
	}
}

func TestDispatchHelperBasename(t *testing.T) {
	for _, name := range HelperNames() {
		_, ok := Dispatch([]string{"/abs/path/" + name, "-h"})
		if !ok {
			t.Errorf("helper %s not dispatched via basename", name)
		}
	}
}

func TestHelperNamesNonEmpty(t *testing.T) {
	if len(HelperNames()) == 0 {
		t.Fatal("HelperNames empty")
	}
}

// ── 실행 파일의 확장자 (Windows) ──
//
// 설치는 helper 를 `name+ExeSuffix()` 로 깐다 (`runtime/install.go`). basename 을
// 그대로 표에서 찾으면 Windows 에서는 **어떤 helper 도 걸리지 않고**, dmctl 이 본
// CLI 로 떨어져 사용법만 찍는다 — 에이전트 훅과 알림이 통째로 죽는다.
//
// 경로는 `filepath.Join` 으로 만든다. 구분자를 리터럴로 박으면 이 검사 자신이
// 한 OS 에서만 뜻을 갖는다.
func TestHelperName_StripsExecutableExtension(t *testing.T) {
	cases := []struct{ in, want string }{
		{filepath.Join("home", "bin", "dmctl.exe"), "dmctl"},
		{filepath.Join("home", "bin", "DMCTL.EXE"), "DMCTL"},
		{filepath.Join("home", "bin", "dmctl"), "dmctl"},
		{"dmctl", "dmctl"},
		{"dmctl.exe", "dmctl"},
		{filepath.Join("home", "bin", "dongminald.exe"), "dongminald"},
		// `.exe` 가 아닌 점은 이름의 일부다 — 떼지 않는다.
		{filepath.Join("home", "bin", "my.tool"), "my.tool"},
	}
	for _, c := range cases {
		if got := HelperName(c.in); got != c.want {
			t.Errorf("HelperName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 그 이름으로 실제 dispatch 가 걸린다 — 이름만 맞고 표에 못 닿으면 뜻이 없다.
func TestDispatch_ExeNameDispatches(t *testing.T) {
	if _, ok := Dispatch([]string{filepath.Join("home", "bin", "dmctl.exe"), "--help"}); !ok {
		t.Fatal("dmctl.exe 가 helper 로 걸리지 않는다 — Windows 에서 dmctl 이 통째로 죽는다")
	}
}
