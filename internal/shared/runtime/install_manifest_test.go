package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
)

// TC-ATF-60 (FR-ATF-60): 덧없는 설치가 놓은 자기 복사본은 기록에 들고, 덧없지 않은 다음 설치가 거둔다.
func TestInstall_ReapsSelfCopy(t *testing.T) {
	goBuild, err := os.MkdirTemp("", "go-build")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(goBuild) })
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := installWith(binDir, fakeExe(t, filepath.Join(goBuild, "b001", "exe"))); err != nil {
		t.Fatal(err)
	}
	copyPath := helperPath(binDir, selfCopyName)
	if _, err := os.Stat(copyPath); err != nil {
		t.Fatalf("복사본이 없다: %v", err)
	}
	if err := installWith(binDir, fakeExe(t, filepath.Join(t.TempDir(), "opt"))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatalf("자기 복사본이 남았다: %v", err)
	}
	if st := InspectHelpers(binDir); !st.Installed || len(st.Problems) != 0 {
		t.Fatalf("현재 헬퍼가 상했다: %+v", st)
	}
}

// TC-ATF-60 (FR-ATF-60): shim 도 기록에 들고, 목록에서 빠진 shim 은 다음 설치가 거둔다.
func TestInstall_ReapsShimDroppedFromManifest(t *testing.T) {
	self := fakeExe(t, filepath.Join(t.TempDir(), "opt"))
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := installWith(binDir, self); err != nil {
		t.Fatal(err)
	}
	shims := dmenv.AgentShimsDirIn(binDir)
	man := filepath.Join(shims, helperManifest)
	blob, err := os.ReadFile(man)
	if err != nil {
		t.Fatalf("shim 기록이 없다: %v", err)
	}
	for _, n := range agentadapter.ShimCommands() {
		if !strings.Contains(string(blob), n+"\n") {
			t.Fatalf("shim %s 가 기록에 없다: %q", n, blob)
		}
	}
	gone := "옛shim"
	if err := os.WriteFile(helperPath(shims, gone), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(man, append(blob, []byte(gone+"\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installWith(binDir, self); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(helperPath(shims, gone)); !os.IsNotExist(err) {
		t.Fatalf("기록에서 빠진 shim 이 남았다: %v", err)
	}
}

// TC-ATF-60 (FR-ATF-60): 기록의 줄에 경로 구분자나 `..` 가 있으면 지우지 않는다.
func TestInstall_ManifestPathLinesIgnored(t *testing.T) {
	self := fakeExe(t, filepath.Join(t.TempDir(), "opt"))
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := installWith(binDir, self); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(binDir, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	victims := map[string]string{
		"../outside": helperPath(root, "outside"),
		"sub/inner":  helperPath(sub, "inner"),
		`sub\inner2`: helperPath(sub, "inner2"),
	}
	man := filepath.Join(binDir, helperManifest)
	blob, err := os.ReadFile(man)
	if err != nil {
		t.Fatal(err)
	}
	blob = append(blob, []byte("..\n")...)
	for line, p := range victims {
		blob = append(blob, []byte(line+"\n")...)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(man, blob, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installWith(binDir, self); err != nil {
		t.Fatal(err)
	}
	for line, p := range victims {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("기록의 %q 줄로 %s 를 지웠다: %v", line, p, err)
		}
	}
}
