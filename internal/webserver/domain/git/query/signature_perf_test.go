package query

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// PERFORMANCE_HARDENING_SRS 묶음 P-D 항목 12 (`AUDIT-go-domain.md` P4).
//
// **감사가 먼저 요구한 것이 측정이다** — *"측정이 먼저다. 실제로 비싸다면 …"*.
// 1차 게이트(FR-GDT-1)의 존재 이유가 "1차는 싸다" 이고, ref 가 많은 저장소에서
// 그 전제가 약해지는지를 여기서 본다. 비용이 저장소 **모양**에 따라 갈리므로
// ref 수를 10 / 1,000 / 5,000 으로 두고 셋을 나란히 잰다.
//
// ## 실측 (2026-09-21, darwin/arm64 M4)
//
//	refs=10      32,451 ns/op     5,368 B/op      50 allocs/op
//	refs=1000   408,847 ns/op   119,256 B/op   2,036 allocs/op
//	refs=5000 2,053,535 ns/op   644,066 B/op  10,040 allocs/op
//
// `GitWatchInterval` 1초 · `GitWatchCap` 16 을 곱하면 유휴 CPU 가
// **0.05% / 0.65% / 3.3%** 다. `PERFORMANCE_BUDGET.md` §2-4 의 예산은 1% 이므로
// 현실적인 모양(저장소 몇 개 × ref 수백)에서는 한참 아래이고, 극단(16 × 5,000)
// 에서만 넘는다.
//
// **감사가 권한 mtime 게이트는 두지 않았다** (D-PRF-12). 그 게이트가 가리려는
// `shape` 는 **mtime 이 못 믿을 값이라서** 생긴 것이다 (FR-GVR-21a — Windows
// 러너에서 `git branch` 뒤 45초 동안 `refs/heads` 의 mtime 이 그대로였다).
// 재서 안 셈이 하나 더 있다: 할당 2,036은 **우리 것이 아니라 `os.ReadDir` 의
// 것**이다. 해시를 인라인 FNV 로 바꿔 보았지만 수가 한 톨도 줄지 않았다 —
// `h.Write([]byte(name))` 은 탈출하지 않아 컴파일러가 이미 없앤다.
func benchRefs(b *testing.B, n int) string {
	b.Helper()
	dir := b.TempDir()
	heads := filepath.Join(dir, "refs", "heads")
	if err := os.MkdirAll(heads, 0o755); err != nil {
		b.Fatal(err)
	}
	for i := 0; i < n; i++ {
		p := filepath.Join(heads, "branch-"+strconv.Itoa(i))
		if err := os.WriteFile(p, []byte("0000000000000000000000000000000000000000\n"), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	return dir
}

func BenchmarkRefsTree(b *testing.B) {
	for _, n := range []int{10, 1000, 5000} {
		b.Run("refs="+strconv.Itoa(n), func(b *testing.B) {
			dir := benchRefs(b, n)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				refsTree(dir)
			}
		})
	}
}
