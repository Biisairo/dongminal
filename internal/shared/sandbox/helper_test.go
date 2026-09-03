package sandbox

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
)

type fakeHelperEnv struct {
	present   map[string]bool
	built     []string
	fetched   []string
	fetchURL  string
	removed   []string
	listed    []string
	buildErr  error
	fetchErr  error
	removeErr error
}

func (f *fakeHelperEnv) deps(version string) HelperDeps {
	return HelperDeps{
		Version: version,
		Arch:    "arm64",
		Home:    "/home/u/.dongminal",
		Stat: func(p string) error {
			if f.present[p] {
				return nil
			}
			return fs.ErrNotExist
		},
		Fetch: func(url, dest string) error {
			f.fetchURL = url
			if f.fetchErr != nil {
				return f.fetchErr
			}
			f.fetched = append(f.fetched, dest)
			f.present[dest] = true
			return nil
		},
		CrossBuild: func(goarch, dest string) error {
			if f.buildErr != nil {
				return f.buildErr
			}
			f.built = append(f.built, dest)
			f.present[dest] = true
			return nil
		},
		ListCache: func(string) ([]string, error) { return f.listed, nil },
		Remove:    func(p string) error { f.removed = append(f.removed, p); return f.removeErr },
	}
}

func newHelperEnv() *fakeHelperEnv { return &fakeHelperEnv{present: map[string]bool{}} }

// FR-SBX-14: 경로에 버전이 들어간다. 버전이 오르면 경로가 달라져 새로 확보된다.
func TestHelperCachePath_CarriesVersion(t *testing.T) {
	a := HelperCachePath("/h", "v1.2.3", "arm64")
	b := HelperCachePath("/h", "v1.3.0", "arm64")
	if a == b {
		t.Fatal("버전이 달라도 경로가 같다 — 업그레이드 후에도 옛 바이너리를 쓴다")
	}
	if !strings.Contains(a, "v1.2.3") || !strings.Contains(a, "linux") || !strings.Contains(a, "arm64") {
		t.Errorf("경로에 판별 정보가 없다: %s", a)
	}
}

// FR-SBX-29: 이미 있으면 받지도 만들지도 않는다. 사용자가 직접 놓아둔 파일도
// 이 갈래로 쓰인다 — 오프라인의 도피구다.
func TestEnsureHelper_UsesExistingCache(t *testing.T) {
	f := newHelperEnv()
	d := f.deps("v1.2.3")
	want := HelperCachePath(d.Home, d.Version, d.Arch)
	f.present[want] = true

	got, err := EnsureHelper(d)
	if err != nil {
		t.Fatalf("EnsureHelper: %v", err)
	}
	if got != want {
		t.Errorf("경로가 다르다: %q", got)
	}
	if len(f.fetched) != 0 || len(f.built) != 0 {
		t.Error("있는데 다시 확보했다")
	}
}

// FR-SBX-15: 릴리스 판은 **그 태그에서** 받는다. latest 를 받으면 서버보다 새
// 헬퍼가 들어와 FR-SBX-14 가 막으려던 불일치가 그대로 재현된다.
func TestEnsureHelper_DownloadsFromExactTag(t *testing.T) {
	f := newHelperEnv()
	if _, err := EnsureHelper(f.deps("v1.2.3")); err != nil {
		t.Fatalf("EnsureHelper: %v", err)
	}
	if len(f.fetched) != 1 {
		t.Fatalf("받지 않았다: %+v", f)
	}
	if !strings.Contains(f.fetchURL, "v1.2.3") {
		t.Errorf("URL 이 태그를 가리키지 않는다: %s", f.fetchURL)
	}
	if strings.Contains(f.fetchURL, "latest") {
		t.Errorf("latest 에서 받았다: %s", f.fetchURL)
	}
	if !strings.Contains(f.fetchURL, "linux-arm64") {
		t.Errorf("URL 에 대상이 없다: %s", f.fetchURL)
	}
}

// FR-SBX-15: 소스 빌드(dev)에는 대응하는 릴리스가 없다. 크로스 빌드가 유일한 길.
func TestEnsureHelper_DevBuildsFromSource(t *testing.T) {
	f := newHelperEnv()
	if _, err := EnsureHelper(f.deps("dev")); err != nil {
		t.Fatalf("EnsureHelper: %v", err)
	}
	if len(f.built) != 1 {
		t.Fatalf("크로스 빌드를 하지 않았다: %+v", f)
	}
	if len(f.fetched) != 0 {
		t.Error("dev 인데 내려받으려 했다 — 대응하는 릴리스가 없다")
	}
}

// 확보 실패는 조용히 넘어가지 않는다 (FR-SBX-20/21).
func TestEnsureHelper_FailureIsReported(t *testing.T) {
	f := newHelperEnv()
	f.buildErr = errors.New("go: command not found")
	if _, err := EnsureHelper(f.deps("dev")); err == nil {
		t.Fatal("크로스 빌드 실패가 전파되지 않았다")
	}
	f2 := newHelperEnv()
	f2.fetchErr = errors.New("404")
	if _, err := EnsureHelper(f2.deps("v9.9.9")); err == nil {
		t.Fatal("다운로드 실패가 전파되지 않았다")
	}
}

// FR-SBX-29: 현재 버전이 아닌 캐시는 치운다. 버전마다 14MB 가 쌓인다.
func TestPruneHelperCache_KeepsOnlyCurrent(t *testing.T) {
	f := newHelperEnv()
	d := f.deps("v1.3.0")
	cur := HelperCachePath(d.Home, d.Version, d.Arch)
	old := HelperCachePath(d.Home, "v1.2.3", d.Arch)
	f.listed = []string{cur, old}

	PruneHelperCache(d)
	if len(f.removed) != 1 || f.removed[0] != old {
		t.Fatalf("정리 대상이 다르다: %v", f.removed)
	}
}
