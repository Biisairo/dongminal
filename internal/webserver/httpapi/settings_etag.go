package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
)

// settingsTag 은 저장된 설정 본문의 지문이다 (UX_BATCH12 FR-LIV-1). 접속 허용 목록·샌드박스
// 정의·노드 설정의 GET 이 ETag 로 싣고, PUT 이 If-Match 와 견준다. 실행 중에 정해지는 값
// (접속한 주소 등)은 넣지 않는다 — 그것이 바뀌었다고 저장이 낡은 것은 아니다.
func settingsTag(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// settingsStale 은 If-Match 가 있고 지금 지문과 다르면 참이다 (FR-LIV-2). If-Match 가 없으면
// 거짓이다 — `dmctl`·옛 클라이언트는 지금처럼 저장한다 (R-4).
func settingsStale(r *http.Request, cur string) bool {
	im := r.Header.Get("If-Match")
	return im != "" && im != cur
}
