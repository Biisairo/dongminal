package toolhub

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/testpath"
)

// newTestManager 는 저장 고루틴을 기다리는 매니저다.
//
// SaveAll 은 요청 경로를 막지 않으려고 고루틴으로 떨어지는데, 기다리지 않으면
// tools.json 쓰기가 t.TempDir 정리와 경쟁해 "directory not empty" 로 간헐
// 실패한다 (WINDOWS_TEST_PARITY_SRS §5 와 같은 자리). t.Cleanup 은 LIFO 이므로
// 여기서 등록한 것이 TempDir 정리보다 먼저 돈다.
func newTestManager(t *testing.T) *ToolManager {
	t.Helper()
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	return m
}

func shPlace(marker string) *platform.ProcSpec {
	return &platform.ProcSpec{
		Path: "/bin/sh",
		Args: []string{"/bin/sh", "-c", "echo " + marker + "; sleep 5"},
	}
}

// FR-SBX-21 (안전 필수): 샌드박스 배치가 실패하면 도구는 뜨지 않는다.
//
// 호스트 셸로 강등되면 사용자는 격리된 줄 알고 신뢰하지 않는 코드를 호스트에서
// 돌린다 — 이 기능이 막으려던 사고 그 자체다. 조용한 강등은 기능 부재보다 나쁘다.
func TestCreate_PlacementFailureNeverFallsBackToHost(t *testing.T) {
	m := newTestManager(t)
	m.SetPlacer(func(Placement) (*platform.ProcSpec, error) {
		return nil, errors.New("컨테이너 런타임에 연결할 수 없습니다")
	})
	tool, err := m.Create("", 80, 24, Placement{WindowUUID: "w-sbx", Profile: "scratch"})
	if err == nil {
		if tool != nil {
			tool.kill()
		}
		t.Fatal("배치 실패인데 도구가 떴다 — 호스트 셸로 강등되면 격리가 조용히 사라진다")
	}
}

// placer 가 낸 명세로 도구가 뜬다 (FR-SBX-10/12).
func TestCreate_UsesPlacementSpec(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("place 를 POSIX 셸 문법으로 확인한다")
	}
	m := newTestManager(t)
	var askedFor string
	m.SetPlacer(func(pl Placement) (*platform.ProcSpec, error) {
		askedFor = pl.WindowUUID
		return shPlace("PLACED-BY-MANAGER"), nil
	})
	p, err := m.Create("", 80, 24, Placement{WindowUUID: "w-sbx", Profile: "scratch"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer p.kill()
	if askedFor != "w-sbx" {
		t.Errorf("placer 가 받은 Window 가 다르다: %q", askedFor)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		blob, _ := p.Stream().Snapshot()
		if strings.Contains(string(blob), "PLACED-BY-MANAGER") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("placer 의 명세가 뜨지 않았다")
}

// NFR-SBX-2: 프로파일이 없으면 placer 를 묻지도 않는다. 샌드박스가 아닌 창의
// 경로는 이 변경 전과 완전히 같아야 한다.
func TestCreate_NoProfileSkipsPlacer(t *testing.T) {
	m := newTestManager(t)
	called := false
	m.SetPlacer(func(Placement) (*platform.ProcSpec, error) {
		called = true
		return nil, errors.New("불려서는 안 된다")
	})
	p, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer p.kill()
	if called {
		t.Fatal("Window 가 없는데 placer 를 물었다")
	}
}

// FR-SBX-33: 샌드박스 도구는 tools.json 에 기재하지 않는다.
//
// 기재하면 재시작 시 **호스트 셸로** 되살아난다. 백그라운드 도구를 빼는 이유
// (빈 셸로 되살아남)와 같은 자리이되, 이쪽은 격리가 조용히 사라지므로 더 나쁘다.
func TestSaveAll_ExcludesSandboxedTools(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("place 를 POSIX 셸 문법으로 확인한다")
	}
	dir := t.TempDir()
	m := NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)
	m.SetPlacer(func(Placement) (*platform.ProcSpec, error) { return shPlace("SBX"), nil })

	sbx, err := m.Create("", 80, 24, Placement{WindowUUID: "w-sbx", Profile: "scratch"})
	if err != nil {
		t.Fatalf("샌드박스 도구 생성: %v", err)
	}
	defer sbx.kill()
	host, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("호스트 도구 생성: %v", err)
	}
	defer host.kill()

	m.SaveAll()
	blob, err := os.ReadFile(filepath.Join(dir, "tools.json"))
	if err != nil {
		t.Fatalf("tools.json: %v", err)
	}
	if strings.Contains(string(blob), sbx.ID) {
		t.Errorf("샌드박스 도구가 영속됐다 — 재시작 시 호스트 셸로 되살아난다: %s", blob)
	}
	if !strings.Contains(string(blob), host.ID) {
		t.Errorf("호스트 도구가 영속되지 않았다 — 기존 동작이 깨졌다: %s", blob)
	}
}

