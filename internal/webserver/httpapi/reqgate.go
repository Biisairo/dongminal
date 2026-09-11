package httpapi

import (
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
)

// 요청 게이트 — 브라우저 매개 공격을 mux 바깥에서 닫는다 (REQUEST_GATE_SRS).
//
// "로컬 전용" 은 네트워크 경계일 뿐이고, 이 서버의 실제 공격면은 브라우저 동일
// 출처 정책의 틈이다. 전제는 하나다 — **사용자가 이 서버를 띄운 채 임의의
// 웹페이지를 연다.** 포트가 고정값이라 추측할 필요도 없다.
//
// 그 페이지가 `POST /api/tools/headless` 한 줄을 보내면 서버가 `sh -c` 를 불렀다.
// `Content-Type: text/plain` 이면 브라우저가 "단순 요청" 으로 취급해 프리플라이트도
// 없고, 응답을 못 읽어도 **부작용은 이미 일어난다.** ACL 은 이것을 막지 못한다 —
// 출발지가 사용자 자신의 기기다.
//
// ── 왜 mux 바깥 한 겹인가 ──
//
// 핸들러마다 뿌리면 새 종단에서 빠진다. `ACCESS_ALLOWLIST_SRS` §2.1 이 같은 논리로
// `accessGate` 를 이 자리에 세웠고, 이 게이트는 그 **안쪽에 직렬로** 선다:
// ACL 이 "어느 기기" 를, 이것이 "어느 출처" 를 본다.
//
//	logging → accessGate(기기) → requestGate(출처) → recover → mux

// hostAllow 는 `Host`·`Origin` 판정에 쓰는 허용 집합이다.
//
// **새 수집 코드를 만들지 않는다** (FR-RQG-6). `accessStore` 가 이미 이 기계의
// 인터페이스 주소를 들고 있고(`self`, FR-ACL-5), 그것을 읽으면 `--expose 0.0.0.0`
// 에서 어느 로컬 IP 로 접속하든 자동으로 통과한다.
type hostAllow struct {
	store *accessStore
	// extra 는 `--allowed-host` 로 명시 추가한 것이다. `*.ts.net` 처럼 접미사
	// 와일드카드를 쓸 수 있다 (13-tls-tailscale §7 요구 ④).
	extra []string
	// hostname 은 이 기계의 이름이다. mDNS(`이름.local`)로 붙는 경로가 흔하다.
	//
	// **이것만으로는 부족하다** — macOS 컴퓨터 이름과 tailnet 노드 이름이 다르면
	// 자기 별명을 자기 것으로 인식하지 못한다(U-18). 그 자리를 채우는 것이
	// `accessStore.hosts`(FR-ACL-25)다.
	hostname string
}

func newHostAllow(store *accessStore, extra []string) *hostAllow {
	h := &hostAllow{store: store, extra: extra}
	if n, err := os.Hostname(); err == nil {
		h.hostname = strings.ToLower(strings.TrimSuffix(n, "."))
	}
	return h
}

// normalizeHost 는 `Host`/`Origin` 값 하나를 호스트 부분만 남겨 소문자로 만든다.
//
// **포트 유무가 판정을 바꾸면 안 된다** (FR-RQG-7). `net.SplitHostPort` 는 포트가
// 없으면 실패하므로, 그 실패를 "포트 없음" 으로 읽는다 — 오류로 읽으면 포트를
// 생략한 정상 요청이 전부 막힌다.
//
// **스킴을 하드코딩하지 않는다.** 평문과 TLS 둘 다 유효한 배치가 있다.
func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	// Origin 은 `<scheme>://<host>[:port]` 다. Host 헤더는 스킴이 없다.
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil {
			return ""
		}
		raw = u.Host
	}
	if h, _, err := net.SplitHostPort(raw); err == nil {
		raw = h
	}
	raw = strings.TrimSuffix(strings.TrimPrefix(raw, "["), "]")
	return strings.ToLower(strings.TrimSuffix(raw, "."))
}

// ok 는 정규화된 호스트 하나가 허용 집합에 드는지 본다.
func (h *hostAllow) ok(host string) bool {
	if host == "" {
		return false
	}
	switch host {
	case "localhost", "127.0.0.1", "::1", "0.0.0.0", "::":
		return true
	}
	if h != nil && h.hostname != "" {
		if host == h.hostname || host == h.hostname+".local" {
			return true
		}
	}
	// 숫자 주소면 이 기계의 것인지 본다. `accessStore.self` 가 `--expose` 에서
	// 쓰는 LAN 주소를 이미 갖고 있다.
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.IsLoopback() {
			return true
		}
		if h != nil && h.store != nil && h.store.isSelf(addr) {
			return true
		}
	}
	if h == nil {
		return false
	}
	for _, e := range h.extra {
		if matchHostPattern(e, host) {
			return true
		}
	}
	// 축② — 사용자가 "이 컴퓨터는 이 이름으로 불린다" 고 적어 둔 목록
	// (`access.json` 의 `hosts`, FR-ACL-25·31). 축①의 출발지 목록은 **보지 않는다**
	// (FR-ACL-32).
	if h.store != nil && h.store.hasHostAlias(host) {
		return true
	}
	return false
}

// matchHostPattern 은 `--allowed-host` 항목 하나를 대조한다. `*.` 로 시작하면
// 접미사 일치이며, 그때 **점 하나를 반드시 포함**한다 — `*.ts.net` 이 `ts.net`
// 자체를 통과시키면 접미사의 뜻이 사라진다.
func matchHostPattern(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == "" {
		return false
	}
	if suffix, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(host, "."+suffix)
	}
	return pattern == host
}

