package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/textenc"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS X-e · D-SDA-10 · TC-SDA-1·10 — UTF-8 변환의 답과 거절.

var undecodable = []byte{'a', 0xff, 0xff, 0xff, '\n'}

func TestConvertUTF8Answer(t *testing.T) {
	cp := cp949Bytes(t, "한글\n")
	cases := []struct {
		name   string
		raw    []byte
		from   string
		ok     bool
		why    string
		status int
	}{
		{"cp949 로 연 cp949 파일", cp, textenc.CP949, true, "", 0},
		{"BOM 있는 UTF-8 은 BOM 을 떼는 변환이다", append([]byte{0xEF, 0xBB, 0xBF}, "a\n"...), textenc.UTF8, true, "", 0},
		{"이미 BOM 없는 UTF-8", []byte("a\n"), textenc.UTF8, false, apierr.CodeAlreadyUTF8, http.StatusConflict},
		{"연 인코딩으로 해독하지 못한다", undecodable, textenc.UTF8, false, apierr.CodeEncodingUndecodable, http.StatusUnprocessableEntity},
		{"다른 인코딩으로 연 것도 엄격하게 본다", cp, textenc.UTF8, false, apierr.CodeEncodingUndecodable, http.StatusUnprocessableEntity},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := convertUTF8Answer(c.raw, c.from)
			if a.OK != c.ok || a.Why != c.why || a.Status != c.status {
				t.Fatalf("answer = %+v, want ok=%v why=%q status=%d", a, c.ok, c.why, c.status)
			}
			if !a.OK && !action.Catalog.MayGive(action.FileConvertUTF8, a.Why) {
				t.Fatalf("%s 의 사유 %q 가 Catalog 에 없다", action.FileConvertUTF8, a.Why)
			}
		})
	}
}

func readActions(t *testing.T, h http.Header) map[string]action.Answer {
	t.Helper()
	var m map[string]action.Answer
	if err := json.Unmarshal([]byte(h.Get(fileActionsHeader)), &m); err != nil {
		t.Fatalf("%s = %q: %v", fileActionsHeader, h.Get(fileActionsHeader), err)
	}
	return m
}

func TestFileReadCarriesConvertAnswer(t *testing.T) {
	e := newFileBoundaryEnv(t)
	cases := []struct {
		name string
		raw  []byte
		ok   bool
		why  string
	}{
		{"cp949", cp949Bytes(t, "한글\n"), true, ""},
		{"utf-8", []byte("a\n"), false, apierr.CodeAlreadyUTF8},
		{"해독 불가", undecodable, false, apierr.CodeEncodingUndecodable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(e.root, c.name+".txt")
			put(t, p, c.raw, 0o644)
			resp, _ := encRead(t, e, p, "&decode=1")
			a := readActions(t, resp.Header)[action.FileConvertUTF8]
			if a.OK != c.ok || a.Why != c.why {
				t.Fatalf("answer = %+v, want ok=%v why=%q", a, c.ok, c.why)
			}
		})
	}
}

// 답이 거짓이면 변환 저장도 같은 코드로 거절되고 파일은 그대로다 (TC-SDA-1).
func TestFileWriteConvertRejectsWithAnswer(t *testing.T) {
	e := newFileBoundaryEnv(t)
	for _, raw := range [][]byte{[]byte("a\n"), undecodable} {
		p := filepath.Join(e.root, "rej.txt")
		put(t, p, raw, 0o644)
		resp, _ := encRead(t, e, p, "&decode=1")
		want := readActions(t, resp.Header)[action.FileConvertUTF8]
		code, _, errCode := encWrite(t, e, map[string]any{"path": p, "content": "x\n",
			"encoding": textenc.UTF8, "convertFrom": resp.Header.Get("X-File-Encoding")})
		if want.OK || errCode != want.Why || code != convertUTF8Answer(raw, textenc.UTF8).Status {
			t.Fatalf("raw %q: write = %d %q, answer = %+v", raw, code, errCode, want)
		}
		if got, _ := os.ReadFile(p); !bytes.Equal(got, raw) {
			t.Fatalf("거절했는데 파일이 바뀌었다: %q", got)
		}
	}
}

func TestFileWriteConvertSucceedsAndAnswerFollows(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "k.txt")
	put(t, p, cp949Bytes(t, "한글\n"), 0o644)
	code, out, _ := encWrite(t, e, map[string]any{"path": p, "content": "한글\n",
		"encoding": textenc.UTF8, "convertFrom": textenc.CP949})
	if code != http.StatusOK {
		t.Fatalf("code = %d out = %v", code, out)
	}
	if got, _ := os.ReadFile(p); string(got) != "한글\n" {
		t.Fatalf("변환 뒤 내용 = %q", got)
	}
	// 저장 응답의 답은 방금 쓴 바이트의 것이다 — 변환 뒤 메뉴가 낡지 않는다.
	raw, _ := json.Marshal(out["actions"])
	var acts map[string]action.Answer
	_ = json.Unmarshal(raw, &acts)
	if a := acts[action.FileConvertUTF8]; a.OK || a.Why != apierr.CodeAlreadyUTF8 {
		t.Fatalf("저장 응답의 답 = %+v, want already_utf8", acts)
	}
}

// `convertFrom` 이 없으면 일반 저장이다 — 이미 UTF-8 인 파일도 그대로 저장된다.
func TestFileWriteWithoutConvertUnchanged(t *testing.T) {
	e := newFileBoundaryEnv(t)
	p := filepath.Join(e.root, "u.txt")
	put(t, p, []byte("a\n"), 0o644)
	code, _, _ := encWrite(t, e, map[string]any{"path": p, "content": "b\n", "encoding": textenc.UTF8})
	if code != http.StatusOK {
		t.Fatalf("일반 저장 = %d", code)
	}
}
