package hub

import (
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

import (
	"dongminal/internal/webserver/sse"
	"time"
)

// ForegroundInterval 은 전경 이름 조회를 돌리는 주기다 (CONVENIENCE_SRS FR-TAN-8).
// toolhub 쪽 캐시와 같은 값이다 — 더 자주 돌리면 캐시가 반사하고, 더 드물게 돌리면
// 이름이 늦게 따라온다.
const ForegroundInterval = toolhub.ForegroundRefreshInterval

// toolForegroundPayload builds the tool_foreground SSE event body broadcast via
// CommandHub. Server-published only (not in allowedCmdActions). Keys are
// lowerCamelCase. name 이 빈 문자열이면 전경 프로그램이 없다는 뜻이며, 브라우저는
// 그때 기본 이름으로 되돌린다 (FR-TAN-12).
func toolForegroundPayload(toolID, name string) []byte {
	return sse.Payload("tool_foreground", map[string]any{"toolId": toolID, "name": name})
}

// BroadcastForeground 는 전경 이름 변화를 SSE 로 내보내는 콜백이다. 데몬 모드는
// PTY 를 dongminald 가 들고 있어 변화가 IPC push 로 오므로, 그 콜백
// (toolclient.ToolClient.OnForeground)에 이것을 꽂는다 (FR-TAN-7).
func BroadcastForeground(hub CommandBroker) func(toolID, name string) {
	return func(toolID, name string) { hub.Broadcast(toolForegroundPayload(toolID, name)) }
}

// WireForeground connects foreground process name transitions to SSE broadcasts.
// Called from the composition root once both the toolhub.ToolManager and
// CommandHub exist — direct mode only; the daemon-mode equivalent is
// BroadcastForeground on the IPC push.
//
// SetForegroundNotifier 는 **값이 바뀌었을 때만** 부르는 계약이다 (FR-TAN-9).
// 그 위에 중복 억제를 다시 쌓지 않는다.
func WireForeground(pm *toolhub.ToolManager, hub CommandBroker) {
	pm.SetForegroundNotifier(BroadcastForeground(hub))
}

// StartForegroundPoll 은 전경 조회를 돌리는 주체다. 틱마다 `List()` 를 부르고,
// direct 모드에서는 그것이 ToolManager.ForegroundNames() 를 부른다. 값이 바뀐
// 도구에 대해서만 notifier 가 뜬다. 틱은 배선이 만든다 (TEST-8).
//
// 데몬 모드에서 전경 티커를 도는 데몬(toolipc.FeatureForegroundTick)에는 아무것도
// 하지 않는다 (FR-OPT-2-1) — 조회는 데몬이 스스로 돌리고 바뀐 것을 push 한다. 그
// 기능을 말하지 않는 옛 데몬에는 종전대로 `list` RPC 로 조회를 시킨다. 판정은 틱마다
// 한다 — 재접속하면 상대 데몬이 바뀔 수 있다.
//
// > 티커가 있는 이유. FR-TAN-8 은 "기존 도구 상태 폴링에 편승한다"고 하지만
// > 편승할 주기 폴링이 실재하지 않는다 — /api/tools/activity 는 도구 목록을 싣지
// > 않고 에이전트 패널이 열려 있을 때만 돈다. 조회를 돌리는 주체가 없으면
// > SetForegroundNotifier 가 영영 뜨지 않아 기능이 죽은 채로 선다. C-3 이 막는
// > 것은 **브라우저의 새 요청**이며(V-TAN-18), 그것은 늘지 않는다.
func StartForegroundPoll(tools toolhub.ToolHub, stopCh <-chan struct{}, tick <-chan time.Time) {
	if tools == nil {
		return
	}
	go func() {
		for {
			select {
			case <-tick:
				if d := tools.Daemon(); d != nil && d.HasFeature(toolipc.FeatureForegroundTick) {
					continue
				}
				tools.List()
			case <-stopCh:
				return
			}
		}
	}()
}
