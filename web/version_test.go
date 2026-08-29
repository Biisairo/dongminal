package web

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// 브라우저로 나가는 자산이 바뀌면 `index.html` 의 `?v=` 도 올라가야 한다.
//
// `static.go` 가 그 계약을 이미 적어 두었다 — HTML 은 `no-cache` 로 늘 재검증하고
// **나머지 자산은 `?v=` 로만 무효화된다.** 올리지 않으면 새 빌드를 띄워도 브라우저는
// 캐시에 있는 옛 JS 를 그대로 쓴다.
//
// 그 계약은 지금까지 **사람의 기억**이었고, 실제로 두 커밋이 `web/js/` 를 고치면서
// `?v=` 를 그대로 뒀다. 화면에는 고친 것이 도달하지 않았는데 e2e 는 매번 새 브라우저
// 컨텍스트라 캐시가 없어 전부 통과했다 — 아무도 울지 않는 실패였다.
//
// 그래서 잠금 파일 하나로 만든다. 자산을 고치면 이 테스트가 실패하고, 고치는 길은
// 하나뿐이다: `?v=` 를 올리고 `assets.lock` 을 새 해시로 바꾼다.
const assetsLock = "assets.lock"

var scriptVerRe = regexp.MustCompile(`\?v=(\d+)`)

func TestAssetVersionBumpedWithAssets(t *testing.T) {
	sum := hashAssets(t)
	ver := assetVersion(t)

	raw, err := os.ReadFile(assetsLock)
	if err != nil {
		t.Fatalf("%s 를 읽지 못했다: %v", assetsLock, err)
	}
	want := strings.Fields(strings.TrimSpace(string(raw)))
	if len(want) != 2 {
		t.Fatalf("%s 형식이 `<version> <sha256>` 이 아니다: %q", assetsLock, raw)
	}
	if want[0] == ver && want[1] == sum {
		return
	}
	if want[1] != sum && want[0] == ver {
		t.Fatalf(`브라우저로 나가는 자산이 바뀌었는데 `+"`?v=`"+` 가 그대로다 (v=%s).

캐시에 있는 옛 JS 가 계속 돌아 고친 것이 화면에 도달하지 않는다. 둘 다 해야 한다:
  1) web/index.html 의 ?v=%s 를 %s 보다 큰 수로 바꾼다
  2) web/%s 를 아래 한 줄로 바꾼다

     <새 버전> %s`, ver, ver, ver, assetsLock, sum)
	}
	t.Fatalf("%s 가 실물과 다르다.\n  잠금: %s %s\n  실물: %s %s\n아래 한 줄로 바꾼다:\n\n     %s %s",
		assetsLock, want[0], want[1], ver, sum, ver, sum)
}

// hashAssets 는 브라우저가 `?v=` 로 받아 가는 것 전부를 훑는다 — JS 와 CSS 다.
// `index.html` 자신은 넣지 않는다: 그것이 바뀌면 `?v=` 도 그 안에서 바뀌므로
// 서로를 물고 늘어진다.
func hashAssets(t *testing.T) string {
	t.Helper()
	var names []string
	err := fs.WalkDir(files, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		// vendor 는 우리가 고치지 않는 제3자 사본이고, 고치는 순간 파일 이름이
		// 바뀐다 — `?v=` 의 대상이 아니다.
		if strings.HasPrefix(p, "vendor/") {
			return nil
		}
		if path.Ext(p) == ".js" || path.Ext(p) == ".css" {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("자산 순회: %v", err)
	}
	sort.Strings(names)

	h := sha256.New()
	for _, n := range names {
		b, err := fs.ReadFile(files, n)
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		h.Write([]byte(n))
		h.Write([]byte{0})
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// assetVersion 은 `index.html` 이 쓰는 `?v=` 다. 값이 여럿이면 실패한다 — 한 페이지가
// 두 세대의 자산을 섞어 부르면 무효화의 뜻이 사라진다.
func assetVersion(t *testing.T) string {
	t.Helper()
	b, err := fs.ReadFile(files, "index.html")
	if err != nil {
		t.Fatalf("index.html: %v", err)
	}
	m := scriptVerRe.FindAllStringSubmatch(string(b), -1)
	if len(m) == 0 {
		t.Fatal("index.html 에 ?v= 가 없다")
	}
	seen := map[string]bool{}
	for _, g := range m {
		seen[g[1]] = true
	}
	if len(seen) != 1 {
		var got []string
		for v := range seen {
			got = append(got, v)
		}
		sort.Strings(got)
		t.Fatalf("index.html 의 ?v= 가 %v 로 갈렸다 — 한 값이어야 한다", got)
	}
	return m[0][1]
}
