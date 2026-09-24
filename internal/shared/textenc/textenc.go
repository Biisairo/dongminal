// Package textenc 는 텍스트 파일의 인코딩 판별·엄격 디코드·재인코딩이다
// (REPO_FIX 03 §3A-1·3A-2·3A-3).
//
// 편집기의 파일 읽기·저장과 git diff 의 양쪽이 같은 규칙을 써야 한다 — 두 벌이면
// 한쪽에서 CP949 로 연 파일이 다른 쪽에서 깨진 글자로 비교된다.
//
// **조용한 손실이 없다.** 엄격 디코드는 치환 문자 없이 풀리고 다시 인코딩했을 때
// 원문과 바이트가 같아야 성공이다. 재인코딩은 표현할 수 없는 첫 문자의 위치를
// 돌려주고 아무것도 쓰지 않는다.
package textenc

import (
	"bytes"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/unicode"
)

// 인코딩 id — HTTP 헤더·요청 필드·git diff side 응답이 같은 문자열을 쓴다.
const (
	UTF8     = "utf-8"
	UTF16LE  = "utf-16le"
	UTF16BE  = "utf-16be"
	CP949    = "cp949"
	ShiftJIS = "shift_jis"
	Win1252  = "windows-1252"
)

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// win1252Undefined 는 Windows-1252 에 정의되지 않은 바이트다 — 디코더가 C1 제어
// 문자로 통과시키지만 그 파일이 1252 라는 근거가 아니다.
var win1252Undefined = []byte{0x81, 0x8D, 0x8F, 0x90, 0x9D}

func codec(id string) encoding.Encoding {
	switch id {
	case UTF16LE:
		return unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
	case UTF16BE:
		return unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
	case CP949:
		return korean.EUCKR // CP949(UHC) 상위집합
	case ShiftJIS:
		return japanese.ShiftJIS
	case Win1252:
		return charmap.Windows1252
	}
	return nil
}

// Valid 는 id 가 이 패키지가 아는 인코딩인가다.
func Valid(id string) bool { return id == UTF8 || codec(id) != nil }

// Decoded 는 판별·디코드의 결과다. Text 는 BOM 을 뗀 UTF-8 이다.
type Decoded struct {
	Text      string
	Enc       string
	BOM       bool
	Decodable bool
}

// HasUTF16BOM 은 UTF-16 BOM 으로 시작하는가다 — UTF-32LE BOM(FF FE 00 00)은 아니다.
// probe 가 NUL 검사 전에 이것을 본다.
func HasUTF16BOM(b []byte) bool {
	if bytes.HasPrefix(b, bomUTF16BE) {
		return true
	}
	return bytes.HasPrefix(b, bomUTF16LE) && !bytes.HasPrefix(b, []byte{0xFF, 0xFE, 0, 0})
}

// Detect 는 §3A-1 순서로 판별한다: BOM → 유효한 UTF-8 → CP949 엄격 디코드 → 실패.
// 실패면 Decodable=false 이고 Text 는 UTF-8 치환 디코드다.
func Detect(b []byte) Decoded {
	switch {
	case bytes.HasPrefix(b, bomUTF8):
		if d, ok := DecodeAs(b, UTF8); ok {
			return d
		}
	case HasUTF16BOM(b) && bytes.HasPrefix(b, bomUTF16LE):
		if d, ok := DecodeAs(b, UTF16LE); ok {
			return d
		}
	case HasUTF16BOM(b):
		if d, ok := DecodeAs(b, UTF16BE); ok {
			return d
		}
	}
	if utf8.Valid(b) {
		return Decoded{Text: string(b), Enc: UTF8, Decodable: true}
	}
	if d, ok := DecodeAs(b, CP949); ok {
		return d
	}
	return Decoded{Text: strings.ToValidUTF8(string(b), "�"), Enc: UTF8}
}

