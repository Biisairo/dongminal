package lsp

import (
	"bufio"
	"errors"
	"strings"
	"testing"
)

// endless 는 끝없이 같은 바이트를 준다 — 줄바꿈이 오지 않는 헤더다.
type endless byte

func (e endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(e)
	}
	return len(p), nil
}

// TC-ATF-29 (FR-ATF-29 / AT-LSP-1): 헤더 한 줄에 상한이 있다. 줄바꿈 없이 흘러오는
// 헤더가 메모리를 잡지 못하고 오류로 끝난다(호출자가 연결을 닫는다).
func TestReadFrame_HeaderLineCap(t *testing.T) {
	_, err := readFrame(bufio.NewReader(endless('a')))
	if !errors.Is(err, ErrHeaderTooLarge) {
		t.Fatalf("err = %v, want ErrHeaderTooLarge", err)
	}
}

// TC-ATF-29 (FR-ATF-29): 헤더 총량에도 상한이 있다 — 짧은 줄이 끝없이 와도 끝난다.
func TestReadFrame_HeaderTotalCap(t *testing.T) {
	raw := strings.Repeat("X-Pad: 1\r\n", maxHeaderBytes) + "Content-Length: 2\r\n\r\n{}"
	_, err := readFrame(bufio.NewReader(strings.NewReader(raw)))
	if !errors.Is(err, ErrHeaderTooLarge) {
		t.Fatalf("err = %v, want ErrHeaderTooLarge", err)
	}
}

// TC-ATF-29 (FR-ATF-29): 상한 안의 헤더는 그대로 읽는다.
func TestReadFrame_HeaderAtLineCap(t *testing.T) {
	pad := "X-Pad: " + strings.Repeat("a", maxHeaderLine-len("X-Pad: \r\n"))
	raw := pad + "\r\nContent-Length: 2\r\n\r\n{}"
	got, err := readFrame(bufio.NewReader(strings.NewReader(raw)))
	if err != nil || string(got) != "{}" {
		t.Fatalf("readFrame = %q %v", got, err)
	}
}
