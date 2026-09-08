package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// VIEWER_URL_OPEN_SRS 의 서버 몫 — 어디서 열지 정하고, 열어서는 안 될 URL 을 막는다.

// postOpenURL 은 응답 본문을 파싱해 돌려준다. 상태 코드도 함께 낸다.
func postOpenURL(t *testing.T, url string, body string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Post(url+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m
}

// V3: 원격 뷰어면 지명해 브로드캐스트한다 (FR-VUO-3).
func TestOpenURL_RemoteViewerIsNamedAndBroadcast(t *testing.T) {
	srv, ts, sub := execSetup(t)
	srv.Focus.AttachFrom("cliA", "100.64.0.5:40000")
	srv.Focus.Claim("cliA", "W1")

	code, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://example.com/x"}}`)
	if code != 200 {
		t.Fatalf("status=%d", code)
	}
	if resp["where"] != "remote" {
		t.Fatalf("where=%v, 기대 remote", resp["where"])
	}
	m := nextPayload(t, sub, "openUrl")
	if got, _ := m["execClientId"].(string); got != "cliA" {
		t.Fatalf("execClientId=%q, 기대 cliA", got)
	}
	args, _ := m["args"].(map[string]any)
	if args["url"] != "https://example.com/x" {
		t.Fatalf("args.url=%v — 서버는 URL 을 원본 그대로 싣는다 (FR-VUO-17)", args["url"])
	}
}

// V3: 로컬 뷰어면 브로드캐스트하지 않는다. 브라우저를 거치면 팝업 차단에 걸리고,
// 서버 머신에서 여는 것과 결과가 같으므로 부를 이유도 없다 (FR-VUO-2).
func TestOpenURL_LocalViewerIsNotBroadcast(t *testing.T) {
	srv, ts, _ := execSetup(t)
	srv.Focus.AttachFrom("cliA", "127.0.0.1:40001")
	srv.Focus.Claim("cliA", "W1")

	code, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"http://localhost:3000"}}`)
	if code != 200 {
		t.Fatalf("status=%d", code)
	}
	if resp["where"] != "local" {
		t.Fatalf("where=%v, 기대 local", resp["where"])
	}
	if d, _ := resp["delivered"].(float64); d != 0 {
		t.Fatalf("delivered=%v — 로컬 경로는 브로드캐스트하지 않는다", resp["delivered"])
	}
}

// IPv6 loopback 도 같은 컴퓨터다.
func TestOpenURL_IPv6LoopbackIsLocal(t *testing.T) {
	srv, ts, _ := execSetup(t)
	srv.Focus.AttachFrom("cliA", "[::1]:40002")
	srv.Focus.Claim("cliA", "W1")

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "local" {
		t.Fatalf("where=%v, 기대 local", resp["where"])
	}
}

// V3: 구독이 없으면 로컬로 취급한다 — 열기 요청을 버리지 않는다 (FR-VUO-4).
func TestOpenURL_NoSubscriberFallsBackToLocal(t *testing.T) {
	_, ts, _ := execSetup(t)
	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "local" {
		t.Fatalf("where=%v, 기대 local", resp["where"])
	}
}

// 주소를 모르는 구독(Attach)은 원격으로 취급한다 — 확인을 한 번 더 묻는 쪽이 안전하다.
func TestOpenURL_UnknownAddrIsRemote(t *testing.T) {
	srv, ts, _ := execSetup(t)
	srv.Focus.Attach("cliA")
	srv.Focus.Claim("cliA", "W1")

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "remote" {
		t.Fatalf("where=%v, 기대 remote", resp["where"])
	}
}

// V5: http·https 가 아닌 scheme 은 뷰어에 싣지 않는다 (FR-VUO-18).
func TestOpenURL_RejectsNonHTTPScheme(t *testing.T) {
	srv, ts, _ := execSetup(t)
	srv.Focus.AttachFrom("cliA", "100.64.0.5:40003")

	for _, u := range []string{
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/html,<script>1</script>",
		"ftp://example.com",
		"not a url",
		"",
	} {
		body, _ := json.Marshal(map[string]any{
			"action": "openUrl", "args": map[string]any{"url": u},
		})
		code, _ := postOpenURL(t, ts.URL, string(body))
		if code != http.StatusBadRequest {
			t.Errorf("url=%q status=%d, 기대 400", u, code)
		}
	}
}

// V6: 환경변수가 판정을 강제한다 — 터널 오판의 탈출구다 (FR-VUO-6).
func TestOpenURL_EnvForcesViewer(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "viewer")
	srv, ts, sub := execSetup(t)
	srv.Focus.AttachFrom("cliA", "127.0.0.1:40004") // loopback 이지만 강제로 뷰어
	srv.Focus.Claim("cliA", "W1")

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "remote" {
		t.Fatalf("where=%v, 기대 remote", resp["where"])
	}
	nextPayload(t, sub, "openUrl")
}

func TestOpenURL_EnvForcesLocal(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "local")
	srv, ts, _ := execSetup(t)
	srv.Focus.AttachFrom("cliA", "100.64.0.5:40005") // 원격이지만 강제로 로컬
	srv.Focus.Claim("cliA", "W1")

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "local" {
		t.Fatalf("where=%v, 기대 local", resp["where"])
	}
}

// viewer 강제인데 뷰어가 없으면 열 곳이 없다 — 로컬로 떨어진다 (FR-VUO-4 우선).
func TestOpenURL_EnvViewerWithNoSubscriberStillLocal(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "viewer")
	_, ts, _ := execSetup(t)
	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://x.dev"}}`)
	if resp["where"] != "local" {
		t.Fatalf("where=%v, 기대 local", resp["where"])
	}
}

