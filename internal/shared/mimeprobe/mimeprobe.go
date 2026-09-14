// Package mimeprobe 는 **바이트의 앞머리로 그림인지**를 판정한다.
//
// 판정이 한 벌인 것이 요점이다. 이 판정이 참이면 그 바이트가 추론된 MIME 으로
// **우리 출처에서 인라인으로** 나가고, 그 자리가 두 벌이면 한쪽만 고쳐진 채
// 남는다 — 저장형 XSS 의 길이 그렇게 열린다.
//
// 지금 이것을 지나는 자리는 둘이다: 파일 종단(`/api/file/raw`, DOC_RENDER_VIEW_SRS
// FR-DRV-24)과 git 블롭 종단(`/api/git/blob`, M9_SRS FR-M9-21).
package mimeprobe

import (
	"bytes"
	"net/http"
)

// SniffLen 은 판정에 쓰는 앞머리의 길이다. `http.DetectContentType` 이 보는
// 만큼이며, 그보다 더 읽어도 판정이 달라지지 않는다.
const SniffLen = 512

// SVGMime 은 SVG 가 나갈 때의 MIME 이다. 추론에 맡기지 않는다 —
// `http.DetectContentType` 은 SVG 를 `text/plain` 으로 본다.
const SVGMime = "image/svg+xml"

// ImageMime 은 앞머리가 **그림이면** 그 MIME 을, 아니면 빈 문자열을 준다.
//
// 확장자는 근거가 아니다 (FR-EVW-2). `.txt` 로 저장된 PNG 도 확장자 없는
// 스크립트도 흔하고, 확장자를 믿으면 전자는 깨진 글자로 열리고 후자는 열리지
// 않는다.
//
// **SVG 는 따로 본다.** 그것은 이미지이면서 문서인 유일한 형식이라
// `DetectContentType` 이 `text/plain` 으로 주며, 그래서 다른 것들에는 없는
// 잠금장치가 함께 가야 한다 (`Content-Security-Policy: sandbox`).
func ImageMime(head []byte) string {
	sniff := head
	if len(sniff) > SniffLen {
		sniff = sniff[:SniffLen]
	}
	if m := http.DetectContentType(sniff); bytes.HasPrefix([]byte(m), []byte("image/")) {
		return m
	}
	if LooksLikeSVG(head) {
		return SVGMime
	}
	return ""
}

// LooksLikeSVG 는 **내용으로** SVG 를 판정한다 (FR-DRV-24 ①).
//
// 확장자를 믿지 않는 근거는 FR-EVW-2 와 같고, 여기서는 더 무겁다 — 이 판정이
// 참이면 그 바이트가 `image/svg+xml` 로 우리 출처에서 나간다. `.svg` 로 이름만
// 바꾼 HTML 이 통과하면 확장자 하나가 저장형 XSS 의 길이 된다.
//
// XML 선언·주석·DOCTYPE 을 건너뛰고 **루트 요소가 `<svg`인지**를 본다. 대문자를
// 받지 않는 것은 XML 이 대소문자를 가리기 때문이다 — `<SVG` 는 SVG 가 아니며,
// 그것을 받아 주는 쪽은 HTML 파서다.
func LooksLikeSVG(head []byte) bool {
	b := bytes.TrimLeft(head, "\xef\xbb\xbf \t\r\n")
	for len(b) > 0 {
		switch {
		case bytes.HasPrefix(b, []byte("<?")):
			i := bytes.Index(b, []byte("?>"))
			if i < 0 {
				return false
			}
			b = b[i+2:]
		case bytes.HasPrefix(b, []byte("<!--")):
			i := bytes.Index(b, []byte("-->"))
			if i < 0 {
				return false
			}
			b = b[i+3:]
		case bytes.HasPrefix(b, []byte("<!")):
			i := bytes.IndexByte(b, '>')
			if i < 0 {
				return false
			}
			b = b[i+1:]
		default:
			if !bytes.HasPrefix(b, []byte("<svg")) {
				return false
			}
			// `<svgfoo` 를 배제한다 — 요소 이름은 여기서 끝나야 한다.
			if len(b) == 4 {
				return true
			}
			switch b[4] {
			case ' ', '\t', '\r', '\n', '>', '/':
				return true
			}
			return false
		}
		b = bytes.TrimLeft(b, " \t\r\n")
	}
	return false
}
