package httpapi

import (
	"net/http"
	"testing"
	"time"
)

// VIEWER_URL_OPEN_SRS R1 — 터널 뒤의 뷰어를 로컬로 오판하는 알려진 한계.
//
// 아래 테스트들은 두 가지를 한다.
//
//  1. **배선을 잰다.** 판정의 근거는 SSE 요청의 r.RemoteAddr 이고, 그 값이
//     Focus 까지 실제로 흘러가야 한다 (commands.go 의 AttachFrom). 다른
//     테스트들은 AttachFrom 을 직접 부르므로 그 배선이 끊겨도 전부 통과한다.
//  2. **한계를 기록한다.** 오판은 결함이 아니라 정보 부족의 결과다 — 어느
//     계층에도 "누가 이 화면을 보고 있는가" 가 없다. 이 테스트가 실패한다면
//     누군가 판정 규칙을 바꾼 것이므로, 그 변경이 의도된 것인지 이 주석과
//     함께 판단해야 한다.

// 배선 검증: 실제 HTTP 요청의 원격 주소가 판정에 쓰인다.
//
// 이것이 없으면 commands.go 의 AttachFrom 을 Attach 로 되돌려도 아무 테스트도
// 울지 않는다 — 그러면 모든 뷰어가 "주소 모름"이 되어 항상 원격으로 판정된다.
func TestOpenURL_SSERemoteAddrReachesFocus(t *testing.T) {
	srv, ts, _ := execSetup(t)
	defer openSSE(t, ts, "cliA").Body.Close()

	cid, addr := srv.Focus.ExecutorAddr()
	if cid != "cliA" {
		t.Fatalf("뷰어=%q, 기대 cliA", cid)
	}
	if addr == "" {
		t.Fatal("구독의 원격 주소가 기록되지 않았다 — SSE 핸들러가 주소를 넘기지 않는다")
	}
	if !isLoopbackAddr(addr) {
		t.Fatalf("주소=%q — httptest 는 loopback 이어야 한다", addr)
	}
}

// R1 특성화: 같은 컴퓨터에서 온 것처럼 보이는 구독은 로컬로 판정된다.
//
// `ssh -L` 로 붙은 원격 사용자의 구독이 정확히 이 모양으로 도착한다. TCP 연결을
// 여는 주체가 서버 머신의 sshd 이기 때문이다. 그 사용자는 확인 팝업을 받지
// 못하고, 창은 서버 머신에서 열린다 — 오류 없이.
func TestOpenURL_TunneledViewerIsMisjudgedAsLocal(t *testing.T) {
	_, ts, sub := execSetup(t)
	defer openSSE(t, ts, "cliA").Body.Close()

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://claude.ai/login"}}`)
	if resp["where"] != "local" {
		t.Fatalf("where=%v — 이 테스트는 오판을 기록한다. remote 가 나왔다면 판정 규칙이 "+
			"바뀐 것이므로 SRS R1 과 DONGMINAL_URL_OPEN 의 존재 이유를 다시 봐야 한다", resp["where"])
	}
	// 뷰어에게 아무것도 가지 않는다 — 이것이 사용자가 보는 증상의 원인이다.
	select {
	case msg := <-sub.Messages():
		t.Fatalf("로컬 판정인데 브로드캐스트가 나갔다: %s", msg)
	case <-time.After(200 * time.Millisecond):
	}
}

// 탈출구: 같은 구독, 같은 요청. 환경변수 하나가 오판을 덮는다 (FR-VUO-6).
func TestOpenURL_EnvViewerRescuesTunneledViewer(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "viewer")
	_, ts, sub := execSetup(t)
	defer openSSE(t, ts, "cliA").Body.Close()

	_, resp := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"https://claude.ai/login"}}`)
	if resp["where"] != "remote" {
		t.Fatalf("where=%v, 기대 remote — 탈출구가 듣지 않는다", resp["where"])
	}
	m := nextPayload(t, sub, "openUrl")
	if got, _ := m["execClientId"].(string); got != "cliA" {
		t.Fatalf("execClientId=%q, 기대 cliA — 구제된 경로에서도 한 곳만 열어야 한다", got)
	}
	args, _ := m["args"].(map[string]any)
	if args["url"] != "https://claude.ai/login" {
		t.Fatalf("args=%+v", args)
	}
}

// 탈출구는 판정만 덮는다 — 열어서는 안 되는 URL 은 그대로 막힌다.
func TestOpenURL_EnvViewerStillRejectsBadScheme(t *testing.T) {
	t.Setenv("DONGMINAL_URL_OPEN", "viewer")
	_, ts, _ := execSetup(t)
	defer openSSE(t, ts, "cliA").Body.Close()

	code, _ := postOpenURL(t, ts.URL, `{"action":"openUrl","args":{"url":"file:///etc/passwd"}}`)
	if code != http.StatusBadRequest {
		t.Fatalf("status=%d, 기대 400", code)
	}
}
