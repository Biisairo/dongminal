package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// FILE_API_BOUNDARY_SRS §4.3 — 읽기 크기 상한 (TC-FAB-16~20).
//
// 상한이 없던 동안 `apiFileRead` 는 `io.Copy` 로 **전량**을 실었다. 값은 제품
// 결정이라 비어 있었고(M2 §3.3), 2026-09-11 에 **10 MiB** 로 확정됐다.
//
// 여기 테스트들은 상한을 **낮춰서** 돈다 — 10 MiB 파일을 만드는 비용을 치르지
// 않고도 판정의 자리는 같기 때문이며, `zipMaxBytes` 테스트가 쓰는 관례와 같다.
// 기본값 자체는 TestFileReadMaxDefault 가 따로 지킨다.

func withFileReadMax(t *testing.T, n int64) {
	t.Helper()
	old := fileReadMaxBytes
	fileReadMaxBytes = n
	t.Cleanup(func() { fileReadMaxBytes = old })
}

// TC-FAB-16: 상한을 넘는 읽기는 413 이고 **실제 크기**가 응답에 실린다 (FR-FAB-8).
func TestFileRead_OverLimitIs413(t *testing.T) {
	withFileReadMax(t, 16)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "big.txt")
	content := strings.Repeat("x", 100)
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d want 413 body=%q", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), "100") {
		t.Fatalf("실제 크기가 응답에 없다: %q", body)
	}
	if strings.Contains(string(body), content) {
		t.Fatalf("거절하면서 내용을 함께 보냈다: %q", body)
	}
}

// TC-FAB-19: 상한과 **같은 크기**는 통과하고 내용이 온전하다. 경계값이 한 칸
// 어긋나면 "열리던 파일이 안 열린다" 가 되고, 그 신고는 재현이 어렵다.
func TestFileRead_AtLimitSucceeds(t *testing.T) {
	withFileReadMax(t, 32)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "exact.txt")
	content := strings.Repeat("y", 32)
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if string(body) != content {
		t.Fatalf("내용이 잘렸다: %d바이트 want %d", len(body), len(content))
	}
}

// TC-FAB-18: `raw` 도 같은 상한을 지킨다 (FR-FAB-8 은 종단 둘을 함께 지목한다).
//
// **크기 판정이 종류 판정보다 앞이다.** 뒤에 두면 큰 파일을 통째로 읽어 종류를
// 가린 뒤에야 거절하게 된다.
func TestFileRaw_OverLimitIs413(t *testing.T) {
	withFileReadMax(t, 16)
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "big.png")
	if err := os.WriteFile(target, []byte(strings.Repeat("z", 100)), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/raw?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d want 413", resp.StatusCode)
	}
}

// TC-FAB-20: `probe` 가 상한을 **알려준다** (FR-FAB-9).
//
// 클라이언트가 자기 상수를 들고 있으면 두 벌이 되고, 그때 한쪽만 고쳐진다.
func TestFileProbe_CarriesMaxBytes(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "small.txt")
	if err := os.WriteFile(target, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/probe?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	raw, ok := got["maxBytes"].(float64)
	if !ok {
		t.Fatalf("probe 응답에 maxBytes 가 없다: %v", got)
	}
	if int64(raw) != fileReadMaxBytes {
		t.Fatalf("maxBytes=%v want %d", raw, fileReadMaxBytes)
	}
}

// 기본값 자체를 지킨다 — 위 테스트들이 값을 바꿔 돌기 때문에, 그 관례가 기본값의
// 회귀를 가릴 수 있다.
func TestFileReadMaxDefault(t *testing.T) {
	if fileReadMaxBytes != 10<<20 {
		t.Fatalf("기본 상한=%d want %d (FR-FAB-8, 2026-09-11 판정)", fileReadMaxBytes, int64(10<<20))
	}
}
