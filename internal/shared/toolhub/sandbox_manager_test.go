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
	m := NewToolManager(t.TempDir(), nil)
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
	m := NewToolManager(t.TempDir(), nil)
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
	m := NewToolManager(t.TempDir(), nil)
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
	m := NewToolManager(t.TempDir(), nil)
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
	m := NewToolManager(t.TempDir(), nil)
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
	m := NewToolManager(t.TempDir(), nil)
	host, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer host.kill()
	if !m.SetBackground(host.ID, true) {
		t.Fatal("호스트 도구의 백그라운드가 막혔다 — 기존 동작이 깨졌다")
	}
}
