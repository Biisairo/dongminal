package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

// REQUEST_GATE_SRS §4.1 — 요청 게이트 (TC-RQG-1~13 · 27~33).
//
// 재는 것은 하나다: **브라우저가 다른 출처의 지시로 보낸 요청이 부작용을 내는가.**
//
// 전제는 "사용자가 dongminal 을 띄운 채 임의의 웹페이지를 연다" 하나이고, 포트가
// 고정값이라 추측할 필요도 없다. 그 페이지가 `POST /api/tools/headless` 한 줄로
// `sh -c` 를 부를 수 있었고 — 응답을 못 읽어도 부작용은 이미 일어난다 — ACL 은 그것을
// 막지 못했다(출발지가 사용자 자신의 기기다).

// gateSrv 는 게이트만 태운 서버다. 핸들러의 동작이 아니라 **게이트의 판정**을 재므로
// 뒤에 무엇이 있는지는 중요하지 않다.
func gateSrv(t *testing.T) *httptest.Server {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// gateReq 는 헤더를 실은 요청 하나를 보내고 상태 코드를 준다.
func gateReq(t *testing.T, ts *httptest.Server, method, path string, hdr map[string]string) int {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	for k, v := range hdr {
		if v == "" {
			req.Header.Del(k)
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// json 은 "정상적인 브라우저의 same-origin 요청" 한 벌이다. 각 검사는 여기서 **한
// 가지만** 바꾼다 — 그래야 무엇이 판정을 뒤집었는지 말할 수 있다.
func okHeaders(ts *httptest.Server) map[string]string {
	return map[string]string{
		"Content-Type":   "application/json",
		"Origin":         ts.URL,
		"Sec-Fetch-Site": "same-origin",
	}
}

// TC-RQG-1: 다른 출처의 페이지가 보낸 상태 변경 요청은 거절된다.
func TestReqGate_CrossOriginPostRejected(t *testing.T) {
	ts := gateSrv(t)
	h := okHeaders(ts)
	h["Origin"] = "https://evil.example"
	if got := gateReq(t, ts, "POST", "/api/tools/headless", h); got != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 임의 웹페이지가 셸을 만들 수 있다", got)
	}
}

// TC-RQG-2: `Origin` 없는 요청은 통과한다.
//
// **이것을 거부하면 안 된다.** `dmctl` 은 `helper/runtimebin` 의 클라이언트를 지나고
// 호출부가 17곳/9파일인데 전부 `Origin` 을 싣지 않는다 — 거부하면 에이전트
// 오케스트레이션이 통째로 멎는다.
func TestReqGate_NoOriginAllowed(t *testing.T) {
	ts := gateSrv(t)
	h := okHeaders(ts)
	delete(h, "Origin")
	delete(h, "Sec-Fetch-Site")
	if got := gateReq(t, ts, "POST", "/api/tools/headless", h); got == http.StatusForbidden {
		t.Fatalf("Origin 없는 비브라우저 클라이언트가 막혔다 (dmctl 17곳)")
	}
}

// TC-RQG-3: `Content-Type` 검사가 "단순 요청" 우회를 닫는다.
//
// 브라우저는 `text/plain` POST 를 단순 요청으로 취급해 프리플라이트 없이 보낸다.
// 서버가 Content-Type 을 보지 않고 본문을 JSON 으로 파싱하면 그대로 통과한다.
func TestReqGate_TextPlainRejected(t *testing.T) {
	ts := gateSrv(t)
	h := okHeaders(ts)
	h["Content-Type"] = "text/plain"
	if got := gateReq(t, ts, "POST", "/api/tools/headless", h); got != http.StatusUnsupportedMediaType {
		t.Fatalf("status=%d want 415 — 프리플라이트 없는 단순 요청이 통과한다", got)
	}
}

// TC-RQG-4: 정상 경로는 게이트를 지난다. 게이트가 자기 화면을 막으면 안 된다.
func TestReqGate_SameOriginJSONPasses(t *testing.T) {
	ts := gateSrv(t)
	got := gateReq(t, ts, "POST", "/api/tools/headless", okHeaders(ts))
	if got == http.StatusForbidden || got == http.StatusUnsupportedMediaType ||
		got == http.StatusMisdirectedRequest {
		t.Fatalf("status=%d — 정상 same-origin 요청이 게이트에 걸렸다", got)
	}
}

// TC-RQG-5: `Sec-Fetch-Site: cross-site` 는 거절이다.
func TestReqGate_CrossSiteFetchRejected(t *testing.T) {
	ts := gateSrv(t)
	h := okHeaders(ts)
	h["Sec-Fetch-Site"] = "cross-site"
	if got := gateReq(t, ts, "POST", "/api/tools/headless", h); got != http.StatusForbidden {
		t.Fatalf("status=%d want 403", got)
	}
}

// TC-RQG-6: `Host` 는 **GET 에서도** 대조한다.
//
// DNS 리바인딩은 공격자 도메인의 A 레코드를 127.0.0.1 로 바꿔 브라우저가 같은
// 출처라고 믿게 만든다. 그때 `Origin` 과 `Host` 가 **둘 다** `evil.example` 이라
// "Origin == Host" 식의 검사는 통과한다. 그리고 그 공격의 목적은 응답을 읽는 것
// 이므로 상태 변경 메서드만 보면 놓친다.
func TestReqGate_UnknownHostRejectedOnGet(t *testing.T) {
	ts := gateSrv(t)
	req, _ := http.NewRequest("GET", ts.URL+"/api/state", nil)
	req.Host = "evil.example"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("status=%d want 421 — DNS 리바인딩이 통과한다", resp.StatusCode)
	}
}

// TC-RQG-7: 자기 주소·loopback·바인드 주소는 통과한다.
func TestReqGate_KnownHostsPass(t *testing.T) {
	ts := gateSrv(t)
	for _, host := range []string{"localhost", "localhost:58146", "127.0.0.1", "127.0.0.1:58146", "[::1]:58146"} {
		req, _ := http.NewRequest("GET", ts.URL+"/api/ping", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("Do(%s): %v", host, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusMisdirectedRequest {
			t.Fatalf("Host %q 가 거절됐다", host)
		}
	}
}

// TC-RQG-8: 포트 유무가 판정을 바꾸지 않는다.
func TestReqGate_PortNormalized(t *testing.T) {
	ts := gateSrv(t)
	withPort, without := 0, 0
	for host, out := range map[string]*int{"127.0.0.1:9999": &withPort, "127.0.0.1": &without} {
		req, _ := http.NewRequest("GET", ts.URL+"/api/ping", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("Do: %v", err)
		}
		resp.Body.Close()
		*out = resp.StatusCode
	}
	if withPort != without {
		t.Fatalf("포트 유무가 판정을 갈랐다: %d vs %d", withPort, without)
	}
}

// TC-RQG-9: `X-Forwarded-*` 는 판정을 바꾸지 않는다 (FR-ACL-6 승계).
func TestReqGate_ForwardedHeadersIgnored(t *testing.T) {
	ts := gateSrv(t)
	req, _ := http.NewRequest("GET", ts.URL+"/api/state", nil)
	req.Host = "evil.example"
	req.Header.Set("X-Forwarded-Host", "localhost")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("status=%d — X-Forwarded-Host 가 판정을 뒤집었다", resp.StatusCode)
	}
}

// TC-RQG-10: 예외 경로는 게이트를 지나지 않는다.
//
// 정적 자산이 막히면 브라우저가 페이지를 받지 못해 나머지가 시작되지 않는다.
// `/api/ping` 은 기동 대기(`waitReady`)와 헬스체크가 쓰며 부작용이 없다.
func TestReqGate_ExemptPaths(t *testing.T) {
	ts := gateSrv(t)
	for _, path := range []string{"/", "/api/ping"} {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		req.Header.Set("Origin", "https://evil.example")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("Do(%s): %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusForbidden {
			t.Fatalf("%s 가 게이트에 막혔다 — 예외 경로다", path)
		}
	}
}

// TC-RQG-11: 예외는 **경로와 메서드의 짝**이다.
//
// 경로로만 두면 그 경로에 새 메서드가 붙는 날 조용히 구멍이 된다.
func TestReqGate_ExemptIsMethodScoped(t *testing.T) {
	ts := gateSrv(t)
	h := okHeaders(ts)
	h["Origin"] = "https://evil.example"
	if got := gateReq(t, ts, "POST", "/api/ping", h); got != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — POST /api/ping 이 예외로 샜다", got)
	}
}

// TC-RQG-12: 거절이 로그에 남고 본문에 허용 목록이 없다 (FR-ACL-8 승계).
func TestReqGate_DenyIsLoggedAndOpaque(t *testing.T) {
	ts := gateSrv(t)
	buf := captureLog(t)
	req, _ := http.NewRequest("POST", ts.URL+"/api/tools/headless", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	b := make([]byte, 512)
	n, _ := resp.Body.Read(b)
	body := string(b[:n])

	out := buf.String()
	if !strings.Contains(out, "evil.example") && !strings.Contains(out, "/api/tools/headless") {
		t.Fatalf("거절이 로그에 남지 않았다: %q", out)
	}
	if strings.Contains(body, "127.0.0.1") || strings.Contains(body, "localhost") {
		t.Fatalf("응답 본문이 허용 목록을 흘렸다: %q", body)
	}
}

// ── TC-RQG-13·27~33 — 이 컴퓨터의 별명 (축②, U-18) ────────────────
//
// 여기가 U-18 의 자리다. tailnet 의 다른 기기에서 IP 로는 붙고 **이름으로는
// 421** 이었다 — 서버가 자기 이름을 `os.Hostname()` 으로만 알아 tailnet 별명을
// 자기 것으로 인식하지 못했고, 그 이름을 적을 자리가 UI 에 없었다.

// gateSrvWith 는 별명 목록과 `--allowed-host` 를 실은 게이트 서버다. DNS·인터페이스
// 수집은 주입으로 끊는다 — 판정이 이 기계의 네트워크 상태에 좌우되면 무엇을
// 검증했는지 말할 수 없다.
func gateSrvWith(t *testing.T, cfg accessConfig, allowedHosts []string) *httptest.Server {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir(), AllowedHosts: allowedHosts}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	srv.Access.lookupHost = func(string) ([]string, error) { return nil, nil }
	srv.Access.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	if err := srv.Access.setConfig(cfg); err != nil {
		t.Fatalf("setConfig: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// hostStatus 는 그 이름으로 불린 요청의 상태 코드와 본문이다. 예외 경로가 아닌
// 종단을 쓴다 — `/api/ping` 은 게이트를 지나지 않는다(FR-RQG-8).
func hostStatus(t *testing.T, ts *httptest.Server, host string) (int, string) {
	t.Helper()
	req, err := http.NewRequest("GET", ts.URL+"/api/state", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do(%s): %v", host, err)
	}
	defer resp.Body.Close()
	b := make([]byte, 512)
	n, _ := resp.Body.Read(b)
	return resp.StatusCode, string(b[:n])
}

// TC-RQG-27: **U-18 의 재현.** 별명 목록에 있는 이름으로 들어오면 통과한다.
func TestReqGate_HostAliasPasses(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Hosts: []accessEntry{entry("macmini-office")}}, nil)
	if got, _ := hostStatus(t, ts, "macmini-office:58146"); got == http.StatusMisdirectedRequest {
		t.Fatalf("status=%d — 별명이 등록됐는데 이름으로 붙지 못한다 (U-18)", got)
	}
}

// TC-RQG-28: 목록에 없는 이름은 421 이고, 본문은 목록을 흘리지 않는다
// (FR-ACL-8 승계). 목록을 흘리면 그것이 곧 다음 시도의 입력이 된다.
func TestReqGate_UnknownAliasRejectedWithoutLeaking(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Hosts: []accessEntry{entry("secret-name")}}, nil)
	got, body := hostStatus(t, ts, "evil.example")
	if got != http.StatusMisdirectedRequest {
		t.Fatalf("status=%d want 421", got)
	}
	if strings.Contains(body, "secret-name") {
		t.Fatalf("응답 본문이 별명 목록을 흘렸다: %q", body)
	}
}

// TC-RQG-29: 포트 유무·대소문자·후행 점이 판정을 바꾸지 않는다. 하나라도 갈리면
// 사용자는 "어제는 됐는데" 를 겪는다.
func TestReqGate_HostAliasNormalization(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Hosts: []accessEntry{entry("macmini-office")}}, nil)
	for _, host := range []string{"macmini-office", "macmini-office:9999", "MACMINI-OFFICE", "macmini-office."} {
		if got, _ := hostStatus(t, ts, host); got == http.StatusMisdirectedRequest {
			t.Errorf("Host %q 가 거절됐다", host)
		}
	}
}

