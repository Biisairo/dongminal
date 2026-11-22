package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// TC-ATF-59 (FR-ATF-59, D-ATF-7): 검사용 임시 bin 을 만들지 못하면 doctor 는 오류로 끝나고,
// 운영 홈의 bin 으로 대신하지 않는다 (FR-HLI-5).
func TestDoctorProbeBinFailureDoesNotTouchHome(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "없음")
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(k, missing)
	}
	home := t.TempDir()
	var out, errOut strings.Builder
	if code := RunDoctor(DoctorOpts{Common: Common{Home: home}}, &out, &errOut); code != 1 {
		t.Fatalf("종료 코드 = %d", code)
	}
	if !strings.Contains(out.String(), "임시 bin") {
		t.Fatalf("실패 안내가 없다: %s", out.String())
	}
	if _, err := os.Stat(filepath.Join(home, dmenv.BinDir)); !os.IsNotExist(err) {
		t.Fatalf("운영 홈의 bin 을 건드렸다: %v", err)
	}
}
