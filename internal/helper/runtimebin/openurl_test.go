package runtimebin

import (
	"bytes"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// V4: dmctl open-url — 서버가 "local" 이라 답할 때만 이 셸이 직접 연다
// (VIEWER_URL_OPEN_SRS FR-VUO-2/3).

// recordOpen 은 로컬 실행 대역이다. 무엇을 열려 했는지 기록한다.
func recordOpen(dst *string, err error) func(string) error {
	return func(u string) error { *dst = u; return err }
}

func TestOpenURL_SendsAction(t *testing.T) {
	var got map[string]any
	defer captureAPI(t, `{"ok":true,"where":"remote"}`, &got, nil, nil)()

	var opened string
	var stdout, stderr bytes.Buffer
	rc := openURLWith([]string{"https://example.com/a?b=1"}, &stdout, &stderr, recordOpen(&opened, nil))
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if got["action"] != "openUrl" {
		t.Fatalf("action=%v", got["action"])
	}
	args := got["args"].(map[string]any)
	if args["url"] != "https://example.com/a?b=1" {
		t.Fatalf("args=%+v", args)
	}
	if opened != "" {
		t.Fatalf("where=remote 인데 이 셸이 %q 를 열었다 — 두 곳에서 열린다", opened)
	}
}

func TestOpenURL_LocalWhereOpensHere(t *testing.T) {
	defer captureAPI(t, `{"ok":true,"where":"local"}`, nil, nil, nil)()

	var opened string
	var stdout, stderr bytes.Buffer
	rc := openURLWith([]string{"https://example.com/"}, &stdout, &stderr, recordOpen(&opened, nil))
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if opened != "https://example.com/" {
		t.Fatalf("opened=%q, 기대 https://example.com/", opened)
	}
}

// FR-VUO-4: 서버에 닿지 못해도 열기 요청은 소실되지 않는다.
func TestOpenURL_ServerUnreachableStillOpensHere(t *testing.T) {
	t.Setenv("DONGMINAL_PORT", "1") // 아무도 듣지 않는 포트
	t.Setenv("DONGMINAL_HOST", "127.0.0.1")

	var opened string
	var stdout, stderr bytes.Buffer
	rc := openURLWith([]string{"https://example.com/"}, &stdout, &stderr, recordOpen(&opened, nil))
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if opened != "https://example.com/" {
		t.Fatalf("opened=%q — 서버가 없으면 이 셸이 연다", opened)
	}
}

// 서버가 거절하면(400) 열지 않는다 — 거절은 "열어서는 안 되는 URL" 이라는 판정이다.
func TestOpenURL_ServerRejectDoesNotOpen(t *testing.T) {
	defer withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("openUrl: http/https 만 허용: file:///etc/passwd"))
	})()

	var opened string
	var stdout, stderr bytes.Buffer
	rc := openURLWith([]string{"file:///etc/passwd"}, &stdout, &stderr, recordOpen(&opened, nil))
	if rc == 0 {
		t.Fatal("rc=0 — 거절을 성공으로 보고했다")
	}
	if opened != "" {
		t.Fatalf("opened=%q — 서버가 거절한 URL 을 열었다", opened)
	}
	if !strings.Contains(stderr.String(), "http/https") {
		t.Fatalf("stderr=%q — 거절 사유가 보이지 않는다", stderr.String())
	}
}

// 로컬 실행 자체가 실패하면 사유를 알린다.
func TestOpenURL_LocalOpenFailureIsReported(t *testing.T) {
	defer captureAPI(t, `{"ok":true,"where":"local"}`, nil, nil, nil)()

	var opened string
	var stdout, stderr bytes.Buffer
	rc := openURLWith([]string{"https://example.com/"}, &stdout, &stderr,
		recordOpen(&opened, errors.New("브라우저 없음")))
	if rc == 0 {
		t.Fatal("rc=0 — 열지 못했는데 성공으로 보고했다")
	}
	if !strings.Contains(stderr.String(), "브라우저 없음") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestOpenURL_UsageErrors(t *testing.T) {
	for _, args := range [][]string{{}, {"a", "b"}} {
		var stdout, stderr bytes.Buffer
		if rc := openURLWith(args, &stdout, &stderr, recordOpen(new(string), nil)); rc == 0 {
			t.Errorf("args=%v rc=0 — 인자 오류를 통과시켰다", args)
		}
	}
}

// 헬퍼로 등록되어야 BROWSER 가 가리킬 실행 파일이 생긴다 (FR-VUO-12).
func TestOpenURL_RegisteredAsHelper(t *testing.T) {
	found := false
	for _, n := range HelperNames() {
		if n == "open-url" {
			found = true
		}
	}
	if !found {
		t.Fatalf("open-url 이 헬퍼 목록에 없다: %v", HelperNames())
	}
}

// 최상위 도움말이 이 명령을 말해야 사용자가 찾을 수 있다.
func TestOpenURL_ListedInDmctlHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runDmctl(nil, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "open-url") {
		t.Error("최상위 도움말에 open-url 없음")
	}
}

// dmctl 서브커맨드로도 닿아야 한다.
func TestOpenURL_ReachableAsDmctlSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc, handled := runDmctlSpecial("open-url", []string{"--help"}, &stdout, &stderr)
	if !handled {
		t.Fatal("dmctl open-url 이 디스패치되지 않는다")
	}
	if rc != 0 || stdout.Len() == 0 {
		t.Fatalf("rc=%d stdout=%q", rc, stdout.String())
	}
}
