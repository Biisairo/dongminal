package sandboxplace_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/sandboxplace"
	"dongminal/internal/shared/toolhub"
)

// 실제 컨테이너 런타임으로 전 경로를 확인한다 (SRS §4.2 V-7·V-9 계열).
// 런타임이 없으면 건너뛴다 — 이 시험의 부재가 다른 시험을 막아서는 안 된다.
func TestEndToEnd_ToolRunsInsideContainer(t *testing.T) {
	dockerPath, err := sandbox.FindRuntime(sandbox.LookPath)
	if err != nil {
		t.Skip("컨테이너 런타임 없음")
	}
	if out, err := exec.Command(dockerPath, "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		t.Skipf("런타임 데몬이 응답하지 않음: %s", strings.TrimSpace(string(out)))
	}

	home := t.TempDir()
	window := "e2e-sbx-window"
	mgr := sandbox.New(sandbox.CLIRunner(dockerPath), home)
	t.Cleanup(func() { mgr.Remove(window) })

	pm := toolhub.NewToolManager(t.TempDir(), nil)
	pl := sandboxplace.Wire(home, "dev", "58146")
	if pl == nil {
		t.Skip("배치기를 만들지 못했다")
	}
	pm.SetPlacer(pl.Place)

	tool, err := pm.Create("", 80, 24, toolhub.Placement{WindowUUID: window, Profile: sandbox.ProfileScratch})
	if err != nil {
		t.Fatalf("샌드박스 도구 생성 실패: %v", err)
	}
	t.Cleanup(func() { pm.Delete(tool.ID) })

	time.Sleep(700 * time.Millisecond)
	// 컨테이너 안에서 도는지는 게스트의 정체로 확인한다. 호스트는 macOS·Windows
	// 일 수 있고 그때 이 파일 자체가 없다.
	if err := tool.Write([]byte("cat /etc/os-release | head -1\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		blob, _ := tool.Stream().Snapshot()
		if strings.Contains(strings.ToLower(string(blob)), "debian") {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	blob, _ := tool.Stream().Snapshot()
	t.Fatalf("도구가 컨테이너 안에서 돌지 않았습니다:\n%s", blob)
}

// FR-SBX-7/26: 같은 Window 의 두 도구는 한 컨테이너를 공유한다. 한쪽이 만든
// 파일이 다른 쪽에 보여야 한다 — 탭마다 컨테이너가 생기면 깨진다.
func TestEndToEnd_TabsShareOneContainer(t *testing.T) {
	dockerPath, err := sandbox.FindRuntime(sandbox.LookPath)
	if err != nil {
		t.Skip("컨테이너 런타임 없음")
	}
	if err := exec.Command(dockerPath, "info").Run(); err != nil {
		t.Skip("런타임 데몬이 응답하지 않음")
	}

	home := t.TempDir()
	window := "e2e-sbx-share"
	mgr := sandbox.New(sandbox.CLIRunner(dockerPath), home)
	t.Cleanup(func() { mgr.Remove(window) })

	pm := toolhub.NewToolManager(t.TempDir(), nil)
	pl := sandboxplace.Wire(home, "dev", "58146")
	if pl == nil {
		t.Skip("배치기를 만들지 못했다")
	}
	pm.SetPlacer(pl.Place)
	place := toolhub.Placement{WindowUUID: window, Profile: sandbox.ProfileScratch}

	a, err := pm.Create("", 80, 24, place)
	if err != nil {
		t.Fatalf("탭 A: %v", err)
	}
	t.Cleanup(func() { pm.Delete(a.ID) })
	b, err := pm.Create("", 80, 24, place)
	if err != nil {
		t.Fatalf("탭 B: %v", err)
	}
	t.Cleanup(func() { pm.Delete(b.ID) })

	time.Sleep(700 * time.Millisecond)
	a.Write([]byte("echo shared-by-A > /tmp/shared.txt\n"))
	time.Sleep(500 * time.Millisecond)
	b.Write([]byte("cat /tmp/shared.txt\n"))

	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		blob, _ := b.Stream().Snapshot()
		if strings.Contains(string(blob), "shared-by-A") {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	blob, _ := b.Stream().Snapshot()
	t.Fatalf("두 탭이 컨테이너를 공유하지 않았습니다:\n%s", blob)
}

// FR-SBX-14/15/16: dev 프로파일은 서버와 같은 판의 리눅스 dmctl 을 컨테이너에
// 넣고, 그것이 서버에 되붙을 주소를 함께 심는다.
//
// 개발 빌드에서는 크로스 빌드가 일어나므로 처음 한 번은 느리다.
func TestEndToEnd_DevProfileCarriesHelper(t *testing.T) {
	dockerPath, err := sandbox.FindRuntime(sandbox.LookPath)
	if err != nil {
		t.Skip("컨테이너 런타임 없음")
	}
	if err := exec.Command(dockerPath, "info").Run(); err != nil {
		t.Skip("런타임 데몬이 응답하지 않음")
	}

	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, sandbox.ProfilesFileName),
		[]byte(`{"dev":{"image":"debian:stable-slim","ports":[]}}`), 0o644); err != nil {
		t.Fatalf("프로파일 정의: %v", err)
	}

	window := "e2e-sbx-dev"
	mgr := sandbox.New(sandbox.CLIRunner(dockerPath), home)
	t.Cleanup(func() { mgr.Remove(window) })

	pl := sandboxplace.Wire(home, "dev", "58146")
	if pl == nil {
		t.Skip("배치기를 만들지 못했다")
	}
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	pm.SetPlacer(pl.Place)

	work := t.TempDir()
	tool, err := pm.Create(work, 80, 24,
		toolhub.Placement{WindowUUID: window, Profile: sandbox.ProfileDev})
	if err != nil {
		t.Fatalf("dev 도구 생성 실패: %v", err)
	}
	t.Cleanup(func() { pm.Delete(tool.ID) })

	time.Sleep(900 * time.Millisecond)
	// 헬퍼가 PATH 에 있고, 서버 주소가 심겨 있어야 한다.
	if err := tool.Write([]byte("command -v dmctl; echo HOST=$DONGMINAL_HOST; pwd\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); {
		blob, _ := tool.Stream().Snapshot()
		s := string(blob)
		if strings.Contains(s, sandbox.HelperMountPath) &&
			strings.Contains(s, "HOST="+sandbox.HostGateway) &&
			strings.Contains(s, sandbox.ContainerWorkdir) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	blob, _ := tool.Stream().Snapshot()
	t.Fatalf("헬퍼·주소·작업 디렉터리가 갖춰지지 않았습니다:\n%s", blob)
}
