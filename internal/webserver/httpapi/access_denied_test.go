package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ACCESS_DENIED_PAGE_SRS §5 — 막힌 화면의 검증 V-ADP-1~7.
//
// 접수한 말: *"ip 맞지않아 막힐 때 보여지는 페이지 만들어줘. 로딩페이지랑 비슷하게
// 톤앤매너 맞춰서. 여기에는 막힌 본인의 ip, 그리고 해당 서버 소유자에게 문의하라는
// 내용이 있어야해."*

func deniedResponse(t *testing.T, accept, mode, upgrade string) *httptest.ResponseRecorder {
	t.Helper()
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := apiTestRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.9:5000"
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if mode != "" {
		req.Header.Set("Sec-Fetch-Mode", mode)
	}
	if upgrade != "" {
		req.Header.Set("Upgrade", upgrade)
	}
	rec := httptest.NewRecorder()
	accessGate(st, ok).ServeHTTP(rec, req)
	return rec
}

// V-ADP-1: 문서 요청이면 **화면**이다. 상태는 그대로 403 이다.
func TestAccessDenied_DocumentGetsPage(t *testing.T) {
	rec := deniedResponse(t, "text/html,application/xhtml+xml", "navigate", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d want 403", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type=%q — 문서 요청에는 화면을 준다", ct)
	}
	body := rec.Body.String()
	// V-ADP-2: **자기 IP 가 보인다.** 무엇 때문에 막혔는지 모르면 고칠 수 없다.
	if !strings.Contains(body, "203.0.113.9") {
		t.Fatalf("자기 IP 가 없다:\n%s", body)
	}
	// V-ADP-3: 소유자에게 문의하라는 말이 있다.
	if !strings.Contains(body, "소유자") {
		t.Fatalf("문의 안내가 없다:\n%s", body)
	}
}

// V-ADP-9: **거부됐다는 사실이 먼저 읽혀야 한다** (사용자 요구: *"확실하게 너는
// 거부되었다는 걸 알려주는 게 중요해. 로딩에 글자만 바꾸지 말고 다른 오류창처럼"*).
//
// 그래서 재는 것이 문구 하나가 아니다 — 제목 · 상태 코드 · **경고색**이 함께
// 있어야 오류 화면으로 읽힌다.
func TestAccessDenied_ReadsAsAnError(t *testing.T) {
	body := deniedResponse(t, "text/html", "navigate", "").Body.String()
	for _, want := range []string{
		"차단",      // 무슨 일이 일어났는가
		"403",     // 그것의 이름
		"#f7768e", // 경고색 — 부트 화면에는 없는 것이다
		"<h1",     // 제목이 제목의 자리에 있다
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("오류 화면으로 읽히지 않는다 — %q 가 없다:\n%s", want, body)
		}
	}
	// 로딩 화면의 부속(흐르는 진행 바)이 남아 있으면 그것은 아직 로딩 화면이다.
	for _, no := range []string{"boot-bar", "진행", "불러옵니다"} {
		if strings.Contains(body, no) {
			t.Fatalf("로딩 화면의 부속이 남아 있다 (%q)", no)
		}
	}
}

// V-ADP-4: FR-ACL-8 은 그대로다 — **목록 내용은 싣지 않는다.**
func TestAccessDenied_PageLeaksNoList(t *testing.T) {
	body := deniedResponse(t, "text/html", "navigate", "").Body.String()
	for _, leak := range []string{"10.0.0.1", "allow", "entries"} {
		if strings.Contains(body, leak) {
			t.Fatalf("응답이 목록을 누설한다 (%q):\n%s", leak, body)
		}
	}
}

// V-ADP-5: 문서가 아닌 요청은 **평문 그대로**다. API 클라이언트에 HTML 을 주면
// 그쪽의 오류 처리가 그것을 파싱하려 든다.
func TestAccessDenied_NonDocumentStaysPlain(t *testing.T) {
	for _, tc := range []struct{ accept, mode, upgrade string }{
		{"application/json", "cors", ""},
		{"", "", ""},
		{"text/html", "websocket", "websocket"}, // /ws 는 문서가 아니다
	} {
		rec := deniedResponse(t, tc.accept, tc.mode, tc.upgrade)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status=%d want 403", rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); strings.HasPrefix(ct, "text/html") {
			t.Fatalf("accept=%q mode=%q 인데 화면을 줬다", tc.accept, tc.mode)
		}
	}
}

// V-ADP-6: 이 화면은 **자족적이어야 한다.** 막힌 출발지는 CSS·JS 도 받지 못한다
// (FR-ACL-11: 정적 자산도 같은 게이트를 지난다) — 그래서 바깥 자산을 참조하면
// 그 화면은 영영 맨몸으로 뜬다.
func TestAccessDenied_PageIsSelfContained(t *testing.T) {
	body := deniedResponse(t, "text/html", "navigate", "").Body.String()
	for _, ref := range []string{"<script", "src=", "href=", "@import"} {
		if strings.Contains(body, ref) {
			t.Fatalf("바깥 자산을 참조한다 (%q) — 막힌 출발지는 그것도 받지 못한다:\n%s", ref, body)
		}
	}
}

// V-ADP-7: 인라인 스크립트가 없으므로 CSP 를 그대로 붙일 수 있다. 붙인다 —
// 이 응답만 정책 없이 나가면 그 자리가 예외가 된다.
func TestAccessDenied_PageCarriesCSP(t *testing.T) {
	rec := deniedResponse(t, "text/html", "navigate", "")
	csp := rec.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("차단 화면에 CSP 가 없다")
	}
	if strings.Contains(csp, "unsafe-inline") && !strings.Contains(csp, "style-src") {
		t.Fatalf("script 에 unsafe-inline 이 열렸다: %q", csp)
	}
}

// V-ADP-8: 주소를 정규화하지 못해도 **알릴 것을 준다.** 이 화면의 목적이 그것이다 —
// *"본인 접근 ip 가 있어야 서버장한테 알릴 수 있으므로 보여준다."*
func TestAccessDenied_UnparsableAddrStillShowsSomething(t *testing.T) {
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := apiTestRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "pipe" // 주소가 아니다 (테스트 전송·유닉스 소켓에서 실제로 이렇다)
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	rec := httptest.NewRecorder()
	accessGate(st, ok).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d want 403", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "pipe") {
		t.Fatalf("알릴 주소가 화면에 없다:\n%s", body)
	}
}
