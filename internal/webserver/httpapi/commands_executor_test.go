package httpapi

import (
	"dongminal/internal/webserver/hub"

	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// 실행자 지명 (WORKSPACE_IDENTITY_SRS FR-SXE-1/2/5).
//
// 브로드캐스트 페이로드에 execClientId 가 실려야 지명되지 않은 클라이언트가
// 생성 명령을 건너뛸 수 있다. 필드가 빠지면 모든 클라이언트가 각자 실행해
// PTY 를 중복 생성한다 (SRS §2.1).

// execSetup 은 실제 cmdHub 를 쓰는 서버와, 페이로드를 가로챌 구독 하나를 만든다.
func execSetup(t *testing.T) (*Server, *httptest.Server, *hub.CmdSub) {
	t.Helper()
	// 생성 명령은 echo 를 기다린다. 테스트에는 echo 하는 브라우저가 없으므로
	// 대기를 짧게 만든다 (NFR-RCR-1 의 env 훅).
	t.Setenv("DONGMINAL_CMD_RESULT_TIMEOUT_MS", "150")
	cmdHub := hub.NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: cmdHub})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	sub := cmdHub.Add()
	t.Cleanup(func() { cmdHub.Remove(sub) })
	return srv, ts, sub
}

func postCmd(t *testing.T, ts *httptest.Server, body string) {
	t.Helper()
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, b)
	}
}

// nextPayload 는 구독이 받은 다음 페이로드를 파싱한다. window_focus 처럼
// 명령이 아닌 브로드캐스트는 건너뛴다.
func nextPayload(t *testing.T, sub *hub.CmdSub, wantAction string) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg := <-sub.Messages():
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				t.Fatalf("페이로드 파싱: %v (%s)", err, msg)
			}
			if m["action"] == wantAction {
				return m
			}
		case <-deadline:
			t.Fatalf("action=%s 페이로드가 오지 않았다", wantAction)
		}
	}
}

// TC-SXE-3: 단일 실행자 명령은 execClientId 를 싣는다.
func TestCommandPost_NamesExecutorForCreatingActions(t *testing.T) {
	srv, ts, sub := execSetup(t)
	srv.Focus.Attach("cliA")
	srv.Focus.Attach("cliB")
	srv.Focus.Claim("cliB", "W1")

	for _, action := range []string{"newTab", "newWindow", "splitH", "splitV", "openEditorTab", "restoreTool"} {
		postCmd(t, ts, `{"action":`+testpath.JSONQuote(action)+`,"args":{"filePath":"/tmp/x","toolId":"1"}}`)
		m := nextPayload(t, sub, action)
		if got, _ := m["execClientId"].(string); got != "cliB" {
			t.Fatalf("action=%s execClientId=%q want cliB", action, got)
		}
	}
}

// TC-SXE-4: 그 외 명령에는 필드를 넣지 않는다 — 각 클라이언트가 각자 수행해야 한다.
func TestCommandPost_NoExecutorForNonCreatingActions(t *testing.T) {
	srv, ts, sub := execSetup(t)
	srv.Focus.Attach("cliA")
	srv.Focus.Claim("cliA", "W1")

	// M11_SRS FR-M11-10 (M11-B9): **이 목록이 둘로 줄었다.**
	//
	//   이전: focus·closeTab·tabNext·detachTab 도 지명 없이 나갔다
	//   새로: 그 넷은 **시선을 옮기므로** 지명된다 — 지명이 없으면 붙어 있는
	//         브라우저 전부가 수행하고, 실측에서 `window-next` 하나가 두 브라우저를
	//         함께 옮겼다 (SRS §2.7)
	//   이유: 종전 근거였던 "나머지 변경은 클라이언트 간 idempotent 하다" 는 트리에만
	//         성립한다. 시선은 수렴하지 않는다
	//
	// 남는 것은 **순수 데이터 변경**뿐이다. 그 둘은 시선을 건드리지 않으며, 좁히면
	// 지명된 클라이언트가 없을 때 이름이 영영 안 바뀐다.
	for _, action := range []string{"renameTab", "renameWindow"} {
		postCmd(t, ts, `{"action":`+testpath.JSONQuote(action)+`,"args":{"name":"n","toolId":"1"}}`)
		m := nextPayload(t, sub, action)
		if _, ok := m["execClientId"]; ok {
			t.Fatalf("action=%s 가 execClientId 를 실었다 — 전 클라이언트가 수행해야 한다", action)
		}
	}
}

// V-M11-23 (M11_SRS FR-M11-10): 시선을 옮기는 명령은 **지명을 달고** 나간다.
// 위 검사와 짝이다 — 한쪽만 두면 목록이 어느 방향으로 어긋나도 잡히지 않는다.
func TestCommandPost_ExecutorForViewMovingActions(t *testing.T) {
	srv, ts, sub := execSetup(t)
	srv.Focus.Attach("cliA")
	srv.Focus.Claim("cliA", "W1")

	for _, action := range []string{"focus", "closeTab", "closeWindow", "detachTab",
		"windowNext", "windowPrev", "tabNext", "tabPrev",
		"paneUp", "paneDown", "paneLeft", "paneRight"} {
		postCmd(t, ts, `{"action":`+testpath.JSONQuote(action)+`,"args":{"name":"n","toolId":"1"}}`)
		m := nextPayload(t, sub, action)
		if got, _ := m["execClientId"].(string); got != "cliA" {
			t.Fatalf("action=%s 의 execClientId=%q want %q — 지명이 없으면 모든 브라우저가 화면을 옮긴다 (M11-B9)",
				action, got, "cliA")
		}
	}
}

// TC-SXE-5: live 구독이 없으면 지명하지 않는다 (게이팅 없음으로 열화).
func TestCommandPost_NoExecutorWhenNoLiveClient(t *testing.T) {
	_, ts, sub := execSetup(t)
	postCmd(t, ts, `{"action":"newTab","args":{}}`)
	m := nextPayload(t, sub, "newTab")
	if got, ok := m["execClientId"]; ok && got != "" {
		t.Fatalf("execClientId=%v want 없음 — clientId 를 안 보내는 구독자가 명령을 잃는다", got)
	}
}
