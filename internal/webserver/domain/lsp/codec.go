package lsp

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"dongminal/internal/shared/editorlimit"
)

// maxFrame 은 한 프레임의 본문 상한이다 (FR-LSP-53).
//
// 상한이 없으면 언어 서버가 보낸 (또는 망가진) 길이 하나로 서버 메모리가 통째로
// 잡힌다. 큰 이유는 `textDocument/didOpen` 이 파일 전체를 싣고, 큰 저장소의
// 진단 한 묶음도 수 MB 가 되기 때문이다. 그래서 텍스트 상한(`MaxTextBytes`)을 JSON
// 문자열로 실은 최악의 크기다 (OPTIMIZE_REFACTOR_SRS FR-OPT-15-1) — 종전의 32 MiB
// 고정값은 텍스트 상한이 32 MiB 가 되면 didOpen 한 프레임을 담지 못한다.
var maxFrame = int(editorlimit.BodyMaxBytes(int64(MaxTextBytes)))

// maxHeaderLine·maxHeaderBytes 는 헤더 한 줄(줄바꿈 포함)과 프레임 하나의 헤더 총량의
// 상한이다 (FR-ATF-29). LSP 헤더는 Content-Length·Content-Type 두 줄이 전부라 넉넉하다.
const (
	maxHeaderLine  = 1024
	maxHeaderBytes = 8 * maxHeaderLine
)

// ErrHeaderTooLarge 는 헤더가 상한을 넘었다는 뜻이다. 통로는 그 연결을 닫는다.
var ErrHeaderTooLarge = errors.New("lsp: header too large")

// LSP 의 전송은 HTTP 를 닮은 헤더와 본문이다:
//
//	Content-Length: 42\r\n
//	\r\n
//	{"jsonrpc":"2.0",…}
//
// 길이는 **바이트**다 — 글자 수로 세면 한글이 든 본문에서 그 다음 프레임부터
// 전부 어긋난다.

// writeFrame 은 본문 하나를 프레임으로 쓴다.
func writeFrame(w io.Writer, body []byte) error {
	if _, err := io.WriteString(w, "Content-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"); err != nil {
		return err
	}
	_, err := w.Write(body)
	return err
}

// readFrame 은 프레임 하나를 읽는다.
//
// 헤더의 길이를 **그대로 믿고 그만큼만** 읽는다. 더 읽으면 다음 프레임의 앞부분을
// 먹고, 덜 읽으면 다음 읽기가 본문 중간에서 시작한다 — 어느 쪽이든 그 뒤의 모든
// 프레임이 어긋나고, 그 증상은 "언어 서버가 답하지 않는다" 로 보인다.
func readFrame(r *bufio.Reader) ([]byte, error) {
	n := -1
	left := maxHeaderBytes
	for {
		line, err := readHeaderLine(r, &left)
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		// 빈 줄이 헤더의 끝이다.
		if line == "" {
			break
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			// 모르는 모양의 줄은 넘긴다 — 헤더를 늘리는 서버가 있다.
			continue
		}
		// 헤더 이름은 대소문자를 가리지 않는다.
		if !strings.EqualFold(strings.TrimSpace(k), "content-length") {
			continue
		}
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return nil, fmt.Errorf("lsp: bad Content-Length %q: %w", v, err)
		}
		n = parsed
	}
	if n < 0 {
		return nil, errors.New("lsp: frame without Content-Length")
	}
	if n > maxFrame {
		return nil, fmt.Errorf("lsp: frame too large (%d > %d)", n, maxFrame)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}

// readHeaderLine 은 헤더 한 줄을 줄바꿈까지 읽는다. 줄이 maxHeaderLine 을, 프레임의
// 헤더 누적이 left 를 넘으면 ErrHeaderTooLarge 다.
//
//	이전 동작: 줄바꿈이 올 때까지 상한 없이 읽었다
//	새  동작: 줄·총량 상한을 넘으면 오류 — 통로가 연결을 닫는다
//	이유:     FR-ATF-29 (AT-LSP-1)
func readHeaderLine(r *bufio.Reader, left *int) (string, error) {
	var line []byte
	for {
		c, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		line = append(line, c)
		*left--
		if len(line) > maxHeaderLine || *left < 0 {
			return "", ErrHeaderTooLarge
		}
		if c == '\n' {
			return string(line), nil
		}
	}
}
