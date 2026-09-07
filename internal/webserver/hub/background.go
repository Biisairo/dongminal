package hub

import (
	"encoding/json"

	"dongminal/internal/shared/toolhub"
)

// 백그라운드 목록 변화의 SSE (UX_BATCH6_SRS FR-BGP-2).
//
// 종전에 이 사건을 내는 자리는 헤드리스 생성 하나뿐이었다
// (`handlers_runs_headless.go`). 그래서 `detach` 로 보낸 도구도, 프로세스가 끝나
// 사라진 도구도 **다른 브라우저의 배지에 그대로 남았다** — 그쪽은 SSE 재연결
// 전까지 자기 행동만 알기 때문이다.
//
// 배선이 attention·activity 와 같은 모양인 것은 같은 종류의 사실이기 때문이다:
// toolhub 가 사실을 내고, 여기가 그것을 브라우저의 말로 옮긴다.

// BackgroundChangedPayload 는 **목록을 싣지 않는다.** 받은 브라우저가
// `/api/tools/background` 를 다시 물어 자기 시점의 목록을 얻는다 (FR-BGV-1 의
// 종전 규약 그대로) — 목록을 실으면 같은 것을 두 형태로 나르게 되고, 그 둘이
// 어긋날 때 어느 쪽이 진실인지 말할 수 없다.
func BackgroundChangedPayload() []byte {
	b, _ := json.Marshal(map[string]any{"action": "tools_background_changed"})
	return b
}

// WireBackground 는 백그라운드 목록 변화를 SSE 로 잇는다 (FR-BGP-2).
func WireBackground(pm *toolhub.ToolManager, hub CommandBroker) {
	pm.SetBackgroundChanged(func() {
		hub.Broadcast(BackgroundChangedPayload())
	})
}
