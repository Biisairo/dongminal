package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-4 (GH-16): 검색 한 번이 파일마다 64 KiB 읽기 버퍼를
// 새로 만들지 않는다.
//
//	이전: 파일 40개 검색 1회 ≈ 2,663,636 B (40 × grepReadBuf 가 대부분)
//	새:   버퍼 하나를 파일마다 Reset 으로 되쓴다
func TestGrepWithGo_ReusesReadBuffer(t *testing.T) {
	const files = 40
	dir := t.TempDir()
	for i := 0; i < files; i++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(i)+".txt"), []byte("alpha\nbeta\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	if _, _, err := grepWithGo(ctx, dir, "beta", 100); err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if _, _, err := grepWithGo(ctx, dir, "beta", 100); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	got := after.TotalAlloc - before.TotalAlloc
	// 버퍼 몇 벌(걷기·결과의 몫 포함)까지는 허용한다. 파일마다 한 벌이면 40벌이다.
	if limit := uint64(8 * grepReadBuf); got > limit {
		t.Fatalf("검색 1회 할당 %d B > %d B — 파일마다 읽기 버퍼를 새로 만든다", got, limit)
	}
}
