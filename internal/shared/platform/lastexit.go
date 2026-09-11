package platform

import (
	"os"
	"path/filepath"
	"strings"
)

// 크래시 마커 (OBSERVABILITY_SRS 묶음 C · M5 `G2-6`).
//
// 기동이 정상 종료 뒤였는지 강제 종료 뒤였는지 알 방법이 없었다. 그 사실은
// "내 창이 왜 사라졌는가" 류의 신고에서 가장 먼저 필요한 값이다 — 워크스페이스
// 손상과 강제 종료는 증상이 같고 조치가 다르다.
//
// **읽기는 판정만 한다.** 덮는 것은 부르는 쪽의 일이다 — 그래야 같은 기동에서
// 두 번 읽어도 답이 같고, 진단이 나중에 다시 물어도 같은 답을 받는다.

// LastExitFile 은 마커가 사는 자리다. `<home>` 아래이며 `doctor --bundle` 이
// 이것을 집는다 (FR-OBS-17) — 번들은 이미 있고 마스킹도 한 벌이다.
const LastExitFile = ".lastexit"

const (
	markRunning = "running"
	markClean   = "clean"
)

// LastExit 은 마지막 종료에 대한 판정이다.
type LastExit struct {
	// Crashed 는 마지막 기동이 정상 종료 경로를 지나지 않았다는 뜻이다.
	Crashed bool
	// First 는 마커가 아직 없다는 뜻이다 — **비정상이 아니다** (FR-OBS-16).
	First bool
	// Raw 는 파일에 있던 내용이다. 진단이 그대로 싣는다.
	Raw string
}

func lastExitPath(home string) string { return filepath.Join(home, LastExitFile) }

// ReadLastExit 은 마커를 읽어 판정한다. 파일을 고치지 않는다.
//
// 알 수 없는 내용은 **비정상으로 보지 않는다.** 손으로 고친 파일 하나가 매
// 기동마다 거짓 경보를 내면 그 경보는 곧 무시되고, 그때는 진짜 크래시도 함께
// 묻힌다.
func ReadLastExit(home string) LastExit {
	if home == "" {
		return LastExit{First: true}
	}
	data, err := os.ReadFile(lastExitPath(home))
	if err != nil {
		// 읽지 못한 것과 없는 것을 가르지 않는다. 둘 다 "모른다" 이고,
		// 모르는 것을 비정상으로 보면 거짓 경보가 된다.
		return LastExit{First: true}
	}
	raw := strings.TrimSpace(string(data))
	return LastExit{Crashed: raw == markRunning, Raw: raw}
}

// MarkRunning 은 기동 직후에 부른다. 이 뒤로 정상 종료 경로를 지나지 않으면
// 다음 기동이 그것을 본다.
//
// **실패를 돌려주지 않는다.** 마커를 쓰지 못하는 것이 기동을 막을 이유는 아니고,
// 그때 잃는 것은 다음 기동의 판정 하나뿐이다.
func MarkRunning(home string) { writeMark(home, markRunning) }

// MarkCleanExit 은 정상 종료 경로에서 부른다.
func MarkCleanExit(home string) { writeMark(home, markClean) }

func writeMark(home, s string) {
	if home == "" {
		return
	}
	// 세대를 남기지 않는다 — 이 파일은 한 글자짜리 사실이고, 잃어도 다음
	// 기동에서 다시 세워진다. `WriteStateFile` 의 세대는 되돌릴 값이 있는
	// 파일의 것이다.
	_ = os.WriteFile(lastExitPath(home), []byte(s), 0o600)
}
