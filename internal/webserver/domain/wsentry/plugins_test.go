package wsentry

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// LSP_PLUGIN_SRS 묶음 P 의 서버측 (V-EXT-15).
//
// 플러그인 루트도 메모 루트와 같은 **파생값**이다. 이 파일이 지키는 것은 그 파생이
// `Roots` 에 닿는 경로 하나다 — 닿지 않으면 선언 파일에 대한 모든 조작이 루트
// 가드에 막히고, 그러면 "고칠 수 있다"(FR-EXT-9)는 말이 거짓이 된다.

// TC-EXT-70 (FR-EXT-9b): Plugins 는 자리를 정규화해 주고, 없으면 만든다.
func TestPlugins_CreatesAndNormalizes(t *testing.T) {
	dir := t.TempDir()
	plugins := filepath.Join(dir, "ext", "plugins")
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.PluginsDir = plugins

	got, err := s.Plugins()
	if err != nil {
		t.Fatalf("Plugins: %v", err)
	}
	if want := NormalizePath(plugins); got != want {
		t.Fatalf("Plugins()=%q, want %q", got, want)
	}
	st, err := os.Stat(plugins)
	if err != nil {
		t.Fatalf("플러그인 루트가 만들어지지 않았다: %v", err)
	}
	if !st.IsDir() {
		t.Fatal("플러그인 루트가 디렉터리가 아니다")
	}
}

// TC-EXT-71 (FR-EXT-9b / V-EXT-15): **Roots 에 든다.**
//
// 이것이 이 파일의 요점이다. 루트 가드(`fsRoot`)가 `Roots` 만 보므로, 여기 들지
// 않으면 편집기가 선언을 열지도 저장하지도 못한다.
func TestPlugins_InRoots(t *testing.T) {
	dir := t.TempDir()
	plugins := filepath.Join(dir, "ext", "plugins")
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.PluginsDir = plugins

	roots, err := s.Roots()
	if err != nil {
		t.Fatalf("Roots: %v", err)
	}
	if !slices.Contains(roots, NormalizePath(plugins)) {
		t.Fatalf("플러그인 루트가 Roots 에 없다 — 선언을 열 수 없다: %+v", roots)
	}
}

// TC-EXT-72 (FR-NOT-11 과 같은 근거): 자리가 없으면 **그 행 하나만** 없다.
//
// 응답 전체의 실패가 아니다 — 플러그인 루트를 얻지 못했다고 Editor 목록이 통째로
// 서지 않으면, 없어도 되는 것 하나 때문에 표면 전체가 사라진다.
func TestPlugins_UnavailableIsNotFatal(t *testing.T) {
	dir := t.TempDir()
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.PluginsDir = ""

	if _, err := s.Plugins(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("자리가 없을 때 ErrUnavailable 이 아니다: %v", err)
	}
	roots, err := s.Roots()
	if err != nil {
		t.Fatalf("플러그인 루트가 없다고 Roots 가 실패했다: %v", err)
	}
	if len(roots) == 0 {
		t.Fatal("Roots 가 비었다 — 홈은 남아야 한다")
	}
}