// DecodeAs 는 id 로 엄격 디코드한다. 그 인코딩의 BOM 으로 시작하면 떼고 BOM=true.
// 치환 문자가 생기거나 다시 인코딩한 바이트가 원문과 다르면 실패다.
func DecodeAs(b []byte, id string) (Decoded, bool) {
	body, bom := b, false
	switch id {
	case UTF8:
		if bytes.HasPrefix(b, bomUTF8) {
			body, bom = b[len(bomUTF8):], true
		}
		if !utf8.Valid(body) {
			return Decoded{}, false
		}
		return Decoded{Text: string(body), Enc: UTF8, BOM: bom, Decodable: true}, true
	case UTF16LE:
		if bytes.HasPrefix(b, bomUTF16LE) {
			body, bom = b[2:], true
		}
	case UTF16BE:
		if bytes.HasPrefix(b, bomUTF16BE) {
			body, bom = b[2:], true
		}
	case Win1252:
		// ContainsAny 는 룬으로 비교하므로(잘못된 바이트는 모두 U+FFFD) 바이트로 본다.
		for _, u := range win1252Undefined {
			if bytes.IndexByte(b, u) >= 0 {
				return Decoded{}, false
			}
		}
	}
	c := codec(id)
	if c == nil {
		return Decoded{}, false
	}
	text, err := c.NewDecoder().Bytes(body)
	if err != nil || bytes.ContainsRune(text, utf8.RuneError) {
		return Decoded{}, false
	}
	back, err := c.NewEncoder().Bytes(text)
	if err != nil || !bytes.Equal(back, body) {
		return Decoded{}, false
	}
	return Decoded{Text: string(text), Enc: id, BOM: bom, Decodable: true}, true
}

// Unmappable 은 대상 인코딩으로 표현할 수 없는 첫 문자다. Line 은 1-기준, Col 은
// 1-기준 UTF-16 코드 단위(편집기의 열과 같다).
type Unmappable struct {
	Line int    `json:"line"`
	Col  int    `json:"col"`
	Char string `json:"char"`
}

// Encode 는 text 를 id 로 인코딩한다. UTF-8 은 bom 이면 BOM 을 붙이고, UTF-16 은
// 언제나 그 순서의 BOM 을 붙인다(모든 문자를 표현하므로 거절이 없다). 그 밖의
// 인코딩은 표현할 수 없는 문자가 있으면 첫 위치를 돌려주고 바이트는 nil 이다.
func Encode(text, id string, bom bool) ([]byte, *Unmappable, error) {
	switch id {
	case UTF8:
		if bom {
			return append(append([]byte{}, bomUTF8...), text...), nil, nil
		}
		return []byte(text), nil, nil
	case UTF16LE, UTF16BE:
		out, err := codec(id).NewEncoder().Bytes([]byte(text))
		if err != nil {
			return nil, nil, err
		}
		head := bomUTF16LE
		if id == UTF16BE {
			head = bomUTF16BE
		}
		return append(append([]byte{}, head...), out...), nil, nil
	}
	c := codec(id)
	if c == nil {
		return nil, nil, encoding.ErrInvalidUTF8
	}
	out, err := c.NewEncoder().Bytes([]byte(text))
	if err == nil {
		return out, nil, nil
	}
	return nil, firstUnmappable(text, c), nil
}

// firstUnmappable 은 인코딩에 실패한 첫 룬의 자리다. 전체 인코딩이 실패한 뒤에만
// 부르므로 흔한 경로의 비용이 아니다.
func firstUnmappable(text string, c encoding.Encoding) *Unmappable {
	enc := c.NewEncoder()
	line, col := 1, 1
	for _, r := range text {
		if _, err := enc.String(string(r)); err != nil {
			return &Unmappable{Line: line, Col: col, Char: string(r)}
		}
		if r == '\n' {
			line, col = line+1, 1
			continue
		}
		col += len(utf16.Encode([]rune{r}))
	}
	return &Unmappable{Line: line, Col: col}
}
