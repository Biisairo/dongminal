package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/platform"
)

// HELPER_INSTALL_SRS 묶음 I·H — 사라질 것을 가리키지 않는다.
//
// 실제로 난 사고를 재현한다: `go run` 아래에서 설치하면 헬퍼 다섯이 임시 빌드
// 산출물을 가리키고, 그 프로세스가 끝나면서 **한꺼번에 죽는다** (§2.1).

// fakeExe 는 실행 파일 하나를 만든다. 내용은 상관없다 — 존재와 소멸만 잰다.
func fakeExe(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "dongminal"+platform.Current().Paths.ExeSuffix())
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func helperPath(binDir, name string) string {
	return filepath.Join(binDir, name+platform.Current().Paths.ExeSuffix())
}

// V-HLI-1: 덧없는 자기 자신으로 설치해도, 원본이 사라진 뒤 헬퍼가 살아 있다.
func TestInstall_EphemeralSelfSurvivesSourceRemoval(t *testing.T) {
	// `go run` 이 만드는 자리를 그대로 흉내 낸다 — 임시 디렉터리 아래의 go-build*.
	goBuild, err := os.MkdirTemp("", "go-build")
	if err != nil {
		t.Fatal(err)
	}
	self := fakeExe(t, filepath.Join(goBuild, "b001", "exe"))
	binDir := filepath.Join(t.TempDir(), "bin")

	if err := installWith(binDir, self); err != nil {
		t.Fatalf("install: %v", err)
	}
	// go run 이 끝나는 순간이다.
	if err := os.RemoveAll(goBuild); err != nil {
		t.Fatal(err)
	}

	if bad := CheckHelpers(binDir); len(bad) > 0 {
		t.Fatalf("원본이 사라지자 헬퍼가 죽었다: %+v", bad)
	}
	for _, name := range runtimebin.HelperNames() {
		if _, err := os.Stat(helperPath(binDir, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	// FR-HLI-1: 붙들어 둔 실체가 bin 안에 있다 (D-3).
	if _, err := os.Stat(filepath.Join(binDir, selfCopyName+platform.Current().Paths.ExeSuffix())); err != nil {
		t.Errorf("안정된 복사본이 없다: %v", err)
	}
}

// V-HLI-2: 덧없지 않으면 종전과 같다 — 복사본을 만들지 않는다.
func TestInstall_StableSelfIsNotCopied(t *testing.T) {
	self := fakeExe(t, filepath.Join(t.TempDir(), "opt"))
	binDir := filepath.Join(t.TempDir(), "bin")

	if err := installWith(binDir, self); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(binDir, selfCopyName+platform.Current().Paths.ExeSuffix())); err == nil {
		t.Fatal("덧없지 않은데 복사본을 만들었다")
	}
	if bad := CheckHelpers(binDir); len(bad) > 0 {
		t.Fatalf("정상 설치인데 문제로 보고했다: %+v", bad)
	}
}

// V-HLI-3: 판정은 두 조건을 **모두** 만족할 때만이다 (D-2).
func TestIsEphemeralExe(t *testing.T) {
	tmp := os.TempDir()
	if r, err := filepath.EvalSymlinks(tmp); err == nil {
		tmp = r
	}
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"go run 산출물", filepath.Join(tmp, "go-build123", "b001", "exe", "dongminal"), true},
		{"임시 아래지만 go-build 아님", filepath.Join(tmp, "dongminal-iso-9", "bin", "dongminal"), false},
		{"go-build 이름이지만 임시 밖", filepath.Join("/opt", "go-build", "dongminal"), false},
		{"평범한 설치 자리", filepath.Join("/usr", "local", "bin", "dongminal"), false},
	}
	for _, c := range cases {
		if got := isEphemeralExe(c.path); got != c.want {
			t.Errorf("%s: isEphemeralExe(%q)=%v, want %v", c.name, c.path, got, c.want)
		}
	}
}

// V-HLI-4: 사용자가 본 그 사건 — 링크는 있는데 대상이 없다.
func TestCheckHelpers_FindsDangling(t *testing.T) {
	binDir := t.TempDir()
	names := runtimebin.HelperNames()
	if len(names) < 2 {
		t.Skip("헬퍼가 둘 미만")
	}
	// 하나는 죽은 링크로, 하나는 아예 없는 채로 둔다.
	gone := filepath.Join(t.TempDir(), "사라진-바이너리")
	if err := os.Symlink(gone, helperPath(binDir, names[0])); err != nil {
		t.Skipf("이 파일시스템은 심볼릭 링크를 만들지 못한다: %v", err)
	}
	for _, n := range names[1:] {
		if err := os.WriteFile(helperPath(binDir, n), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(helperPath(binDir, names[1])); err != nil {
		t.Fatal(err)
	}

	bad := CheckHelpers(binDir)
	if len(bad) != 2 {
		t.Fatalf("문제 2건이어야 한다: %+v", bad)
	}
	byName := map[string]HelperProblem{}
	for _, b := range bad {
		byName[b.Name] = b
	}
	if r := byName[names[0]].Reason; !strings.Contains(r, "가리키는 곳이 없습니다") {
		t.Errorf("죽은 링크의 사유가 다르다: %q", r)
	}
	if r := byName[names[1]].Reason; !strings.Contains(r, "설치되지 않았습니다") {
		t.Errorf("없는 파일의 사유가 다르다: %q", r)
	}
}

// V-HLI-5: 성한 설치에는 아무 말도 하지 않는다.
func TestCheckHelpers_SilentWhenHealthy(t *testing.T) {
	self := fakeExe(t, filepath.Join(t.TempDir(), "opt"))
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := installWith(binDir, self); err != nil {
		t.Fatal(err)
	}
	if bad := CheckHelpers(binDir); len(bad) != 0 {
		t.Fatalf("문제가 없어야 한다: %+v", bad)
	}
}
