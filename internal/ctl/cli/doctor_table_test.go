package cli

import (
	"testing"

	"dongminal/internal/shared/platform"
)

// M8 D-A-11 (GO-20): 진단 항목은 표다 — RunDoctor 가 그 순서대로 돈다. 순서가
// 계약인 이유는 앞 항목이 뒤 항목의 전제이기 때문이다(설치 뒤에 헬퍼·셸·터미널).
func TestDoctorChecks_TableOrderIsTheContract(t *testing.T) {
	checks := doctorChecks(platform.Current(), t.TempDir(), t.TempDir())
	want := []string{"환경", "설치", "설치된 헬퍼", "셸", "터미널", "도구", "콘솔 없는 자식", "IPC", "프로세스"}
	if len(checks) != len(want) {
		t.Fatalf("항목 수 %d, want %d", len(checks), len(want))
	}
	for i, c := range checks {
		if c.name != want[i] {
			t.Fatalf("[%d] = %q, want %q", i, c.name, want[i])
		}
		if c.run == nil {
			t.Fatalf("[%d] %q 의 run 이 없다", i, c.name)
		}
	}
}
