package httpapi

import (
	"bytes"
	"net/http"
	"path/filepath"
	"testing"
)

// EXPLORER_TRANSFER_IGNORE_SRS FR-ETR-45 (`SEC-20`) — zip 동시 요청 상한.
//
// 항목 수·크기에는 이미 상한이 있었지만(FR-ETR-12) 동시성에는 없었다. 한 요청이
// 최대 2GiB 를 압축하며 CPU 와 디스크를 함께 쓴다.

// V-ETR-45a: 상한을 넘으면 429 이고, **헤더를 쓰기 전에** 거절한다.
func TestFSDownloadDir_OverConcurrencyIs429(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	zipInFlight.Store(zipMaxConcurrent)
	t.Cleanup(func() { zipInFlight.Store(0) })

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("code=%d body=%s want 429", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("거절인데 Content-Disposition 이 나갔다: %q", cd)
	}
	if bytes.HasPrefix(rec.Body.Bytes(), []byte("PK")) {
		t.Fatal("거절인데 zip 본문이 나갔다")
	}
}

// V-ETR-45b: 끝난 요청은 자리를 돌려준다. 스트리밍 도중 실패해도 마찬가지다 —
// 그 경로가 누수의 단골 자리다.
func TestFSDownloadDir_ReleasesSlot(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if n := zipInFlight.Load(); n != 0 {
		t.Fatalf("요청이 끝났는데 자리가 %d 개 잡혀 있다", n)
	}
}

func TestZipMaxConcurrentDefault(t *testing.T) {
	if zipMaxConcurrent != 2 {
		t.Fatalf("상한=%d want 2 (FR-ETR-45, 2026-09-11 판정)", zipMaxConcurrent)
	}
}
