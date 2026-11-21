package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"dongminal/internal/shared/httpreq"
	"net/netip"
	"strings"

	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/sse"
)

// 허용 목록의 HTTP 면 — 출발지 판정, 게이트, /api/access 종단 (ACCESS_ALLOWLIST_SRS).

// remoteIP 는 요청의 출발지다.
//
// **`X-Forwarded-For` 를 보지 않는다** (FR-ACL-6). 클라이언트가 쓸 수 있는 값을
// 신뢰하면 목록이 헤더 한 줄로 무력화된다.
func remoteIP(remoteAddr string) (netip.Addr, bool) {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	if i := strings.Index(host, "%"); i >= 0 {
		host = host[:i] // zone 제거 (fe80::1%en0)
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

// accessGate 는 목록에 없는 출발지를 끊는다.
//
// **`loggingMiddlewareFor` 안쪽, `recoverMiddleware` 바깥쪽에 선다** (FR-ACL-10).
// 로깅 안쪽이어야 거절이 접근 로그에 남고, 그것이 "목록을 켰는데 접속이 안 된다"
// 를 풀 유일한 근거다. mux 바깥이므로 정적 자산·/api/*·/ws 가 한 겹에 덮인다
// (FR-ACL-11) — 핸들러마다 검사를 뿌리면 새 종단이 생길 때마다 빠뜨린다.
func accessGate(store *accessStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			next.ServeHTTP(w, r)
			return
		}
		addr, ok := remoteIP(r.RemoteAddr)
		if ok && store.allowed(addr) {
			next.ServeHTTP(w, r)
			return
		}
		if !ok && !store.match.Load().enabled {
			// 출발지를 읽지 못했고 목록도 꺼져 있다 — 막을 근거가 없다.
			next.ServeHTTP(w, r)
			return
		}
		// FR-ACL-13: 출발지와 경로를 남긴다.
		// FR-OBS-9: 거절도 요청 ID 를 든다 — 거절이야말로 사용자가 묻는 자리다.
		countAccessDenied()
		dmlog.Infof(r.Context(), "access denied addr=%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
		// FR-ADP-1: 문서 요청이면 **화면**을 준다 — 평문 `forbidden` 은 사용자가
		// 무엇을 해야 하는지 말하지 않는다. 그 밖(API·/ws)은 그대로 평문이다.
		//
		// FR-ACL-8 은 그대로다: 화면에 실리는 것은 **요청자 자신의 IP** 뿐이고
		// 목록은 한 줄도 나가지 않는다.
		if wantsDeniedPage(r) {
			// **읽지 못했어도 빈칸으로 두지 않는다.** 이 화면의 목적이 "이 주소를
			// 소유자에게 알린다" 이므로, 정규화에 실패했으면 원문이라도 준다 —
			// 알릴 것이 없으면 화면이 있으나 마나다.
			shown := r.RemoteAddr
			if ok {
				shown = addr.String()
			}
			writeDeniedPage(w, shown)
			return
		}
		httpErr(w, "forbidden", http.StatusForbidden, apierr.CodeForbidden)
	})
}

func (s *Server) apiAccessGet(w http.ResponseWriter, r *http.Request) {
	if s.Access == nil {
		httpErr(w, "access store unavailable", http.StatusServiceUnavailable, apierr.CodeAccessUnready)
		return
	}
	v := s.Access.view()
	if addr, ok := remoteIP(r.RemoteAddr); ok {
		v.You = addr.String()
	}
	// FR-ACL-35: 서버가 자기를 무엇으로 아는지(`hostname`)와 지금 어떤 이름으로
	// 불렸는지(`host`)를 함께 준다. U-18 에서 사용자가 알 방법이 없던 둘이다.
	if s.hosts != nil {
		v.Hostname = s.hosts.hostname
	}
	v.Host = normalizeHost(r.Host)
	w.Header().Set("ETag", settingsTag(s.Access.config()))
	httpresp.JSON(w, http.StatusOK, v)
}

func (s *Server) apiAccessPut(w http.ResponseWriter, r *http.Request) {
	if s.Access == nil {
		httpErr(w, "access store unavailable", http.StatusServiceUnavailable, apierr.CodeAccessUnready)
		return
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), apierr.BodyReadCode(err))
		return
	}
	var cfg accessConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	if !s.accessSave(w, r, cfg) {
		return
	}
	// 해석은 설정 잠금 **밖**이다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-4) — 느린 DNS 가 다른
	// 설정 PUT 을 세우지 않는다. 응답·알림보다는 앞이라 저장 직후의 GET 이 해석 결과를 본다.
	s.Access.refresh()
	// 저장이 끝난 **뒤에** 알린다 — 받은 창이 곧바로 GET 하므로, 먼저 알리면
	// 그 GET 이 옛 값을 읽을 수 있다 (settings 와 같은 규약).
	if s.Commands != nil {
		s.Commands.Broadcast(accessChangedPayload())
	}
	w.Header().Set("ETag", settingsTag(s.Access.config()))
	w.WriteHeader(http.StatusOK)
}

// accessSave 는 지문 검사와 저장을 설정 잠금 하나로 묶는다 (UX_BATCH12 FR-LIV-2). 실패면
// 응답을 쓰고 false 다.
func (s *Server) accessSave(w http.ResponseWriter, r *http.Request, cfg accessConfig) bool {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if cur := settingsTag(s.Access.config()); settingsStale(r, cur) {
		w.Header().Set("ETag", cur)
		httpErr(w, "stale revision", http.StatusConflict, apierr.CodeStaleRev)
		return false
	}
	if err := s.Access.save(cfg); err != nil {
		if errors.Is(err, errAccessSaveFailed) {
			fail(w, http.StatusInternalServerError, err.Error(), nil)
			return false
		}
		// **검증 실패의 사유는 그대로 보인다.** 어느 줄이 잘못됐는지 모르면 사용자가
		// 고칠 수 없다 — `app-settings.js` 의 `_aclSave` 가 이 본문을 그대로 띄운다.
		// 그 문구는 사용자가 방금 보낸 값과 우리가 쓴 설명뿐이다.
		fail(w, http.StatusBadRequest, err.Error(), nil)
		return false
	}
	return true
}

// apiAccessCheck 는 저장 전 잠김 경고의 답이다 (X-d). 본문은 PUT 과 같고, 검증 실패도 같은 400 이다.
func (s *Server) apiAccessCheck(w http.ResponseWriter, r *http.Request) {
	if s.Access == nil {
		httpErr(w, "access store unavailable", http.StatusServiceUnavailable, apierr.CodeAccessUnready)
		return
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), apierr.BodyReadCode(err))
		return
	}
	var cfg accessConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	you, ok := remoteIP(r.RemoteAddr)
	if !ok {
		// 출발지를 모르면 잠길지도 모른다 — 경고하지 않는다(화면의 종전 규칙과 같다).
		httpresp.JSON(w, http.StatusOK, map[string]any{"actions": map[string]action.Answer{action.AccessSave: action.Allow()}})
		return
	}
	a, err := s.Access.checkSave(cfg, you)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"actions": map[string]action.Answer{action.AccessSave: a},
		"you": you.Unmap().String()})
}

func accessChangedPayload() []byte {
	return sse.Payload("access_changed", map[string]any{})
}

// StartAccessRefresh 는 허용 목록의 주기 갱신을 서버 수명에 건다. 다른 Start*
// 와 같은 자리에서 불린다 (cmd/dongminal).
func (s *Server) StartAccessRefresh(done <-chan struct{}) {
	if s.Access == nil {
		return
	}
	s.Access.startRefresh(done, DefaultAccessRefresh)
}
