package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/platform"
)

// HELPER_INSTALL_SRS 묶음 D·H — 진단은 고치지 않고 알린다.

// brokenHome 은 헬퍼가 죽어 있는 홈이다. 사용자가 겪은 그 상태다 —
// 링크는 있는데 가리키는 곳이 없다.
func brokenHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(t.TempDir(), "go-build-사라짐", "dongminal")
	suffix := platform.Current().Paths.ExeSuffix()
	for _, n := range runtimebin.HelperNames() {
		if err := os.Symlink(gone, filepath.Join(binDir, n+suffix)); err != nil {
			t.Skipf("이 파일시스템은 심볼릭 링크를 만들지 못한다: %v", err)
		}
	}
	return home
}

// V-HLI-7: health 가 깨진 헬퍼를 실패로 센다.
//
// 서버와 데몬이 멀쩡해도 이것만으로 실패여야 한다 — 에이전트 훅은 이 자리에
// 기대고 있고, 그것이 죽으면 훅이 죽는다.
func TestHealth_ReportsBrokenHelpers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	_, port, _ := strings.Cut(strings.TrimPrefix(srv.URL, "http://"), ":")

	home := brokenHome(t)
	var out, errb bytes.Buffer
	code := RunHealth(HealthOpts{Common: Common{Home: home, Port: port}}, &out, &errb)

	if code == 0 {
		t.Fatalf("깨진 헬퍼를 그냥 넘겼다:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "헬퍼") {
		t.Fatalf("무엇이 깨졌는지 말하지 않는다:\n%s", out.String())
	}
	// FR-HLI-10: 되돌리는 방법을 알린다.
	if !strings.Contains(out.String(), "dongminal start") {
		t.Fatalf("고치는 방법을 알리지 않는다:\n%s", out.String())
	}
}

// 성한 설치에서는 헬퍼가 실패를 만들지 않는다.
func TestHealth_SilentOnHealthyHelpers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()
	_, port, _ := strings.Cut(strings.TrimPrefix(srv.URL, "http://"), ":")

	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	suffix := platform.Current().Paths.ExeSuffix()
	for _, n := range runtimebin.HelperNames() {
		if err := os.WriteFile(filepath.Join(binDir, n+suffix), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	var out, errb bytes.Buffer
	if code := RunHealth(HealthOpts{Common: Common{Home: home, Port: port}}, &out, &errb); code != 0 {
		t.Fatalf("rc=%d\n%s", code, out.String())
	}
}

// V-HLI-6: 진단은 자국을 남기지 않는다 (D-4).
//
// 종전에는 `doctor` 가 검사를 위해 **운영 홈의 bin 에 실제로 설치**했고, 그 경로로
// 이번 사고가 났다 (§2.5). 검사가 대상을 바꾸지 않는지를 여기서 못박는다.
func TestDoctorHelpers_DoesNotTouchTarget(t *testing.T) {
	home := brokenHome(t)
	binDir := filepath.Join(home, "bin")
	before, err := os.ReadDir(binDir)
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	r := &checkReport{out: &out}
	doctorHelpers(r, binDir)

	if r.fail == 0 {
		t.Fatalf("깨진 헬퍼를 통과시켰다:\n%s", out.String())
	}
	after, err := os.ReadDir(binDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("진단이 대상을 바꿨다: %d개 → %d개", len(before), len(after))
	}
	for _, e := range after {
		p := filepath.Join(binDir, e.Name())
		if _, err := os.Readlink(p); err != nil {
			t.Errorf("%s 가 링크가 아니게 됐다 — 진단이 다시 설치했다", e.Name())
		}
	}
}

// 검사용 임시 bin 은 운영 홈 밖이고, 끝나면 사라진다 (FR-HLI-5).
func TestDoctorProbeBin_IsTemporary(t *testing.T) {
	dir, cleanup, err := doctorProbeBin()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dir, os.TempDir()) {
		// macOS 는 /var 와 /private/var 가 갈리므로 둘 다 받는다.
		if resolved, rerr := filepath.EvalSymlinks(os.TempDir()); rerr != nil || !strings.HasPrefix(dir, resolved) {
			t.Fatalf("임시 자리가 아니다: %s", dir)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("검사용 자리가 남았다: %s (%v)", dir, err)
	}
}
