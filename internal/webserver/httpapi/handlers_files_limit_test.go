package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/editorlimit"
	"dongminal/internal/webserver/apierr"
)

// OPTIMIZE_REFACTOR_SRS §3.15 — 에디터가 연 파일은 저장할 수 있어야 한다 (FR-OPT-15-2).
//
// 종전에는 읽기 상한이 10 MiB, 저장 본문이 `httpreq.DefaultLimit`(1 MiB)이어서 1~10 MiB
// 파일은 열리고 고쳐지지만 저장이 413 으로 거절됐다.

func writeLimitReq(t *testing.T, e *fileBoundaryEnv, path, content string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"path": path, "content": content})
	resp, err := http.Post(e.ts.URL+"/api/file/write", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode, resp.Header.Get(apierr.CodeHeader)
}

// 상한과 같은 크기(32 MiB)의 파일을 저장한다 — 실제 상수로 돈다.
func TestFileWrite_AtEditorLimitSaves(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "big.txt")
	content := strings.Repeat("a", editorlimit.FileMaxBytes)
	code, errCode := writeLimitReq(t, e, target, content)
	if code != http.StatusOK {
		t.Fatalf("status=%d code=%q want 200 (FR-OPT-15-2)", code, errCode)
	}
	st, err := os.Stat(target)
	if err != nil || st.Size() != int64(editorlimit.FileMaxBytes) {
		t.Fatalf("저장된 크기=%v err=%v want %d", st, err, editorlimit.FileMaxBytes)
	}
}

// JSON 이스케이프로 본문이 두 배가 되는 최악(개행만)도 파일 상한 안이면 저장된다.
// 상한을 낮춰 돈다 — 본문 상한이 파일 상한에서 파생되는지를 보는 것이다.
func TestFileWrite_EscapedWorstCaseSaves(t *testing.T) {
	withFileReadMax(t, 2<<20)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "lines.txt")
	content := strings.Repeat("\n", 2<<20)
	code, errCode := writeLimitReq(t, e, target, content)
	if code != http.StatusOK {
		t.Fatalf("status=%d code=%q want 200 — 이스케이프 여유가 본문 상한에 없다", code, errCode)
	}
}

// 파일 상한을 넘는 저장은 읽기와 같은 코드(`too_large`)로 거절되고 아무것도 쓰지 않는다.
// 쓰게 두면 방금 저장한 파일을 다시 열 수 없다.
func TestFileWrite_OverLimitIsTooLarge(t *testing.T) {
	withFileReadMax(t, 16)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "over.txt")
	if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, errCode := writeLimitReq(t, e, target, strings.Repeat("b", 17))
	if code != http.StatusRequestEntityTooLarge || errCode != apierr.CodeTooLarge {
		t.Fatalf("status=%d code=%q want 413 %s", code, errCode, apierr.CodeTooLarge)
	}
	if got, _ := os.ReadFile(target); string(got) != "keep" {
		t.Fatalf("거절하면서 썼다: %q", got)
	}
}

// 본문 상한을 넘는 요청은 종전 그대로 `body_too_large` 다.
func TestFileWrite_OverBodyLimitIsBodyTooLarge(t *testing.T) {
	withFileReadMax(t, 16)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "body.txt")
	code, errCode := writeLimitReq(t, e, target, strings.Repeat("c", int(editorlimit.BodyMaxBytes(16))+1))
	if code != http.StatusRequestEntityTooLarge || errCode != apierr.CodeBodyTooBig {
		t.Fatalf("status=%d code=%q want 413 %s", code, errCode, apierr.CodeBodyTooBig)
	}
}
