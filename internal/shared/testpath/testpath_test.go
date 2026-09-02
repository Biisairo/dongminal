package testpath

import (
	"path/filepath"
	"strings"
	"testing"
)

// 이 패키지의 존재 이유가 곧 불변식이다 — **어느 OS 에서나 절대경로여야 한다.**
// 테스트가 `"/work/repo"` 리터럴을 쓰다 Windows 에서 무너진 것이 이 트랙의
// 원인 ① 이었다 (WINDOWS_TEST_PARITY_SRS §2.2).
func TestAbsIsAbsoluteOnEveryOS(t *testing.T) {
	for _, seg := range [][]string{
		{"work", "repo"},
		{"tmp", "repo"},
		{"r"},
		{"home", "u", "work"},
	} {
		got := Abs(seg...)
		if !filepath.IsAbs(got) {
			t.Errorf("Abs(%q) = %q — 절대경로가 아니다", seg, got)
		}
		if got != filepath.Clean(got) {
			t.Errorf("Abs(%q) = %q — 정규형이 아니다", seg, got)
		}
	}
}

// 조각 없이 부르면 볼륨 루트다. Root 와 같아야 한다 — 두 이름이 갈리면
// "루트를 거부하는가" 를 보는 테스트가 엉뚱한 값을 쓰게 된다.
func TestAbsWithoutSegmentsIsRoot(t *testing.T) {
	if got, want := Abs(), Root(); got != want {
		t.Errorf("Abs() = %q, Root() = %q", got, want)
	}
	if !filepath.IsAbs(Root()) {
		t.Errorf("Root() = %q — 절대경로가 아니다", Root())
	}
}

// 조각은 순서대로 이어진다. 기대값을 만들 때도 같은 함수를 쓰므로(FR-WTP-12)
// 이 성질이 깨지면 입력과 기대값이 함께 틀려 테스트가 통과해 버린다.
func TestAbsJoinsSegmentsInOrder(t *testing.T) {
	got := Abs("a", "b", "c")
	want := filepath.Join(Root(), "a", "b", "c")
	if got != want {
		t.Fatalf("Abs = %q, want %q", got, want)
	}
	if !strings.HasSuffix(got, filepath.Join("a", "b", "c")) {
		t.Errorf("꼬리가 조각 순서와 다르다: %q", got)
	}
}

// 두 번 불러도 같은 값이어야 한다 — 볼륨을 매번 새로 물으면 cwd 가 바뀌는
// 테스트에서 값이 흔들린다.
func TestAbsIsStable(t *testing.T) {
	// 두 호출의 결과를 각각 받아 견준다 — 한 식 안에서 견주면 검사기가 "양변이
	// 같은 식" 으로 읽어 경고한다 (SA4000).
	first, second := Abs("x"), Abs("x")
	if first != second {
		t.Fatalf("같은 인자에 다른 값을 냈다: %q != %q", first, second)
	}
}
