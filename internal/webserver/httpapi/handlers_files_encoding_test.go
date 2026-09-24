package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/text/encoding/korean"
)

// REPO_FIX 03 §3A-1·3A-2·3A-4 — 인코딩 왕복·권한·심링크·probe.

func encRead(t *testing.T, e *fileBoundaryEnv, p, extra string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + url.QueryEscape(p) + extra)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func encWrite(t *testing.T, e *fileBoundaryEnv, m map[string]any) (int, map[string]any, string) {
	t.Helper()
	body, _ := json.Marshal(m)
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+"/api/file/write", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out, resp.Header.Get("X-Error-Code")
}

func cp949Bytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := korean.EUCKR.NewEncoder().Bytes([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func put(t *testing.T, p string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(p, b, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

// decode 없는 읽기는 원문 바이트다(하위호환). decode=1 은 판별·변환·헤더.
func TestFileRead_DecodeContract(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "k.txt")
	raw := cp949Bytes(t, "한글 파일\n")
	put(t, p, raw, 0o644)

	resp, body := encRead(t, e, p, "")
	if !bytes.Equal(body, raw) || resp.Header.Get("X-File-Encoding") != "" {
		t.Fatalf("원문 읽기가 바뀌었다: %q %v", body, resp.Header)
	}
	resp, body = encRead(t, e, p, "&decode=1")
	if string(body) != "한글 파일\n" || resp.Header.Get("X-File-Encoding") != "cp949" ||
		resp.Header.Get("X-File-BOM") != "0" || resp.Header.Get("X-File-Decodable") != "1" {
		t.Fatalf("decode = %q %v", body, resp.Header)
	}
	if resp.Header.Get("X-File-Stamp") == "" {
		t.Fatal("표식이 사라졌다")
	}

	bomP := filepath.Join(e.root, "b.txt")
	put(t, bomP, append([]byte{0xEF, 0xBB, 0xBF}, "x"...), 0o644)
	resp, body = encRead(t, e, bomP, "&decode=1")
	if string(body) != "x" || resp.Header.Get("X-File-BOM") != "1" || resp.Header.Get("X-File-Encoding") != "utf-8" {
		t.Fatalf("utf-8 BOM = %q %v", body, resp.Header)
	}

	u16 := filepath.Join(e.root, "w.txt")
	put(t, u16, []byte{0xFF, 0xFE, 'h', 0, 'i', 0}, 0o644)
	resp, body = encRead(t, e, u16, "&decode=1")
	if string(body) != "hi" || resp.Header.Get("X-File-Encoding") != "utf-16le" {
		t.Fatalf("utf-16le = %q %v", body, resp.Header)
	}

	bad := filepath.Join(e.root, "bad.txt")
	put(t, bad, []byte{0xFF, 0xFF, 0x80}, 0o644)
	resp, _ = encRead(t, e, bad, "&decode=1")
	if resp.Header.Get("X-File-Decodable") != "0" {
		t.Fatalf("디코드 불가 = %v", resp.Header)
	}

	// 강제 인코딩 실패는 422 encoding_undecodable.
	resp, _ = encRead(t, e, bad, "&decode=1&encoding=utf-8")
	if resp.StatusCode != 422 || resp.Header.Get("X-Error-Code") != "encoding_undecodable" {
		t.Fatalf("강제 실패 = %d %s", resp.StatusCode, resp.Header.Get("X-Error-Code"))
	}
	resp, body = encRead(t, e, p, "&decode=1&encoding=cp949")
	if resp.StatusCode != 200 || string(body) != "한글 파일\n" {
		t.Fatalf("강제 cp949 = %d %q", resp.StatusCode, body)
	}
}

// 저장은 문서의 인코딩·BOM 으로 되돌려 쓴다. 필드가 없으면 원문 그대로.
func TestFileWrite_EncodingRoundTrip(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "k.txt")
	put(t, p, cp949Bytes(t, "옛"), 0o644)
	if code, out, _ := encWrite(t, e, map[string]any{"path": p, "content": "새 내용", "encoding": "cp949", "bom": false}); code != 200 {
		t.Fatalf("cp949 쓰기 = %d %v", code, out)
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, cp949Bytes(t, "새 내용")) {
		t.Fatalf("cp949 로 보존되지 않았다: %v", got)
	}
	if code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "a", "encoding": "utf-8", "bom": true}); code != 200 {
		t.Fatal("utf-8 BOM 쓰기 실패")
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, []byte{0xEF, 0xBB, 0xBF, 'a'}) {
		t.Fatalf("BOM = %v", got)
	}
	if code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "hi", "encoding": "utf-16be", "bom": true}); code != 200 {
		t.Fatal("utf-16be 쓰기 실패")
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, []byte{0xFE, 0xFF, 0, 'h', 0, 'i'}) {
		t.Fatalf("utf-16be = %v", got)
	}
	if code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "원문"}); code != 200 {
		t.Fatal("필드 없는 쓰기 실패")
	}
	if got, _ := os.ReadFile(p); string(got) != "원문" {
		t.Fatalf("필드 없는 쓰기가 원문이 아니다: %v", got)
	}
}

// 표현할 수 없는 문자는 422 encoding_unmappable + 첫 위치, 파일은 그대로.
func TestFileWrite_UnmappableRejected(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "k.txt")
	orig := cp949Bytes(t, "옛")
	put(t, p, orig, 0o644)
	code, out, ec := encWrite(t, e, map[string]any{"path": p, "content": "a\nb😀", "encoding": "cp949", "bom": false})
	if code != 422 || ec != "encoding_unmappable" || out["line"] != float64(2) || out["col"] != float64(2) || out["char"] != "😀" {
		t.Fatalf("= %d %s %v", code, ec, out)
	}
	if got, _ := os.ReadFile(p); !bytes.Equal(got, orig) {
		t.Fatal("거절했는데 파일이 바뀌었다")
	}
}

// probe: UTF-16 BOM 파일은 text 다(NUL 판정보다 먼저).
func TestFileProbe_UTF16IsText(t *testing.T) {
	s, dir := probeServer(t)
	for name, blob := range map[string][]byte{
		"le.txt": {0xFF, 0xFE, 'a', 0, 'b', 0},
		"be.txt": {0xFE, 0xFF, 0, 'a', 0, 'b'},
	} {
		p := writeAt(t, dir, name, blob)
		if _, body := probeGet(t, s, "/api/file/probe", p); body["kind"] != "text" {
			t.Fatalf("%s kind = %v", name, body["kind"])
		}
	}
	p := writeAt(t, dir, "u32.bin", []byte{0xFF, 0xFE, 0, 0, 'a', 0, 0, 0})
	if _, body := probeGet(t, s, "/api/file/probe", p); body["kind"] != "binary" {
		t.Fatalf("UTF-32 kind = %v", body["kind"])
	}
}
