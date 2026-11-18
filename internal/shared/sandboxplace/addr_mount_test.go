package sandboxplace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/serverconf"
	"dongminal/internal/shared/toolhub"
)

// TC-HRB-6 (HOT_REBIND_SRS FR-HRB-13 / D-HRB-9): 헬퍼가 있는 컨테이너에는 주소 파일의
// 폴더 run/ 을 읽기 전용으로 붙인다. scratch 에는 붙이지 않는다.
func TestPlace_MountsAddrDirReadOnly(t *testing.T) {
	home := t.TempDir()
	f := &fakeDocker{}
	p := New(sandbox.New(f.run, home), "/usr/bin/docker", devProfiles(), helperDeps(true, nil), "58146", home)
	p.stat = func(string) error { return nil }
	if _, err := p.Place(toolhub.Placement{WindowUUID: "w1", Profile: sandbox.ProfileDev, ToolID: "t1"}); err != nil {
		t.Fatalf("Place: %v", err)
	}
	dir := filepath.Dir(serverconf.AddrPath(home))
	want := "-v " + dir + ":" + dmenv.ContainerAddrDir + ":ro"
	if run := f.joined("run"); !strings.Contains(run, want) {
		t.Errorf("%q 가 없다: %s", want, run)
	}
	// 마운트 원본이 없으면 런타임이 그 자리를 만든다 — 미리 만들어 둔다.
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Errorf("run/ 폴더가 없다: %v", err)
	}

	f = &fakeDocker{}
	p = New(sandbox.New(f.run, home), "/usr/bin/docker", devProfiles(), helperDeps(true, nil), "58146", home)
	p.stat = func(string) error { return nil }
	if _, err := p.Place(toolhub.Placement{WindowUUID: "w2", Profile: sandbox.ProfileScratch, ToolID: "t2"}); err != nil {
		t.Fatalf("Place: %v", err)
	}
	if run := f.joined("run"); strings.Contains(run, dmenv.ContainerAddrDir) {
		t.Errorf("scratch 에 주소 폴더가 붙었다: %s", run)
	}
}

// FR-HRB-13: 데몬이 정하는 기동 때의 포트 — 주소 파일 → server.json → 기본값.
// 환경변수는 보지 않는다 (FR-HRB-11).
func TestStartupPort(t *testing.T) {
	home := t.TempDir()
	t.Setenv(dmenv.EnvPort, "1111")
	if got := startupPort(home, ""); got != dmenv.DefaultPort {
		t.Errorf("기본값 = %q", got)
	}
	if err := serverconf.SetBind(home, "", "9600"); err != nil {
		t.Fatal(err)
	}
	if got := startupPort(home, ""); got != "9600" {
		t.Errorf("server.json = %q", got)
	}
	if err := serverconf.WriteAddr(home, "127.0.0.1:9601"); err != nil {
		t.Fatal(err)
	}
	if got := startupPort(home, ""); got != "9601" {
		t.Errorf("주소 파일 = %q", got)
	}
	if got := startupPort(home, "9602"); got != "9602" {
		t.Errorf("준 포트 = %q", got)
	}
}
