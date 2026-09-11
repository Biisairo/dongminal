package httpapi

import (
	"net/http"

	"dongminal/internal/shared/dmlog"
)

// 요청 ID 미들웨어 (OBSERVABILITY_SRS 묶음 R).
//
// 종전에는 접근 로그와 핸들러 로그가 서로를 가리키지 않았다. 동시 요청이 둘이면
// 어느 줄이 어느 요청인지 **시각으로 짐작**해야 했고, 그 짐작은 자주 틀린다.
//
// **체인의 맨 바깥이다** (D-OBS-2). 게이트보다 앞에 서는 이유는 거절된 요청이야말로
// 사용자가 묻는 자리이기 때문이다 — 뒤에 두면 "왜 403 이 났는가" 에 답할 실마리가
// 그 요청에만 없다.

// reqIDMiddleware 는 요청마다 ID 를 정해 컨텍스트와 응답 헤더에 싣는다.
func reqIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// FR-OBS-7: 밖에서 온 값은 **검사를 지나야** 쓰인다. 고쳐서 쓰지 않는다 —
		// 줄바꿈을 지운 값은 보낸 쪽이 의도한 값도 우리가 만든 값도 아니어서,
		// 그 ID 로 무언가를 추적하면 거짓 실마리가 된다.
		id := dmlog.SanitizeReqID(r.Header.Get(dmlog.ReqIDHeader))
		if id == "" {
			id = dmlog.NewReqID()
		}
		// 헤더를 **먼저** 세운다. 거절 핸들러가 곧바로 응답을 시작할 수 있고,
		// 그 뒤에 얹은 헤더는 나가지 않는다.
		w.Header().Set(dmlog.ReqIDHeader, id)
		next.ServeHTTP(w, r.WithContext(dmlog.WithReqID(r.Context(), id)))
	})
}
