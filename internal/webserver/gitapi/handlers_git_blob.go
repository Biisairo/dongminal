package gitapi

import (
	"net/http"
	"strconv"

	"dongminal/internal/shared/mimeprobe"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// GET /api/git/blob?repo=&axis=&path=&origPath=&oid=&parentOid=&side= — diff 한쪽의
// **원본 바이트** (M9_SRS FR-M9-21).
//
// `<img src>` 가 이 URL 을 그대로 건다. base64 로 `diff-content` 에 실어 보내는
// 대안을 택하지 않은 이유는 D-M9-14 에 있다 — 4/3 로 부풀고, 브라우저의 이미지
// 캐시와 조건부 요청을 통째로 잃는다.
//
// **잠금장치는 `/api/file/raw` 의 것을 그대로 쓴다** (FR-EVW-5·6 · FR-DRV-24):
// 이미지와 SVG **만** 내보내고, `nosniff` 를 달고, SVG 에는
// `Content-Security-Policy: sandbox` 를 함께 보낸다. 임의의 파일을 추론된 MIME 으로
// 같은 출처에서 인라인 제공하면 저장형 XSS 이고, **그것은 저장소 안의 파일이라고
// 달라지지 않는다.** 판정도 같은 한 벌이다 (`mimeprobe`).
func (s *GitServer) apiGitBlob(w http.ResponseWriter, r *http.Request) {
	root, _, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	if s.Images == nil {
		// D-M9-16: 주입이 없으면 공용 서비스로 떨어지지 않는다 — 그쪽은 1MiB 에서
		// 자르고, 잘린 그림은 "깨진 파일" 로만 보인다.
		gitFail(w, http.StatusServiceUnavailable, apierr.CodeUnavailable, "그림 전용 git 실행기가 없다")
		return
	}
	q := r.URL.Query()
	body, err := query.SideBytes(s.Images, r.Context(), root,
		q.Get("axis"), q.Get("path"), q.Get("origPath"), q.Get("oid"), q.Get("parentOid"), q.Get("side"))
	if err != nil {
		gitError(w, err)
		return
	}
	mime := mimeprobe.ImageMime(body)
	if mime == "" {
		gitFail(w, http.StatusUnsupportedMediaType, apierr.CodeNotAnImage, "not an image")
		return
	}
	if mime == mimeprobe.SVGMime {
		// 사용자가 이 URL 을 주소창에 직접 열었을 때 문서의 스크립트가 우리
		// 출처에서 도는 것을 막는 것은 이 헤더뿐이다. `<img>` 안에서 안전한 것과
		// 그것은 다른 이야기다 (FR-DRV-24).
		w.Header().Set("Content-Security-Policy", "sandbox")
	}
	w.Header().Set("Content-Type", mime)
	// 브라우저가 우리가 정한 형식을 다시 추론하지 않게 한다 (FR-EVW-6).
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	w.Write(body)
}
