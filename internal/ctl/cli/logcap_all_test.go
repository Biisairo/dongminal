package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// `G2-1`·`SEC-25`(PRODUCTION_ROADMAP §M3) — **로그 상한이 셋 모두에 걸린다.**
//
// 상한 기계(`capLog`)는 이미 있었으나 **서버 로그에만** 걸려 있었다.
// `daemon.log`·`restart.log` 는 무한이었고, 데몬은 서버보다 오래 산다 — 상한이
// 가장 필요한 쪽이 빠져 있었다.

func bigFile(t *testing.T, p string, n int64) {
	t.Helper()
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(n); err != nil {
		t.Fatal(err)
	}
}

// 홈 아래 세 로그가 모두 줄어든다.
func TestCapHomeLogsCoversAllThree(t *testing.T) {
	home := t.TempDir()
	names := []string{"server.log", "daemon.log", "restart.log"}
	for _, n := range names {
		bigFile(t, filepath.Join(home, n), 4096)
	}

	// 상한을 낮춰 잡는다 — 실제 값(64MiB)으로 픽스처를 만들면 검사가 디스크를
	// 192MiB 쓴다 (이 저장소의 관례).
	capHomeLogs(home, 1024, 256)

	for _, n := range names {
		st, err := os.Stat(filepath.Join(home, n))
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		if st.Size() > 1024 {
			t.Errorf("%s 가 %d 바이트로 남았다 — 상한이 걸리지 않았다", n, st.Size())
		}
	}
}

// 상한 아래의 로그는 건드리지 않는다.
func TestCapHomeLogsLeavesSmallFiles(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, "daemon.log")
	bigFile(t, p, 100)

	capHomeLogs(home, 1024, 256)

	st, err := os.Stat(p)
	if err != nil || st.Size() != 100 {
		t.Fatalf("작은 로그가 변했다: size=%v err=%v", st, err)
	}
}

// 없는 홈·없는 파일에서 조용히 지나간다 — 로그 위생 때문에 서버가 서지 않아서는
// 안 된다 (FR-LOG-4).
func TestCapHomeLogsToleratesMissing(t *testing.T) {
	capHomeLogs(filepath.Join(t.TempDir(), "nope"), 1024, 256)
}

// 기본값을 지키는 검사 (이 저장소의 관례) — 낮춰 도는 관례가 값의 회귀를 가린다.
func TestLogCapDefaults(t *testing.T) {
	if LogMaxBytes != 64<<20 {
		t.Errorf("LogMaxBytes=%d", LogMaxBytes)
	}
	if LogKeepBytes != 8<<20 {
		t.Errorf("LogKeepBytes=%d", LogKeepBytes)
	}
}
