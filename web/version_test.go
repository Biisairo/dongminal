package web

import (
	"io/fs"
	"regexp"
	"testing"
)

// 브라우저로 나가는 자산은 `?v=` 로만 무효화된다 (`static.go` 가 적은 계약이다 — HTML 은
// `no-cache` 로 늘 재검증하고, 나머지는 그 쿼리 하나에 달려 있다).
//
// 그 값을 **사람이 적던 때**에는 자산을 고치고 `?v=` 를 그대로 두는 일이 실제로
// 일어났다. 두 커밋이 그랬고, e2e 는 매번 새 브라우저 컨텍스트라 캐시가 없어 전부
// 통과했다 — 아무도 울지 않는 실패였다. 그래서 잠금 파일(`assets.lock`)이 서 있었다.
//
// 이제 판은 **서빙 시점에 서버가 자산의 내용에서 계산해 넣는다**
// (ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-1·5). 잊을 사람이 없으므로 잠금도 없앴다.
//
// 남은 계약은 하나다: **문서는 판을 적지 않는다.** 손으로 적은 값이 하나라도 되살아나면
// 그 자산만 영원히 무효화되지 않으며, 그것이 처음의 실패와 같은 모양이다.
const assetVerPlaceholder = "__ASSETV__"

// 따옴표 안의 `?v=` 값을 그대로 집는다 — 자리표시자든 손으로 적은 수든 걸린다.
var assetVerRe = regexp.MustCompile(`\?v=([^"'\s>]*)`)

// TC-AVS-9 (FR-AVS-4·15)
func TestIndexDeclaresNoLiteralVersion(t *testing.T) {
	b, err := fs.ReadFile(files, "index.html")
	if err != nil {
		t.Fatalf("index.html: %v", err)
	}

	m := assetVerRe.FindAllStringSubmatch(string(b), -1)
	if len(m) == 0 {
		t.Fatal("index.html 에 ?v= 가 없다 — 자산이 무효화되지 않는다")
	}
	for _, g := range m {
		if g[1] != assetVerPlaceholder {
			t.Fatalf(`index.html 이 판을 손으로 적었다: ?v=%s

판은 서버가 서빙 시점에 넣는다. 그 자리는 아래 하나여야 한다:

     ?v=%s`, g[1], assetVerPlaceholder)
		}
	}
}