// FR-SBX-21: 배치기가 아예 꽂히지 않은 서버에서 샌드박스 창의 도구를 만들면
// 실패해야 한다. 여기서 호스트 셸로 내려가는 것이 가장 위험한 강등이다 —
// 사용자는 격리를 요청했고, 실패를 보지 못하면 격리된 줄 안다.
func TestCreate_SandboxWithoutPlacerFails(t *testing.T) {
	m := newTestManager(t)
	tool, err := m.Create("", 80, 24, Placement{WindowUUID: "w1", Profile: "scratch"})
	if err == nil {
		if tool != nil {
			tool.kill()
		}
		t.Fatal("배치기 없이 샌드박스 도구가 떴다")
	}
}

// FR-SBX-27: 샌드박스 창의 도구는 백그라운드로 보낼 수 없다.
//
// 백그라운드 도구는 정의상 "어느 탭에도 매이지 않은" 도구이지만, 샌드박스
// 도구는 컨테이너에 매이고 컨테이너는 Window 에 매인다. 두 소유 관계가 공존하면
// Window 를 닫을 때 돌고 있는 작업을 죽이거나 주인 없는 컨테이너가 남는다.
//
// 명령 경로가 아니라 여기서 막는 것이 요점이다 — dmctl·detach·UI 중 어느
// 경로로 와도 같은 자리를 지난다.
func TestSetBackground_RejectsSandboxedTool(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("place 를 POSIX 셸 문법으로 확인한다")
	}
	m := newTestManager(t)
	m.SetPlacer(func(Placement) (*platform.ProcSpec, error) { return shPlace("SBX"), nil })

	sbx, err := m.Create("", 80, 24, Placement{WindowUUID: "w1", Profile: "scratch"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer sbx.kill()

	if m.SetBackground(sbx.ID, true) {
		t.Error("샌드박스 도구가 백그라운드로 갔다")
	}
	if m.IsBackground(sbx.ID) {
		t.Error("샌드박스 도구가 백그라운드 목록에 올랐다")
	}
}

// 호스트 도구의 백그라운드는 종전대로 동작한다 (NFR-SBX-2).
func TestSetBackground_HostToolUnaffected(t *testing.T) {
	m := newTestManager(t)
	host, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer host.kill()
	if !m.SetBackground(host.ID, true) {
		t.Fatal("호스트 도구의 백그라운드가 막혔다 — 기존 동작이 깨졌다")
	}
}

// 존재하지 않는 작업 디렉터리는 마운트 원본이 될 수 없다.
//
// 컨테이너 런타임은 없는 경로를 -v 로 받으면 **호스트에 그 디렉터리를 만든다**
// (실측). 그러면 오타 하나가 사용자 파일시스템에 빈 디렉터리를 남기고, 도구는
// 정작 다른 곳(홈)에서 뜬다 — StartTool 이 유효하지 않은 cwd 를 홈으로 되돌리기
// 때문이다. 마운트와 도구의 자리가 어긋나느니 마운트하지 않는 편이 낫다.
func TestCreate_InvalidCwdIsNotMounted(t *testing.T) {
	seen, err := capturePlacement(t, filepath.Join(t.TempDir(), "no-such-dir"))
	if err == nil {
		t.Fatal("배치기가 멈췄는데 도구가 떴다")
	}
	if seen.HostDir != "" {
		t.Fatalf("없는 경로가 마운트 원본으로 넘어갔다: %q", seen.HostDir)
	}
}

// 파일을 가리키는 cwd 도 마찬가지다.
func TestCreate_FileCwdIsNotMounted(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	seen, err := capturePlacement(t, file)
	if err == nil {
		t.Fatal("배치기가 멈췄는데 도구가 떴다")
	}
	if seen.HostDir != "" {
		t.Fatalf("파일이 마운트 원본으로 넘어갔다: %q", seen.HostDir)
	}
}

// 실재하는 디렉터리는 그대로 넘어간다.
func TestCreate_ValidCwdIsMounted(t *testing.T) {
	work := t.TempDir()
	seen, err := capturePlacement(t, work)
	if err == nil {
		t.Fatal("배치기가 멈췄는데 도구가 떴다")
	}
	if seen.HostDir != work {
		t.Fatalf("HostDir 이 다르다: %q want %q", seen.HostDir, work)
	}
}

// capturePlacement 는 배치기가 받은 Placement 를 낸다.
//
// 배치기에서 오류를 내 도구를 띄우지 않는 것이 요점이다. 여기서 보려는 것은
// HostDir 계산뿐이고, 셸을 띄우면 그 셸의 경로 때문에 호스트마다 결과가 갈린다.
func capturePlacement(t *testing.T, cwd string) (Placement, error) {
	t.Helper()
	m := newTestManager(t)
	var seen Placement
	m.SetPlacer(func(pl Placement) (*platform.ProcSpec, error) {
		seen = pl
		return nil, errors.New("여기서 멈춘다")
	})
	_, err := m.Create(cwd, 80, 24, Placement{WindowUUID: "w1", Profile: "scratch"})
	return seen, err
}
