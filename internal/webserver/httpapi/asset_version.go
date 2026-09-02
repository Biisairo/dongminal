package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"path"
	"sort"
	"strings"
)

// 자산의 판 (ASSET_VERSION_SINGLE_SOURCE_SRS 묶음 A).
//
// 브라우저로 나가는 자산은 `?v=` 로만 무효화된다 (`static.go` 의 계약). 그 값을 **사람이
// 적던 때**에는 자산을 고치고 `?v=` 를 그대로 두는 일이 실제로 일어났다 — 두 커밋이
// 그랬고, e2e 는 매번 새 브라우저 컨텍스트라 캐시가 없어 전부 통과했다.
//
// 그래서 판을 자산 자신의 내용에서 뽑는다. 잊을 사람이 없으므로 잊을 수 없다.
const (
	indexPage = "index.html"

	// assetVerPlaceholder 는 `index.html` 이 판을 적는 대신 비워 두는 자리다.
	// 서빙 시점에 채운다 (FR-AVS-4·5).
	assetVerPlaceholder = "__ASSETV__"

	// 판의 길이. 앞자리만 써도 서로 다른 두 빌드가 여기까지 같을 일은 없고, 틀렸을
	// 때의 대가는 "새로고침이 한 번 늦는다" 다.
	assetVerLen = 12
)

// computeAssetVersion 은 브라우저가 `?v=` 로 받아 가는 것 전부 — JS 와 CSS — 를 훑어
// 하나의 판으로 접는다 (FR-AVS-1).
//
// 경로도 해시에 넣는다. 내용을 그대로 둔 채 파일을 옮기거나 이름을 바꾸는 것도 판의
// 변화이며, 내용만 이으면 그것이 보이지 않는다.
func computeAssetVersion(fsys fs.FS) string {
	var names []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		// vendor 는 우리가 고치지 않는 제3자 사본이고, 고치는 순간 파일 이름이
		// 바뀐다 — `?v=` 의 대상이 아니다 (FR-AVS-1a).
		if strings.HasPrefix(p, "vendor/") {
			return nil
		}
		// `index.html` 은 `.js`·`.css` 가 아니어서 저절로 빠진다. 그것이 판을
		// 담으므로 넣으면 서로를 물고 늘어진다 (FR-AVS-1b).
		if ext := path.Ext(p); ext == ".js" || ext == ".css" {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		return ""
	}
	sort.Strings(names)

	h := sha256.New()
	for _, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			continue
		}
		h.Write([]byte(n))
		h.Write([]byte{0})
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))[:assetVerLen]
}
