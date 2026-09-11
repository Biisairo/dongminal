package workspace

import (
	"dongminal/internal/shared/dmlog"
	"fmt"
	"os"
	"time"

	"dongminal/internal/shared/platform"
)

// STATE_FILE_DURABILITY_SRS 묶음 Q — 손상 감지·격리·복구.
//
// 종전에는 파싱 실패가 **빈 인덱스로 조용히 지나갔다**. 격리도 복원도 알림도
// 없었고, 그 상태에서 브라우저가 빈 판을 만들어 저장하면 그것이 곧 덮어쓰기였다.

// 적재 결과의 **분류**다 (FR-SFD-14). 경로를 담지 않는다 — 이 값은 헬스로 나가고,
// 헬스 몸통에는 경로·명령·자격을 싣지 않는다 (VERSION_HEALTH_SRS FR-VHL-14).
const (
	// LoadRestored — 읽지 못해 격리했고, 세대에서 되살렸다.
	LoadRestored = "restored"
	// LoadEmpty — 읽지 못했고 되살릴 세대도 없었다. 빈 상태로 시작했다.
	LoadEmpty = "empty"
	// PersistFailed — 마지막 비동기 쓰기가 실패했다 (`GO-10`).
	//
	// 저장은 요청 경로를 막지 않으려고 고루틴으로 떨어지므로, 디스크 쓰기가
	// 실패해도 `Save` 는 이미 성공을 돌려준 뒤다 — **사용자는 저장된 줄 안다.**
	// 그 어긋남을 헬스가 말한다.
	PersistFailed = "write-failed"
)

// Recoverable 은 손상된 파일을 격리하고 세대에서 되살릴 수 있는 저장소다.
//
// `Persister` 를 넓히지 않고 **따로 둔 이유**: 메모리 저장소나 가짜는 파일이
// 없으므로 이 능력이 없다. 없는 쪽을 강제하면 그 구현들이 빈 메서드를 갖게 되고,
// 빈 메서드는 "할 수 없다" 와 "안 했다" 를 구별하지 못한다.
//
// 구현하지 않으면 **종전 동작**이다 — 파싱 실패가 빈 인덱스로 지나간다.
type Recoverable interface {
	// Quarantine 은 지금 파일을 `<파일>.corrupt-<ts>` 로 옮긴다.
	//
	// **덮어쓰지 않고 옮긴다.** 그것이 신고의 증거이기 때문이다 (FR-SFD-10).
	// 자동으로 지우지 않는다 (FR-SFD-11, 사용자 결정).
	Quarantine() error
	// Generations 는 세대의 내용을 **최근 순**으로 준다. 없으면 빈 슬라이스다.
	Generations() [][]byte
}

// Quarantine 은 손상된 파일을 시각 표식과 함께 옮긴다.
func (p FilePersister) Quarantine() error {
	dst := fmt.Sprintf("%s.corrupt-%s", p.Path, time.Now().UTC().Format("20060102T150405Z"))
	return os.Rename(p.Path, dst)
}

// Generations 는 `.bak.1`~`.bak.N` 을 최근 순으로 읽는다. 읽히지 않는 세대는
// **건너뛴다** — 손상이 세대까지 번졌을 수 있고, 그때 멈추면 더 오래된 멀쩡한
// 세대에 닿지 못한다.
func (p FilePersister) Generations() [][]byte {
	var out [][]byte
	for i := 1; i <= platform.StateFileGenerations; i++ {
		blob, err := os.ReadFile(fmt.Sprintf("%s.bak.%d", p.Path, i))
		if err != nil {
			continue
		}
		out = append(out, blob)
	}
	return out
}

// recoverCorrupt 는 읽지 못한 파일을 격리하고 세대에서 되살린다.
//
// 돌려주는 것은 (되살린 내용, 그 인덱스, 분류) 다. 되살리지 못하면 내용은 비고
// 분류는 `LoadEmpty` 다 — **그것도 답이다.** 빈 상태로 시작하는 것은 종전 동작이며
// (FR-SFD-13) 이 문서가 바꾸는 것은 그 사실이 **드러나는가** 이다.
func recoverCorrupt(store Persister) ([]byte, *index, string) {
	rec, ok := store.(Recoverable)
	if !ok {
		// 격리할 수 없는 저장소는 종전대로다 — 빈 인덱스로 지나간다.
		return nil, emptyIndex(), LoadEmpty
	}
	if err := rec.Quarantine(); err != nil {
		dmlog.Errorf(nil, "workspace: 격리 실패: %v", err)
	}
	for _, blob := range rec.Generations() {
		ix, err := buildIndex(blob)
		if err != nil {
			// 세대까지 손상됐을 수 있다. 멈추지 않고 더 오래된 것을 본다.
			continue
		}
		dmlog.Errorf(nil, "workspace: 손상된 파일을 격리하고 백업 세대에서 복원했습니다")
		return append([]byte(nil), blob...), ix, LoadRestored
	}
	dmlog.Errorf(nil, "workspace: 손상된 파일을 격리했으나 복원할 백업 세대가 없습니다")
	return nil, emptyIndex(), LoadEmpty
}
