// Package httproute 는 이 서버의 라우팅표 한 벌이다 (DRIFT_RECLAIM_SRS FR-DRC-10).
//
// `httpapi` 와 `gitapi` 는 같은 모양의 표를 각자 들고 있었다 — 구조체 선언도,
// `exactPath` 도, 디스패치 루프도 두 벌이었다. 다른 것은 핸들러가 받는 수신자
// 타입 하나뿐이고, 그것이 타입 매개변수다.
//
// 표를 두 벌로 두면 한쪽에만 들어간 규칙이 다른 쪽에 없다는 사실을 아무것도
// 알려주지 않는다. 실제로 그랬다: `httpapi` 는 접두사 매칭이 필요해 표 안에
// 함수 리터럴을 네 번 적었고 (`strings.HasPrefix(p, "/api/runs/")` …),
// `gitapi` 에는 그 수단 자체가 없었다.
package httproute

import (
	"net/http"
	"strings"
)

// Route 는 method + 경로 매처를 핸들러에 묶는다.
//
// T 는 핸들러가 받는 수신자다 (`*httpapi.Server` · `*gitapi.GitServer`).
// 메서드 표현식(`(*Server).apiFoo`)을 그대로 표에 적을 수 있으므로 표가 곧
// **어느 종단이 어느 핸들러로 가는지의 목록**이 된다.
type Route[T any] struct {
	Method string // "" 이면 아무 method 나 매칭
	Match  func(path string) bool
	Handle func(T, http.ResponseWriter, *http.Request)
}

// Dispatch 는 **첫** 매칭 라우트로 보낸다. 처리했으면 true 다.
//
// 매칭 실패를 여기서 404 로 접지 않는다 — 호출자마다 그다음이 다르다
// (`httpapi` 는 git 표면에 한 번 더 넘기고, `gitapi` 는 false 를 돌려준다).
func Dispatch[T any](routes []Route[T], target T, w http.ResponseWriter, r *http.Request) bool {
	p := r.URL.Path
	for _, rt := range routes {
		if rt.Method != "" && rt.Method != r.Method {
			continue
		}
		if rt.Match(p) {
			rt.Handle(target, w, r)
			return true
		}
	}
	return false
}

// Exact 는 경로가 정확히 같을 때다. 표의 대부분이 이것이다.
func Exact(p string) func(string) bool {
	return func(s string) bool { return s == p }
}

// Under 는 접두사 아래 전부다 — id 가 경로에 오는 종단 (`/api/runs/<id>`).
//
// 이름을 `Prefix` 가 아니라 `Under` 로 둔 이유는 표에서 읽히는 말이 그것이기
// 때문이다: "이 접두사 **아래**의 DELETE".
func Under(prefix string) func(string) bool {
	return func(s string) bool { return strings.HasPrefix(s, prefix) }
}

// UnderWith 는 접두사 아래이면서 지정한 꼬리로 끝나는 것이다
// (`/api/tools/<id>/busy`). 둘을 한 매처로 묶는 이유는 표에 함수 리터럴이
// 들어가는 순간 그 판정이 표 밖에서 읽히지 않기 때문이다.
func UnderWith(prefix, suffix string) func(string) bool {
	return func(s string) bool {
		return strings.HasPrefix(s, prefix) && strings.HasSuffix(s, suffix)
	}
}

// ── 표의 항목을 만드는 생성자 ──
//
// 구조체 리터럴 대신 이것을 쓴다. 표가 짧아지고 (`http.MethodGet` 이 이름
// 하나로 줄어든다), **무키 리터럴이 사라진다** — 다른 패키지의 구조체를
// 위치로 채우면 `go vet` 의 composites 가 잡고, 그것이 맞다: 필드 순서가
// 바뀌면 145줄이 조용히 뒤바뀐다.

// Handler 는 이 표가 부르는 것이다. 메서드 표현식(`(*Server).apiFoo`)이 그대로
// 들어맞는 모양이다.
type Handler[T any] func(T, http.ResponseWriter, *http.Request)

// Get·Post·Put·Delete 는 경로가 정확히 같은 종단이다. 표의 대부분이다.
func Get[T any](path string, h Handler[T]) Route[T]  { return At(http.MethodGet, path, h) }
func Post[T any](path string, h Handler[T]) Route[T] { return At(http.MethodPost, path, h) }
func Put[T any](path string, h Handler[T]) Route[T]  { return At(http.MethodPut, path, h) }
func Delete[T any](path string, h Handler[T]) Route[T] {
	return At(http.MethodDelete, path, h)
}

// Any 는 method 를 가리지 않는 종단이다.
func Any[T any](path string, h Handler[T]) Route[T] { return At("", path, h) }

// At 은 method 와 경로를 직접 준다.
func At[T any](method, path string, h Handler[T]) Route[T] {
	return Route[T]{Method: method, Match: Exact(path), Handle: h}
}

// When 은 경로가 정확히 같지 않은 종단이다 — id 가 경로에 오는 자리
// (`Under`·`UnderWith` 와 함께 쓴다).
func When[T any](method string, m func(string) bool, h Handler[T]) Route[T] {
	return Route[T]{Method: method, Match: m, Handle: h}
}