// 진단 종단 (FR-VUO-19). 사용자가 자기 환경이 R1 의 오판 상태인지 볼 유일한
// 수단이다 — 판정을 실행에서 떼어 놓지 않으면 "지금 열면 어디서 열리는가" 를
// 물을 방법이 없다.
func TestOpenURLWhere_Diagnostic(t *testing.T) {
	srv, ts, sub := execSetup(t)
	srv.Focus.AttachFrom("cliA", "100.64.0.5:41000")
	srv.Focus.Claim("cliA", "W1")

	resp, err := http.Get(ts.URL + "/api/open-url/where")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if m["where"] != "remote" {
		t.Fatalf("where=%v", m["where"])
	}
	if m["viewer"] != "cliA" {
		t.Fatalf("viewer=%v", m["viewer"])
	}
	// 오판의 이유는 주소다. 그것을 보이지 않으면 진단이 되지 않는다.
	if m["viewerAddr"] != "100.64.0.5:41000" {
		t.Fatalf("viewerAddr=%v", m["viewerAddr"])
	}
	if n, _ := m["subscribers"].(float64); n != 1 {
		t.Fatalf("subscribers=%v", m["subscribers"])
	}
	// 진단은 부작용이 없어야 한다 — 조회만으로 창이 열리면 진단이 아니다.
	select {
	case msg := <-sub.Messages():
		t.Fatalf("진단이 브로드캐스트를 냈다: %s", msg)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestOpenURLWhere_ReportsForcedMode(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "viewer")
	srv, ts, _ := execSetup(t)
	srv.Focus.AttachFrom("cliA", "127.0.0.1:41001")

	resp, err := http.Get(ts.URL + "/api/open-url/where")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	if m["where"] != "remote" {
		t.Fatalf("where=%v — 강제가 반영되지 않았다", m["where"])
	}
	// 강제 중이라는 사실 자체가 진단의 절반이다. 자동 판정과 구별되어야 한다.
	if m["forced"] != "viewer" {
		t.Fatalf("forced=%v, 기대 viewer", m["forced"])
	}
}

func TestOpenURLWhere_NoViewer(t *testing.T) {
	_, ts, _ := execSetup(t)
	resp, err := http.Get(ts.URL + "/api/open-url/where")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	if m["where"] != "local" {
		t.Fatalf("where=%v", m["where"])
	}
	if n, _ := m["subscribers"].(float64); n != 0 {
		t.Fatalf("subscribers=%v", m["subscribers"])
	}
}