// TC-RQG-30: 같은 목록이 `Origin` 에도 적용된다 — 두 헤더가 한 판정 함수를
// 지나는 것이 FR-RQG-3 의 설계다 (FR-ACL-31).
func TestReqGate_HostAliasAppliesToOrigin(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Hosts: []accessEntry{entry("macmini-office")}}, nil)
	h := okHeaders(ts)
	h["Origin"] = "http://macmini-office:58146"
	if got := gateReq(t, ts, "POST", "/api/tools/headless", h); got == http.StatusForbidden {
		t.Fatalf("status=%d — 등록된 별명의 Origin 이 막혔다", got)
	}
}

// TC-RQG-31: 꺼 둔 별명은 통과시키지 않는다 (FR-ACL-26 · FR-ACL-17 승계).
func TestReqGate_DisabledAliasIsIgnored(t *testing.T) {
	off := entry("macmini-office")
	off.Enabled = false
	ts := gateSrvWith(t, accessConfig{Hosts: []accessEntry{off}}, nil)
	if got, _ := hostStatus(t, ts, "macmini-office"); got != http.StatusMisdirectedRequest {
		t.Fatalf("status=%d want 421 — 꺼 둔 별명이 통과시켰다", got)
	}
}

// TC-RQG-32: **적용 토글이 꺼져 있어도 별명은 적용된다** (FR-ACL-26).
//
// Host 판정은 토글과 무관하게 항상 돈다(FR-RQG-2). 토글에 매면 목록을 끈
// 사용자(=기본값)의 이름 접속이 그대로 막히고, 그것이 U-18 의 증상이다.
func TestReqGate_AliasIndependentOfEnforcementToggle(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Enabled: false, Hosts: []accessEntry{entry("macmini-office")}}, nil)
	if got, _ := hostStatus(t, ts, "macmini-office"); got == http.StatusMisdirectedRequest {
		t.Fatalf("status=%d — 토글이 꺼졌다고 별명 판정이 죽었다", got)
	}
}

