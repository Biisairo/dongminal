package textenc

import (
	"bytes"
	"testing"

	"golang.org/x/text/encoding/korean"
)

// REPO_FIX 03 §3A-1·3A-2 — 판별·엄격 디코드·재인코딩.

func cp949(t *testing.T, s string) []byte {
	t.Helper()
	b, err := korean.EUCKR.NewEncoder().Bytes([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDetect_Order(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		enc  string
		bom  bool
		text string
		ok   bool
	}{
		{"utf8-bom", append([]byte{0xEF, 0xBB, 0xBF}, "가a"...), UTF8, true, "가a", true},
		{"utf16le-bom", []byte{0xFF, 0xFE, 'a', 0, 0x00, 0xAC}, UTF16LE, true, "a가", true},
		{"utf16be-bom", []byte{0xFE, 0xFF, 0, 'a', 0xAC, 0x00}, UTF16BE, true, "a가", true},
		{"utf8", []byte("한글 text"), UTF8, false, "한글 text", true},
		{"cp949", cp949(t, "한글 텍스트"), CP949, false, "한글 텍스트", true},
		{"undecodable", []byte{0xFF, 0xFF, 0x80, 0x00}, UTF8, false, "", false},
	}
	for _, c := range cases {
		d := Detect(c.in)
		if d.Enc != c.enc || d.BOM != c.bom || d.Decodable != c.ok || (c.ok && d.Text != c.text) {
			t.Fatalf("%s: %+v", c.name, d)
		}
	}
	// UTF-32LE BOM(FF FE 00 00)은 UTF-16 으로 보지 않는다.
	if d := Detect([]byte{0xFF, 0xFE, 0, 0, 'a', 0, 0, 0}); d.Enc == UTF16LE {
		t.Fatalf("UTF-32LE 를 UTF-16LE 로 봤다: %+v", d)
	}
}

func TestDecodeAs_Strict(t *testing.T) {
	if d, ok := DecodeAs(cp949(t, "안녕"), CP949); !ok || d.Text != "안녕" {
		t.Fatalf("cp949 = %+v %v", d, ok)
	}
	if _, ok := DecodeAs([]byte("안녕"), CP949); ok {
		t.Fatal("UTF-8 바이트를 CP949 로 엄격 디코드했다")
	}
	// Windows-1252 미정의 바이트는 실패다.
	for _, b := range []byte{0x81, 0x8D, 0x8F, 0x90, 0x9D} {
		if _, ok := DecodeAs([]byte{'a', b}, Win1252); ok {
			t.Fatalf("미정의 0x%X 를 성공으로 봤다", b)
		}
	}
	if d, ok := DecodeAs([]byte{'c', 0xE9}, Win1252); !ok || d.Text != "cé" {
		t.Fatalf("1252 = %+v %v", d, ok)
	}
	if d, ok := DecodeAs(append([]byte{0xEF, 0xBB, 0xBF}, 'x'), UTF8); !ok || !d.BOM || d.Text != "x" {
		t.Fatalf("utf-8 BOM 강제 = %+v", d)
	}
	if _, ok := DecodeAs([]byte("x"), "koi8-r"); ok {
		t.Fatal("모르는 인코딩을 받았다")
	}
}

func TestEncode_RoundTripAndBOM(t *testing.T) {
	for _, c := range []struct {
		enc string
		bom bool
	}{{UTF8, false}, {UTF8, true}, {UTF16LE, true}, {UTF16BE, true}, {CP949, false}} {
		out, un, err := Encode("한글 abc\r\n끝", c.enc, c.bom)
		if err != nil || un != nil {
			t.Fatalf("%s: %v %v", c.enc, err, un)
		}
		d, ok := DecodeAs(out, c.enc)
		if !ok || d.Text != "한글 abc\r\n끝" || d.BOM != (c.bom || c.enc == UTF16LE || c.enc == UTF16BE) {
			t.Fatalf("%s 왕복 = %+v %v", c.enc, d, ok)
		}
	}
	// UTF-8 BOM 없음은 BOM 을 붙이지 않는다.
	if out, _, _ := Encode("a", UTF8, false); !bytes.Equal(out, []byte("a")) {
		t.Fatalf("utf-8 = %v", out)
	}
}

// 표현할 수 없는 문자는 첫 위치(1-기준 줄, UTF-16 코드 단위 열)와 함께 거절한다.
func TestEncode_UnmappableFirstPosition(t *testing.T) {
	_, un, err := Encode("ok\n𝄞a😀", CP949, false)
	if err != nil {
		t.Fatal(err)
	}
	if un == nil || un.Line != 2 || un.Col != 1 || un.Char != "𝄞" {
		t.Fatalf("unmappable = %+v", un)
	}
	_, un, _ = Encode("ab\ncd€x", Win1252, false) // € 는 1252 에 있다
	if un != nil {
		t.Fatalf("€ 를 거절했다: %+v", un)
	}
	_, un, _ = Encode("a😀가", ShiftJIS, false)
	if un == nil || un.Line != 1 || un.Col != 2 {
		t.Fatalf("sjis = %+v", un)
	}
}

func TestHasUTF16BOM(t *testing.T) {
	if !HasUTF16BOM([]byte{0xFF, 0xFE, 'a', 0}) || !HasUTF16BOM([]byte{0xFE, 0xFF, 0, 'a'}) {
		t.Fatal("UTF-16 BOM 을 못 봤다")
	}
	if HasUTF16BOM([]byte{0xFF, 0xFE, 0, 0}) || HasUTF16BOM([]byte("ab")) {
		t.Fatal("아닌 것을 UTF-16 으로 봤다")
	}
}
