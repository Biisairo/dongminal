package lsp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// TC-LSP-40: 프레임은 `Content-Length` 와 빈 줄 뒤에 본문이 온다. LSP 의 전송
// 규약이며, 길이를 틀리면 그 다음 프레임부터 전부 어긋난다.
func TestWriteFrame(t *testing.T) {
	var buf bytes.Buffer
	body := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	if err := writeFrame(&buf, body); err != nil {
		t.Fatal(err)
	}
	got := buf.String()
	want := "Content-Length: " + itoa(len(body)) + "\r\n\r\n" + string(body)
	if got != want {
		t.Fatalf("프레임이 규약과 다르다:\n got=%q\nwant=%q", got, want)
	}
}

// TC-LSP-41: 읽기는 헤더의 길이를 **그대로 믿고 그만큼만** 읽는다. 더 읽으면 다음
// 프레임의 앞부분을 먹고, 덜 읽으면 다음 읽기가 본문 중간에서 시작한다.
func TestReadFrame_Sequence(t *testing.T) {
	var buf bytes.Buffer
	msgs := []string{`{"id":1}`, `{"id":2,"x":"한글도 바이트 길이로 센다"}`, `{"id":3}`}
	for _, m := range msgs {
		if err := writeFrame(&buf, []byte(m)); err != nil {
			t.Fatal(err)
		}
	}
	r := bufio.NewReader(&buf)
	for i, want := range msgs {
		got, err := readFrame(r)
		if err != nil {
			t.Fatalf("%d 번째 프레임: %v", i, err)
		}
		if string(got) != want {
			t.Fatalf("%d 번째 프레임이 다르다:\n got=%q\nwant=%q", i, got, want)
		}
	}
	if _, err := readFrame(r); err == nil {
		t.Fatal("끝났는데 프레임을 더 읽었다")
	}
}

// TC-LSP-42: 헤더는 대소문자를 가리지 않고, 우리가 모르는 헤더가 섞여도 읽는다.
// 서버마다 `Content-Type` 을 붙이는 것이 있다.
func TestReadFrame_HeaderTolerance(t *testing.T) {
	body := `{"ok":true}`
	raw := "content-length: " + itoa(len(body)) + "\r\n" +
		"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n" + body
	got, err := readFrame(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("본문이 다르다: %q", got)
	}
}

// TC-LSP-43: 길이 헤더가 없거나 숫자가 아니면 오류다 — 추측해서 읽으면 그 뒤가
// 전부 어긋난다.
func TestReadFrame_BadHeader(t *testing.T) {
	for _, raw := range []string{
		"\r\n{}",
		"Content-Length: abc\r\n\r\n{}",
		"Content-Length: -3\r\n\r\n{}",
		"X-Nothing: 1\r\n\r\n{}",
	} {
		if _, err := readFrame(bufio.NewReader(strings.NewReader(raw))); err == nil {
			t.Fatalf("%q 를 읽어냈다 — 오류여야 한다", raw)
		}
	}
}

// TC-LSP-44 (FR-LSP-53): 프레임 크기에 상한이 있다. 상한이 없으면 언어 서버가 보낸
// (또는 망가진) 길이 하나로 서버 메모리가 통째로 잡힌다.
func TestReadFrame_TooLarge(t *testing.T) {
	raw := "Content-Length: " + itoa(maxFrame+1) + "\r\n\r\n"
	if _, err := readFrame(bufio.NewReader(strings.NewReader(raw))); err == nil {
		t.Fatal("상한을 넘긴 프레임을 받아들였다")
	}
}

// TC-LSP-45: 왕복 — 우리가 쓴 것을 우리가 읽는다. 인코딩이 한쪽만 바뀌는 것을
// 막는 검사다.
func TestFrame_RoundTrip(t *testing.T) {
	type msg struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Method  string `json:"method"`
	}
	in := msg{JSONRPC: "2.0", ID: 7, Method: "textDocument/definition"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := writeFrame(&buf, b); err != nil {
		t.Fatal(err)
	}
	got, err := readFrame(bufio.NewReader(&buf))
	if err != nil {
		t.Fatal(err)
	}
	var out msg
	if err := json.Unmarshal(got, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Fatalf("왕복이 값을 바꿨다: %+v vs %+v", out, in)
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