// gateExempt 는 게이트를 지나지 않는 요청이다 (FR-RQG-8).
//
// **경로와 메서드의 짝이다.** 경로로만 두면 그 경로에 새 메서드가 붙는 날 조용히
// 구멍이 된다.
//
// 정적 자산이 여기 드는 이유는 브라우저가 페이지를 받아야 나머지가 시작되기
// 때문이고, 부작용이 없기 때문이다. `/api/ping` 은 기동 대기(`waitReady`)와
// 헬스체크가 쓴다.
func gateExempt(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.URL.Path == "/api/ping" {
		return true
	}
	// `/api/` 도 `/ws` 도 아니면 정적 자산이다 (`Handler()` 의 mux 배치).
	return !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/ws"
}

// isStateChanging 은 부작용을 내는 메서드다.
func isStateChanging(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// requestGate 는 출처 판정 한 겹이다.
//
// 거절은 사유를 상태 코드로 가른다 — Host 421 · Origin/Sec-Fetch 403 ·
// Content-Type 415. 본문에는 허용 목록을 싣지 않는다 (FR-ACL-8 승계): 목록을
// 흘리면 그것이 곧 다음 시도의 입력이 된다.
func requestGate(allow *hostAllow, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gateExempt(r) {
			next.ServeHTTP(w, r)
			return
		}

		// ① Host — 있으면 **항상** 본다. 메서드와 무관하다.
		//
		// DNS 리바인딩은 공격자 도메인을 127.0.0.1 로 해석시켜 브라우저가 같은
		// 출처라고 믿게 만든다. 그때 `Origin` 과 `Host` 가 둘 다 공격자 도메인이라
		// "Origin == Host" 식의 검사는 통과한다. 그리고 그 공격의 목적은 응답을
		// **읽는** 것이므로 상태 변경 메서드만 보면 놓친다.
		if r.Host != "" && !allow.ok(normalizeHost(r.Host)) {
			// **고칠 수 있는 자리를 가리킨다** (FR-RQG-9 개정). 이전 문구는
			// `--allowed-host` 를 안내했는데 그 플래그는 CLI 에 배선돼 있지 않아
			// 사용자가 쓸 수 없는 수단이었다 (U-18).
			gateDeny(w, r, http.StatusMisdirectedRequest, "host",
				"허용되지 않은 Host 입니다 — 설정 ▸ 접속 의 '이 컴퓨터의 별명' 에 이 이름을 추가하세요")
			return
		}

		// ② Origin — 있으면 대조한다. **없으면 통과한다.**
		//
		// 비브라우저 클라이언트(`dmctl`·`curl`·CI)는 `Origin` 을 싣지 않는다.
		// 거부하면 `helper/runtimebin` 을 지나는 호출 17곳이 전부 막힌다.
		if o := r.Header.Get("Origin"); o != "" && !allow.ok(normalizeHost(o)) {
			gateDeny(w, r, http.StatusForbidden, "origin", "forbidden")
			return
		}

		if !isStateChanging(r.Method) {
			next.ServeHTTP(w, r)
			return
		}

		// ③ Sec-Fetch-Site — 브라우저가 스스로 붙이는 값이라 위조되지 않는다.
		// 헤더가 없으면 판정하지 않는다(비브라우저·구형 브라우저).
		switch r.Header.Get("Sec-Fetch-Site") {
		case "", "same-origin", "same-site", "none":
		default:
			gateDeny(w, r, http.StatusForbidden, "sec-fetch-site", "forbidden")
			return
		}

		// ④ Content-Type — **이것이 "단순 요청" 우회를 닫는다.**
		//
		// 브라우저는 `text/plain`·`application/x-www-form-urlencoded`·
		// `multipart/form-data` 인 POST 를 프리플라이트 없이 보낸다. JSON 을
		// 요구하면 프리플라이트가 강제되고, 그 프리플라이트에 우리가 답하지
		// 않으므로 교차 출처 요청은 출발 자체를 하지 못한다.
		if !gateContentTypeOK(r) {
			gateDeny(w, r, http.StatusUnsupportedMediaType, "content-type",
				"application/json 또는 multipart/form-data 여야 합니다")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// gateContentTypeOK 는 상태 변경 요청의 본문 형식을 본다.
//
// `multipart/form-data` 를 허용하는 이유는 업로드다. 그 경로는 이미 자기
// `MaxBytesReader` 를 갖고 있고(FR-RQG-15), 교차 출처에서는 `Origin` 이 먼저
// 걸린다.
func gateContentTypeOK(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	switch strings.ToLower(strings.TrimSpace(ct)) {
	case "application/json", "multipart/form-data":
		return true
	}
	return false
}

func gateDeny(w http.ResponseWriter, r *http.Request, code int, why, msg string) {
	// 거절을 남긴다. 무엇이 왜 막혔는지 사후에 특정할 수 없으면, 사용자는
	// "안 된다" 만 받고 우리는 그것이 방어인지 결함인지 가를 수 없다.
	log.Printf("request denied why=%s addr=%s host=%q origin=%q %s %s",
		why, r.RemoteAddr, r.Host, r.Header.Get("Origin"), r.Method, r.URL.Path)
	http.Error(w, msg, code)
}
