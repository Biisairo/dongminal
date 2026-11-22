package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// QUALITY_GO_SRS TC-QG-40: 큰 트리 복사 중 다른 루트의 mkdir 이 얼마나 기다리는가 (FR-QG-40).
//
// 측정이라 기본으로는 돌지 않는다 — `DM_MEASURE_FS_COPY=1` 일 때만 돈다. 트리는 임시 폴더에
// 만들고 시험이 끝나면 지워진다(t.TempDir). 수치는 QUALITY_GO_SRS §6 에 있다.
func TestMeasureFSCopyBlocksOtherRootMkdir(t *testing.T) {
	if os.Getenv("DM_MEASURE_FS_COPY") == "" {
		t.Skip("측정 — DM_MEASURE_FS_COPY=1 일 때만 돈다")
	}
	const dirs, perDir = 30, 100 // 파일 3000개 + 폴더 30개
	s, ws, home := fsTestServer(t)
	other := filepath.Join(t.TempDir(), "other")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	seedRoots(t, ws, home, other)
	tree := filepath.Join(home, "tree")
	blob := make([]byte, 4096)
	for d := range dirs {
		dir := filepath.Join(tree, fmt.Sprintf("d%02d", d))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for f := range perDir {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", f)), blob, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	dst := filepath.Join(home, "dst")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}

	done := make(chan time.Duration, 1)
	start := time.Now()
	go func() {
		code, out := copyReq(t, s, home, tree, home, dst)
		if code != http.StatusOK {
			t.Errorf("copy = %d %v", code, out)
		}
		done <- time.Since(start)
	}()
	// 복사가 대상 이름을 잡은 뒤(잠금 안)에 다른 루트에 mkdir 을 보낸다.
	target := filepath.Join(dst, "tree")
	for {
		if _, err := os.Stat(target); err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mkStart := time.Now()
	body := fmt.Sprintf(`{"root":%s,"path":%s,"dir":true}`,
		testpath.JSONQuote(other), testpath.JSONQuote(filepath.Join(other, "new")))
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create", body); code != http.StatusOK {
		t.Fatalf("mkdir = %d %v", code, out)
	}
	mk := time.Since(mkStart)
	copyTook := <-done
	t.Logf("복사(파일 %d) %v · 그동안 다른 루트 mkdir 응답 %v", dirs*perDir, copyTook, mk)
}
