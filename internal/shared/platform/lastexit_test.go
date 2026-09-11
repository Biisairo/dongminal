package platform_test

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/platform"
)

// OBSERVABILITY_SRS §4.4 — 크래시 마커 (TC-OBS-12~14).

// TC-OBS-12: 마커가 `running` 인 채 기동하면 **비정상 종료**다.
func TestLastExitDetectsCrash(t *testing.T) {
	home := t.TempDir()
	platform.MarkRunning(home)

	st := platform.ReadLastExit(home)
	if !st.Crashed {
		t.Fatalf("비정상 종료를 잡지 못했다: %+v", st)
	}
	if st.First {
		t.Error("첫 기동으로 읽혔다")
	}
}

// TC-OBS-13: `clean` 이면 정상이다.
func TestLastExitCleanShutdown(t *testing.T) {
	home := t.TempDir()
	platform.MarkRunning(home)
	platform.MarkCleanExit(home)

	st := platform.ReadLastExit(home)
	if st.Crashed {
		t.Errorf("정상 종료를 비정상으로 읽었다: %+v", st)
	}
	if st.First {
		t.Error("첫 기동이 아니다")
	}
}

// TC-OBS-14: 파일이 없으면 **첫 기동**이며 비정상이 아니다 (FR-OBS-16).
func TestLastExitFirstBoot(t *testing.T) {
	st := platform.ReadLastExit(t.TempDir())
	if st.Crashed {
		t.Error("첫 기동을 비정상으로 읽었다")
	}
	if !st.First {
		t.Error("첫 기동으로 읽히지 않았다")
	}
}

// 읽기는 **판정만** 한다 — 덮는 것은 부르는 쪽의 일이다. 그래야 같은 기동에서
// 두 번 읽어도 답이 같다.
func TestReadLastExitDoesNotMutate(t *testing.T) {
	home := t.TempDir()
	platform.MarkRunning(home)
	first := platform.ReadLastExit(home)
	second := platform.ReadLastExit(home)
	if first.Crashed != second.Crashed || first.First != second.First {
		t.Errorf("두 번 읽으니 답이 갈렸다: %+v vs %+v", first, second)
	}
}

// 알 수 없는 내용은 **비정상으로 보지 않는다.** 손으로 고친 파일 하나가 매
// 기동마다 거짓 경보를 내면 그 경보는 곧 무시된다.
func TestLastExitUnknownContent(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".lastexit"), []byte("뭐지"), 0o600); err != nil {
		t.Fatal(err)
	}
	if st := platform.ReadLastExit(home); st.Crashed {
		t.Error("알 수 없는 내용을 비정상으로 읽었다")
	}
}

// 마커가 실제로 홈 아래 그 이름으로 놓인다 — 번들이 그것을 집는다 (FR-OBS-17).
func TestLastExitFileName(t *testing.T) {
	home := t.TempDir()
	platform.MarkRunning(home)
	if _, err := os.Stat(filepath.Join(home, platform.LastExitFile)); err != nil {
		t.Fatalf("마커 파일이 없다: %v", err)
	}
}
