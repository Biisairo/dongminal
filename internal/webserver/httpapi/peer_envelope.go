package httpapi

import (
	"fmt"
	"time"
)

// peerEnvelope 는 다른 노드에서 온 메시지·첫 프롬프트를 감싼다 (PEER_NETWORK_SRS
// FR-PNW-90~92). peerName 은 **이 노드가 저장한 짝 이름**이다 — 보낸 쪽이 주장하는
// 이름을 쓰지 않는다 (FR-PNW-91).
func peerEnvelope(peerName, fromToolID, toToolID, body string, ts time.Time) string {
	return fmt.Sprintf(
		"[DONGMINAL-PEER-MSG from=%s/%s to=%s ts=%s]\n%s\n[/DONGMINAL-PEER-MSG]",
		peerName, envelopeSender(fromToolID), toToolID, ts.Format(envelopeTimeLayout), quoteEnvelope(body),
	)
}
