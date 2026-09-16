package hub

import "encoding/json"

// 판 확인 결과 변화의 SSE (UPDATE_NOTICE_SRS FR-UPD-8a).
//
// **결과를 싣지 않는다.** 받은 브라우저가 `/api/update` 를 다시 물어 자기 시점의
// 값을 얻는다 — `tools_background_changed` 와 같은 규약이다. 실으면 같은 것을
// 두 형태로 나르게 되고, 그 둘이 어긋날 때 어느 쪽이 진실인지 말할 수 없다.
//
// 바뀌었을 때만 나간다 (FR-UPD-8b). 하루에 한 번 바뀌는 값이 연결마다 방송되면
// 그것은 소음이다.
func UpdateChangedPayload() []byte {
	b, _ := json.Marshal(map[string]any{"action": "update_changed"})
	return b
}
