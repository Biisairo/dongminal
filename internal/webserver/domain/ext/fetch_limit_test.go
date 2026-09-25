package ext

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-1-11 (DOM-34): 아카이브 다운로드에 크기 상한이
// 있다. 상한이 시간(FetchTimeout)뿐이면 끝없이 흘러오는 응답이 10분 동안 임시
// 디스크를 채운다. 넘으면 **해시 대조 전에** 끊고 아무것도 남기지 않는다.
func TestFetchArchive_RejectsOversize(t *testing.T) {
	old := MaxArchiveBytes
	MaxArchiveBytes = 16
	t.Cleanup(func() { MaxArchiveBytes = old })

	chunks := func(_ context.Context, _ string, w io.Writer) error {
		for range 4 {
			if _, err := w.Write(make([]byte, 8)); err != nil {
				return err
			}
		}
		return nil
	}
	dest := filepath.Join(t.TempDir(), "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: hex64}

	err := FetchArchive(context.Background(), chunks, tg, dest)
	if !errors.Is(err, ErrArchiveTooLarge) {
		t.Fatalf("err = %v, want ErrArchiveTooLarge", err)
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("실패한 조달이 자리를 남겼다: %v", err)
	}
}

// 상한과 같은 크기는 받는다 — 경계를 먹지 않는다.
func TestFetchArchive_AtLimitPasses(t *testing.T) {
	blob := makeTarGz(t, []tarEntry{{name: "README", body: "hi"}})
	old := MaxArchiveBytes
	MaxArchiveBytes = int64(len(blob))
	t.Cleanup(func() { MaxArchiveBytes = old })

	dest := filepath.Join(t.TempDir(), "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: sum(blob)}
	if err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest); err != nil {
		t.Fatalf("상한과 같은 아카이브가 거절됐다: %v", err)
	}
}

// 기본값을 지킨다 (CONTRIBUTING §4 "상한은 var 로 둡니다"). 런타임 배포본이
// 100 MB 대라 그보다 넉넉해야 하고, 무제한이어서는 안 된다.
func TestMaxArchiveBytes_Default(t *testing.T) {
	if MaxArchiveBytes != 1<<30 {
		t.Fatalf("MaxArchiveBytes = %d, want %d", MaxArchiveBytes, int64(1<<30))
	}
}
