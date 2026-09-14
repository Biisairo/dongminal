package sandboxplace_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/sandboxplace"
	"dongminal/internal/shared/toolhub"
)

// 실제 컨테이너 런타임으로 전 경로를 확인한다 (SRS §4.2 V-7·V-9 계열).
// 런타임이 없으면 건너뛴다 — 이 시험의 부재가 다른 시험을 막아서는 안 된다.
// runtimeReady 는 **리눅스 컨테이너를 돌릴 수 있는지** 본다.
//
// `docker` 명령의 유무만으로는 부족하다. Windows 러너에는 명령이 있어도 리눅스
// 컨테이너를 돌리지 못하는 구성이 있고, 그때 이 시험은 이미지를 받다 실패한다 —
// 이 SRS 의 게스트는 언제나 리눅스다 (NFR-SBX-1).
func runtimeReady(t *testing.T) string {
	t.Helper()
	dockerPath, err := sandbox.FindRuntime(sandbox.LookPath)
	if err != nil {
		t.Skip("컨테이너 런타임 없음")
	}
	out, err := exec.Command(dockerPath, "info", "--format", "{{.OSType}}").CombinedOutput()
	if err != nil {
		t.Skipf("런타임 데몬이 응답하지 않음: %s", strings.TrimSpace(string(out)))
	}
	if os := strings.TrimSpace(string(out)); os != "linux" {
		t.Skipf("리눅스 컨테이너를 돌릴 수 없는 런타임입니다(OSType=%s)", os)
	}
	return dockerPath
}

// 셸이 준 명령을 **실행할 때까지** 기다린다 (M9_SRS FR-M9-13).
//
// 고정 대기 700·700·900·900ms 와 500ms 하나를 대신한다 (M9-A5). 재던 것은
// "몇 밀리초가 지났는가" 였고 알아야 하는 것은 "이 셸이 내가 친 것을 실행하는가"
// 다 — 컨테이너의 첫 기동은 이미지 적재·크로스 빌드가 끼는 회차에서만 늦고,
// 그런 회차에 고정 대기는 짧고 나머지 회차에는 길다.
//
// 표식을 `dm""-<이름>` 으로 치는 것은 **되울림과 실행을 가르기 위해서다.** PTY 는
// 입력을 그대로 되울리므로 따옴표가 남은 줄이 먼저 보인다. 셸이 파싱해 실행한
// 출력에만 따옴표가 빠진 `dm-<이름>` 이 나오고, 그 둘을 가르지 못하면 아직 셸이
// 없는데도 준비됐다고 읽는다.
func runWait(t *testing.T, tool *toolhub.Tool, cmd, name string, timeout time.Duration) {
	t.Helper()
	if err := tool.Write([]byte(cmd + "; echo dm\"\"-" + name + "\n")); err != nil {
		t.Fatalf("%s: write: %v", name, err)
	}
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); {
		blob, _ := tool.Stream().Snapshot()
		if strings.Contains(string(blob), "dm-"+name) {
			return
		}
		// **폴링 간격**이다 — 조건 대기가 아니다 (FR-M9-14 ②).
		time.Sleep(50 * time.Millisecond)
	}
	blob, _ := tool.Stream().Snapshot()
	t.Fatalf("%s 가 %s 안에 끝나지 않았습니다:\n%s", name, timeout, blob)
}

// 셸이 설 때까지의 상한. 컨테이너의 첫 기동에는 이미지 적재가 끼고, dev
// 프로파일에는 헬퍼의 크로스 빌드까지 낀다 — 그 둘이 이 값의 근거다.
const shellReadyWait = 60 * time.Second

func waitShellReady(t *testing.T, tool *toolhub.Tool) {
	t.Helper()
	runWait(t, tool, ":", "ready", shellReadyWait)
}

func TestEndToEnd_ToolRunsInsideContainer(t *testing.T) {
	dockerPath := runtimeReady(t)

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

	waitShellReady(t, tool)
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
	dockerPath := runtimeReady(t)

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

	waitShellReady(t, a)
	waitShellReady(t, b)
	// B 가 읽기 전에 A 의 쓰기가 **끝나** 있어야 한다 — 두 탭이 한 컨테이너를
	// 쓰는지 재는 것이지 누가 먼저 끝나는지 재는 것이 아니다.
	runWait(t, a, "echo shared-by-A > /tmp/shared.txt", "wrote", 10*time.Second)
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
	dockerPath := runtimeReady(t)

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

	waitShellReady(t, tool)
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

// FR-SBX-39/40: 기본 마운트는 어느 창을 열든 붙고, 동적 마운트는 그 창의 작업
// 폴더가 된다. 둘이 서로 다른 자리에 들어가는지 실제 컨테이너에서 확인한다.
func TestEndToEnd_BaseAndDynamicMounts(t *testing.T) {
	dockerPath := runtimeReady(t)

	home := t.TempDir()
	// 기본 마운트로 실어 보낼 자리 (설정·자격증명의 대역).
	shared := t.TempDir()
	if err := os.WriteFile(filepath.Join(shared, "base.txt"), []byte("from-base"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 동적 마운트로 실어 보낼 자리 (이번 작업 공간).
	work := t.TempDir()
	if err := os.WriteFile(filepath.Join(work, "work.txt"), []byte("from-work"), 0o644); err != nil {
		t.Fatal(err)
	}

	conf := `{"mounts":[{"host":` + strconv.Quote(shared) + `,"container":"/shared","readonly":true}],
	          "dev":{"image":"debian:stable-slim"}}`
	if err := os.WriteFile(filepath.Join(home, sandbox.ProfilesFileName), []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}

	window := "e2e-sbx-mounts"
	mgr := sandbox.New(sandbox.CLIRunner(dockerPath), home)
	t.Cleanup(func() { mgr.Remove(window) })

	pl := sandboxplace.Wire(home, "dev", "58146")
	if pl == nil {
		t.Skip("배치기를 만들지 못했다")
	}
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	pm.SetPlacer(pl.Place)

	tool, err := pm.Create(work, 80, 24,
		toolhub.Placement{WindowUUID: window, Profile: sandbox.ProfileDev})
	if err != nil {
		t.Fatalf("dev 도구 생성 실패: %v", err)
	}
	t.Cleanup(func() { pm.Delete(tool.ID) })

	waitShellReady(t, tool)
	// 작업 폴더는 /work 에, 기본 마운트는 /shared 에 — 서로 다른 자리다.
	if err := tool.Write([]byte("cat /work/work.txt; cat /shared/base.txt\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); {
		blob, _ := tool.Stream().Snapshot()
		s := string(blob)
		if strings.Contains(s, "from-work") && strings.Contains(s, "from-base") {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	blob, _ := tool.Stream().Snapshot()
	t.Fatalf("두 마운트가 모두 보이지 않습니다:\n%s", blob)
}
