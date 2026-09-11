package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// STATE_FILE_DURABILITY_SRS 묶음 Q — 손상 감지·격리·복구 (V-SFD-10~14).
//
// 종전에는 파싱 실패가 **빈 인덱스로 조용히 지나갔다**(`manager.go` 의
// `ix = emptyIndex()`). 격리도 복원도 알림도 없었고, 그 상태에서 브라우저가 빈
// 판을 만들어 저장하면 그것이 곧 덮어쓰기였다.

func newFileManager(t *testing.T, dir string) (*Manager, error) {
	t.Helper()
	return New(nil, FilePersister{Path: filepath.Join(dir, "workspace.json")})
}

func writeFile(t *testing.T, p, body string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func corruptCopies(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		if strings.Contains(e.Name(), ".corrupt-") {
			out = append(out, e.Name())
		}
	}
	return out
}

const goodWS = `{"schemaVersion":2,"windows":[]}`

// V-SFD-10: 읽히지 않는 파일은 **격리한다** — 덮어쓰지 않고 옮긴다. 그것이
// 신고의 증거이기 때문이다 (FR-SFD-10).
func TestCorruptWorkspaceIsQuarantined(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "workspace.json")
	writeFile(t, p, "{ this is not json")

	m, err := newFileManager(t, d)
	if err != nil {
		t.Fatalf("손상된 파일로 기동이 깨졌다: %v", err)
	}
	t.Cleanup(func() { m.Close() })

	if got := corruptCopies(t, d); len(got) != 1 {
		t.Fatalf(".corrupt-<ts> 사본이 %d 개다 — 격리되지 않았다 (FR-SFD-10)", len(got))
	}
}

// V-SFD-11·13: 격리 뒤 **최근 세대부터** 복원한다 (FR-SFD-12).
func TestCorruptWorkspaceRestoresFromGeneration(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "workspace.json")
	writeFile(t, p, "{ broken")
	writeFile(t, p+".bak.1", goodWS)

	m, err := newFileManager(t, d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	if got := string(m.Raw()); got != goodWS {
		t.Fatalf("현재 판=%q — 세대에서 복원되지 않았다 (FR-SFD-12)", got)
	}
	if m.LoadErr() != LoadRestored {
		t.Fatalf("LoadErr=%q want %q", m.LoadErr(), LoadRestored)
	}
}

// 읽히지 않는 세대는 건너뛰고 다음 것을 본다.
func TestCorruptWorkspaceSkipsBadGeneration(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "workspace.json")
	writeFile(t, p, "{ broken")
	writeFile(t, p+".bak.1", "{ also broken")
	writeFile(t, p+".bak.2", goodWS)

	m, err := newFileManager(t, d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	if got := string(m.Raw()); got != goodWS {
		t.Fatalf("현재 판=%q — 두 번째 세대를 보지 않았다", got)
	}
}

// V-SFD-12: 복원할 세대가 하나도 없으면 **빈 상태**이고 그 사실이 남는다
// (FR-SFD-13·14).
func TestCorruptWorkspaceWithNoGenerationIsEmpty(t *testing.T) {
	d := t.TempDir()
	writeFile(t, filepath.Join(d, "workspace.json"), "{ broken")

	m, err := newFileManager(t, d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	if m.LoadErr() != LoadEmpty {
		t.Fatalf("LoadErr=%q want %q", m.LoadErr(), LoadEmpty)
	}
}

// 정상 파일은 아무 일도 일어나지 않는다 (회귀).
func TestHealthyWorkspaceIsUntouched(t *testing.T) {
	d := t.TempDir()
	writeFile(t, filepath.Join(d, "workspace.json"), goodWS)

	m, err := newFileManager(t, d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	if m.LoadErr() != "" {
		t.Errorf("LoadErr=%q — 멀쩡한 파일에 사유가 붙었다", m.LoadErr())
	}
	if got := corruptCopies(t, d); len(got) != 0 {
		t.Errorf("멀쩡한 파일이 격리됐다: %v", got)
	}
}

// V-SFD-14: **상위 스키마는 거부한다** (FR-SFD-15).
//
// 종전에는 `<` 만 봤다. 상위 판은 이 코드가 모르는 필드를 담고 있는데도 통과했고,
// 읽고 모르는 것을 버리고 저장하면 그 순간 **다운그레이드 손실**이다.
//
// 격리하지 않는다 — 그 파일은 손상된 것이 아니라 **더 새로운 것**이다.
func TestSchemaTooNewIsRejected(t *testing.T) {
	d := t.TempDir()
	writeFile(t, filepath.Join(d, "workspace.json"), `{"schemaVersion":3,"windows":[]}`)

	m, err := newFileManager(t, d)
	if err == nil {
		m.Close()
		t.Fatal("상위 스키마가 조용히 읽혔다 (FR-SFD-15)")
	}
	if got := corruptCopies(t, d); len(got) != 0 {
		t.Errorf("더 새로운 파일을 손상본으로 격리했다: %v", got)
	}
}