// TC-RQG-33: **동작 변경의 증거** (FR-ACL-32). 축①(출발지 목록)에만 있는 이름은
// 이제 Host 로 인정되지 않는다.
//
// 이전에는 `hasHostname` 이 그것을 인정했고, 그 자리가 두 축을 섞어 사용자가
// 축②에 무엇을 적어야 하는지 알 수 없게 만들었다. 축①의 항목은 *타 기기* 이름
// 이므로 이 서버를 그 이름으로 부를 일이 없다.
func TestReqGate_AclEntryNameNoLongerAllowsHost(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{Entries: []accessEntry{entry("macmini")}}, nil)
	if got, _ := hostStatus(t, ts, "macmini"); got != http.StatusMisdirectedRequest {
		t.Fatalf("status=%d want 421 — hasHostname 편의 규칙이 남아 있다", got)
	}
}

// TC-RQG-13: `--allowed-host` 의 접미사 와일드카드는 **그대로 남는다.**
//
// 별명 칸이 와일드카드를 받지 않는 근거 중 하나가 "정말 필요한 배치의 입구는
// 이 경로로 남는다" 이므로(FR-ACL-29), 그 주장을 검증으로 남긴다.
func TestReqGate_AllowedHostWildcardStillWorks(t *testing.T) {
	ts := gateSrvWith(t, accessConfig{}, []string{"*.ts.net"})
	if got, _ := hostStatus(t, ts, "macmini-office.tail5da9ae.ts.net"); got == http.StatusMisdirectedRequest {
		t.Fatalf("status=%d — --allowed-host 접미사 경로가 깨졌다", got)
	}
}
