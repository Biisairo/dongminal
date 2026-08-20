package migrate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func seed(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("seed %s: %v", name, err)
	}
}

func read(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

func TestApply_WritesV2AndBackups(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if rep.Windows != 1 || rep.Tools != 2 {
		t.Errorf("report = %+v, want Windows=1 Tools=2", rep)
	}

	var ws map[string]interface{}
	if err := json.Unmarshal([]byte(read(t, dir, "workspace.json")), &ws); err != nil {
		t.Fatalf("변환된 workspace 파싱: %v", err)
	}
	if _, ok := ws["windows"]; !ok {
		t.Error("workspace.json 에 windows 없음")
	}
	if v, _ := ws["schemaVersion"].(float64); int(v) != SchemaVersion {
		t.Errorf("schemaVersion = %#v", ws["schemaVersion"])
	}

	if !exists(dir, "tools.json") {
		t.Error("tools.json 미생성")
	}
	if !exists(dir, "workspace.json.v1.bak") {
		t.Error("workspace 백업 미생성")
	}
	if !exists(dir, "panes.json.v1.bak") {
		t.Error("panes 백업 미생성")
	}
	// panes.json 은 백업으로 이동되어 stale 파일이 남지 않아야 한다.
	if exists(dir, "panes.json") {
		t.Error("panes.json 이 남아 있음 — stale 파일")
	}
}

func TestApply_BackupPreservesOriginal(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)

	if _, err := Apply(dir, false); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := read(t, dir, "workspace.json.v1.bak"); got != v1Basic {
		t.Errorf("백업이 원본과 다름:\n%s", got)
	}
	if got := read(t, dir, "panes.json.v1.bak"); got != panesBasic {
		t.Errorf("panes 백업이 원본과 다름:\n%s", got)
	}
}

func TestApply_DoesNotClobberExistingBackup(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)
	if _, err := Apply(dir, false); err != nil {
		t.Fatalf("1차 Apply: %v", err)
	}
	// 2차 실행: 이미 v2 이며 백업을 덮어써서는 안 된다.
	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("2차 Apply: %v", err)
	}
	if !rep.AlreadyMigrated {
		t.Error("2차 Apply 가 AlreadyMigrated 를 보고하지 않음")
	}
	if got := read(t, dir, "workspace.json.v1.bak"); got != v1Basic {
		t.Errorf("2차 실행이 백업을 덮어썼음:\n%s", got)
	}
}

func TestApply_DryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)

	rep, err := Apply(dir, true)
	if err != nil {
		t.Fatalf("Apply dry-run: %v", err)
	}
	if rep.Windows != 1 {
		t.Errorf("dry-run 리포트 미산출: %+v", rep)
	}
	if got := read(t, dir, "workspace.json"); got != v1Basic {
		t.Error("dry-run 이 workspace.json 을 변경했음")
	}
	if exists(dir, "tools.json") || exists(dir, "workspace.json.v1.bak") {
		t.Error("dry-run 이 파일을 생성했음")
	}
	if !exists(dir, "panes.json") {
		t.Error("dry-run 이 panes.json 을 이동했음")
	}
}

func TestApply_MissingFilesIsNoop(t *testing.T) {
	dir := t.TempDir()
	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !rep.Empty {
		t.Errorf("빈 홈에서 Empty 가 false: %+v", rep)
	}
	if exists(dir, "workspace.json") || exists(dir, "tools.json") {
		t.Error("빈 홈에 파일이 생성됨")
	}
}

func TestApply_WorkspaceOnlyNoPanes(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if rep.Windows != 1 {
		t.Errorf("Windows = %d, want 1", rep.Windows)
	}
	if exists(dir, "tools.json") {
		t.Error("panes.json 이 없는데 tools.json 이 생성됨")
	}
	if !exists(dir, "workspace.json.v1.bak") {
		t.Error("workspace 백업 미생성")
	}
}

func TestApply_InvalidJSONLeavesFilesUntouched(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", `{"sessions":`)
	seed(t, dir, "panes.json", panesBasic)

	if _, err := Apply(dir, false); err == nil {
		t.Fatal("깨진 JSON 에 오류가 없음")
	}
	if got := read(t, dir, "workspace.json"); got != `{"sessions":` {
		t.Error("실패 후 workspace.json 이 변경됐음")
	}
	if exists(dir, "tools.json") || exists(dir, "workspace.json.v1.bak") {
		t.Error("실패 후 산출물이 남았음")
	}
	if !exists(dir, "panes.json") {
		t.Error("실패 후 panes.json 이 이동됐음")
	}
}

// 재실행 시 panes.json 은 이미 백업으로 이동했으므로, 도구 컬렉션은
// tools.json 에서 읽어야 한다. 그러지 않으면 리포트가 Tool 0개 +
// 깨진 참조 전량으로 잘못 산출된다.
func TestApply_RerunReadsToolsJSON(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)
	if _, err := Apply(dir, false); err != nil {
		t.Fatalf("1차 Apply: %v", err)
	}
	toolsBefore := read(t, dir, "tools.json")

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("2차 Apply: %v", err)
	}
	if rep.Tools != 2 {
		t.Errorf("2차 Report.Tools = %d, want 2", rep.Tools)
	}
	if len(rep.BrokenRefs) != 0 {
		t.Errorf("2차 Report.BrokenRefs = %v, want 없음", rep.BrokenRefs)
	}
	if len(rep.Orphans) != 0 {
		t.Errorf("2차 Report.Orphans = %v, want 없음", rep.Orphans)
	}
	if got := read(t, dir, "tools.json"); got != toolsBefore {
		t.Errorf("2차 실행이 tools.json 을 변경했음\n전: %s\n후: %s", toolsBefore, got)
	}
}
