// Package termtext 는 화면·터미널에 찍을 글자의 규칙 한 벌이다 — 숨은 글자의 판정과 정화,
// 줄이기 (REFACTOR3_DEDUP_GO_SRS FR-RDG-43·44). 상대 노드·참가자가 보낸 글자가 터미널에 찍히므로,
// 한 자리만 고쳐지면 다른 자리로 bidi 재정렬·제어 문자가 샌다.
package termtext

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// 지문을 줄여 보이는 길이 둘이다.
//
// FPShown 은 사람이 간선을 가려 보는 화면의 길이다 — Peers 탭(PEER_NETWORK_SRS FR-PNW-80)과
// `dmctl edges` 가 같아야 둘을 맞대 볼 수 있다. FPShort 는 로그와 채팅 온라인 목록의 짧은
// 표시다. 채팅 소켓의 온라인 목록은 와이어이므로 길이를 바꾸면 받는 쪽이 달라진다.
const (
	FPShown = 16
	FPShort = 12
)

// Hidden 은 찍으면 보이지 않거나 화면을 흔드는 글자인가다: 제어 문자와 서식 문자(Cf — bidi
// 재정렬·zero-width).
func Hidden(r rune) bool {
	return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

// Strip 은 Hidden 글자를 지운다. 잘못된 UTF-8 은 U+FFFD 가 된다.
func Strip(s string) string {
	return strings.Map(func(r rune) rune {
		if Hidden(r) {
			return -1
		}
		return r
	}, s)
}

// Line 은 화면·터미널에 찍을 한 줄 문자열인가다: max 바이트 안의 올바른 UTF-8 이고 Hidden
// 글자가 없다.
func Line(s string, max int) bool {
	if len(s) > max || !utf8.ValidString(s) {
		return false
	}
	return !strings.ContainsFunc(s, Hidden)
}

// Cut 은 s 를 n 바이트 안으로 줄인다. 글자 하나를 가르지 않는다.
func Cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
