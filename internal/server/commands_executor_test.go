package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 실행자 지명 (WORKSPACE_IDENTITY_SRS FR-SXE-1/2/5).
//
// 브로드캐스트 페이로드에 execClientId 가 실려야 지명되지 않은 클라이언트가
// 생성 명령을 건너뛸 수 있다. 필드가 빠지면 모든 클라이언트가 각자 실행해
// PTY 를 중복 생성한다 (SRS §2.1).

// execSetup 은 실제 hub 를 쓰는 서버와, 페이로드를 가로챌 구독 하나를 만든다.
func execSetup(t *testing.T) (*Server, *httptest.Server, *cmdSub) {
	t.Helper()
	// 생성 명령은 echo 를 기다린다. 테스트에는 echo 하는 브라우저가 없으므로
	// 대기를 짧게 만든다 (NFR-RCR-1 의 env 훅).
	t.Setenv("DONGMINAL_CMD_RESULT_TIMEOUT_MS", "150")
	hub := NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	sub := hub.add()
	t.Cleanup(func() { hub.remove(sub) })
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
func nextPayload(t *testing.T, sub *cmdSub, wantAction string) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg := <-sub.ch:
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
		postCmd(t, ts, `{"action":"`+action+`","args":{"filePath":"/tmp/x","toolId":"1"}}`)
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

	for _, action := range []string{"focus", "closeTab", "tabNext", "renameTab", "detachTab"} {
		postCmd(t, ts, `{"action":"`+action+`","args":{"name":"n","toolId":"1"}}`)
		m := nextPayload(t, sub, action)
		if _, ok := m["execClientId"]; ok {
			t.Fatalf("action=%s 가 execClientId 를 실었다 — 전 클라이언트가 수행해야 한다", action)
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
