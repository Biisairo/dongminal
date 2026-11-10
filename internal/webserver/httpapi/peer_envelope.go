package httpapi

import (
	"fmt"
	"strings"
	"time"
	"unicode"
)

// peerEnvelope 는 다른 노드에서 온 메시지·첫 프롬프트를 감싼다 (PEER_NETWORK_SRS
// FR-PNW-90~92). peerName 은 **이 노드가 저장한 짝 이름**이다 — 보낸 쪽이 주장하는
// 이름을 쓰지 않는다 (FR-PNW-91).
func peerEnvelope(peerName, fromToolID, toToolID, body string, ts time.Time) string {
	return fmt.Sprintf(
		"[DONGMINAL-PEER-MSG from=%s/%s to=%s ts=%s]\n%s\n[/DONGMINAL-PEER-MSG]",
		peerName, envelopeSender(fromToolID), toToolID, ts.Format(envelopeTimeLayout), quoteEnvelope(stripControl(body)),
	)
}

// stripControl 은 원격 본문에서 줄바꿈·탭을 뺀 제어 문자(C0·C1·DEL)를 지운다. 이 글자는
// 터미널에 붙여넣어진다 — ESC 가 남으면 붙여넣기 구간을 끝내는 표지(ESC[201~)로 셸에
// 빠져나갈 수 있다. 서식 문자(Cf: bidi 재정렬·zero-width 등)도 지운다 — 사람이 화면에서
// 글을 다르게 읽게 한다 (리뷰 S-9). 이모지·문자 결합에 쓰는 ZWJ·ZWNJ 만 남긴다.
func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t' || r == '\u200c' || r == '\u200d':
			return r
		case unicode.IsControl(r) || unicode.Is(unicode.Cf, r):
			return -1
		}
		return r
	}, s)
}
