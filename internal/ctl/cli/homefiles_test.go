package cli

import (
	"reflect"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// FR-OPT-10-2 (SHR-19): rollbackTargets 는 표에서 파생한다 — 손으로 다시 적은
// 목록은 표가 바뀔 때 따라오지 않는다. 순서도 표의 것이다 (안내 문구가 그 순서로 찍힌다).
func TestRollbackTargetsFromLayout(t *testing.T) {
	var want []string
	for _, e := range homeLayout() {
		if e.Rollback {
			if e.IsDir || !e.InBackup {
				t.Errorf("%s: 되돌리기 대상은 백업에 담기는 파일이어야 한다", e.Name)
			}
			want = append(want, e.Name)
		}
	}
	if !reflect.DeepEqual(rollbackTargets, want) {
		t.Fatalf("rollbackTargets = %v, 표에서 파생 = %v", rollbackTargets, want)
	}
	if !reflect.DeepEqual(want, []string{"workspace.json", "settings.json", "access.json", "runs.json", "tools.json"}) {
		t.Fatalf("되돌리기 대상이 바뀌었다: %v", want)
	}
	if defaultRollbackTarget != dmenv.WorkspaceFile {
		t.Fatalf("defaultRollbackTarget = %q", defaultRollbackTarget)
	}
}
